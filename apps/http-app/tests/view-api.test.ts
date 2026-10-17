import { RPC_VERSION } from '@itookit/app-transport/rpc';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLocalFSBackend, type LocalFSBackend } from '@itookit/vfsdriver-local';
import { createApplicationApi } from '@itookit/node-host/http';
import { createCertificates } from '@itookit/node-host/http';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { HttpViewClient, SnapshotCache, ViewExpiredError } from '@itookit/app-transport/http';
import { authenticatedFetch, close, secureServers } from './tls-fixture';

let certificateRoot: string, certificates: string, directory: string, backend: LocalFSBackend;
let api: Awaited<ReturnType<typeof createApplicationApi>>, server: Awaited<ReturnType<typeof secureServers>>, auth: Awaited<ReturnType<typeof authenticatedFetch>>;
const clients: HttpViewClient[] = [];
const auditEvents: import('@itookit/node-host/logging').AuditEvent[] = [];
beforeAll(async () => { certificateRoot = await mkdtemp(path.join(tmpdir(), 'mindos-view-certs-')); certificates = path.join(certificateRoot, 'certs'); await createCertificates(certificates, ['127.0.0.1']); });
afterAll(async () => { await rm(certificateRoot, { recursive: true, force: true }); });
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mindos-view-'));
    const root = path.join(directory, 'data'), ui = path.join(directory, 'ui'); await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<title>MindOS</title>');
    backend = await openLocalFSBackend({ rootDir: root, sidecarDir: path.join(directory, 'meta'), createDb: NodeSqliteSidecarDb.open });
    auditEvents.length = 0;
    api = await createApplicationApi(backend, root, { write: event => auditEvents.push(event), close: async () => {} }); server = await secureServers(backend, root, ui, certificates, api); auth = await authenticatedFetch(certificates);
});
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); await api.close(); auth.close(); await close(server.server); await backend.close(); await rm(directory, { recursive: true, force: true }); });
async function client(id: string) { const peer = new HttpViewClient(id, server.origin + '/api/application', auth.fetcher); clients.push(peer); return peer.start(); }
it('uses one authenticated application transport for user files and backend commands', async () => {
    const root = await client('reader'), fs = await root.services.vfs.openFileSystem('/home/admin/minds');
    const file = await fs.driver.createFile({ name: 'http.md', parentPath: '/' }); await fs.driver.writeContent(file.path, '# HTTP');
    expect(await fs.driver.readContent(file.path, { encoding: 'utf-8' })).toBe('# HTTP');
    expect(await root.services.digitalTwin!.snapshot()).toHaveProperty('settings');
    expect(root.flowLibrary.length).toBeGreaterThan(0);
    expect((await auth.fetcher(server.origin + '/api/vfs', { method: 'POST', body: '{}' })).status).toBe(403);
});
it('keeps browser bindings separate while both views share the same persisted backend', async () => {
    const first = await client('one'), second = await client('two');
    const id1 = await first.services.projects.sessions.create('First', null), id2 = await second.services.projects.sessions.create('Second', null);
    await first.services.commandBus.execute('session.bind', { sessionId: id1 });
    await second.services.commandBus.execute('session.bind', { sessionId: id2 });
    expect(first.services.sessionManager.getSnapshot().sessionId).toBe(id1);
    expect(second.services.sessionManager.getSnapshot().sessionId).toBe(id2);
    expect(await second.services.sessionRepository.getManifest(id1)).toHaveProperty('title', 'First');
});

it('opens independent cold views in one call and replays changes between the baseline and observation registration', async () => {
    const a = await client('opened-one'), b = await client('opened-two');
    const one = await a.services.projects.sessions.create('First view', null), two = await b.services.projects.sessions.create('Second view', null);
    const options = (id: string) => ({documents: ['theme'], taskAttachmentKey: 'ui.privileged.active-task',
        workbench: {initialSessionId: id, chatControls: true, initialNavigation: false}});
    const [first, second] = await Promise.all([a.backend.openView(options(one)), b.backend.openView(options(two))]);
    expect(first.initial?.snapshot.sessionId).toBe(one); expect(second.initial?.snapshot.sessionId).toBe(two);
    await b.services.projects.sessions.rename(one, 'Changed before observation');
    const events: import('@itookit/app-contracts/services').ApplicationViewEvent[] = [];
    const stop = await first.observation.observeView(first.cursor, event => events.push(event));
    await vi.waitFor(() => expect(events.some(event => event.topic === 'repository' && event.value?.sessionId === one)).toBe(true));
    expect(events[0].sequence).toBe(first.cursor + 1);
    expect(a.services.sessionManager.getSnapshot().sessionId).toBe(one);
    stop(); await first.dispose();
    expect(b.services.sessionManager.getSnapshot().sessionId).toBe(two);
    await b.services.projects.sessions.rename(two, 'Second still usable'); await second.dispose();
});
it('opens, activates and observes in one handshake, reuses cached DTOs across clients and preserves independent bindings', async () => {
    const seed = await client('handshake-seed'), a = await seed.services.projects.sessions.create('One', null), b = await seed.services.projects.sessions.create('Two', null);
    let saved: string | null = null;
    const storage = {read: () => saved, write: (value: string) => {saved = value;}};
    const posts: string[] = [], sizes: number[] = [];
    const fetcher: typeof fetch = async (url, init) => {
        const request = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
        if (request) posts.push(request.kind);
        const response = await auth.fetcher(url, init);
        if (request?.kind === 'bootstrap') sizes.push((await response.clone().arrayBuffer()).byteLength);
        return response;
    };
    const open = async (name: string, id: string) => {
        const http = new HttpViewClient(name, server.origin + '/api/application', fetcher); clients.push(http);
        return http.start({snapshots: new SnapshotCache(storage), initialView: {documents: ['theme'], taskAttachmentKey: 'ui.privileged.active-task',
            workbench: {initialSessionId: id, initialNavigation: false, chatControls: true}}});
    };
    const first = await open('handshake-one', a), second = await open('handshake-two', b);
    expect(posts).toEqual(['bootstrap', 'bootstrap']);
    expect(first.initialView?.initial?.snapshot.sessionId).toBe(a); expect(second.initialView?.initial?.snapshot.sessionId).toBe(b);
    expect(sizes[1]).toBeLessThan(sizes[0] * 0.7);
    const received = vi.fn(), stop = await first.initialView!.observation.observeView(first.initialView!.cursor, received);
    await seed.services.projects.sessions.rename(a, 'Changed after handshake');
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(expect.objectContaining({topic: 'repository', value: expect.objectContaining({sessionId: a})})));
    stop(); await first.initialView!.dispose();
    expect(await first.backend.readUiDocuments(['theme'])).toBeTypeOf('object');
    expect(second.services.sessionManager.getSnapshot().sessionId).toBe(b);
    console.log('[Handshake cache bytes]', {cold: sizes[0], warm: sizes[1], openingPosts: posts.slice(0, 2)});
});
it('uses backend draft creation and navigation projections across browsers with an awaited refresh barrier', async () => {
    const first = await client('draft-writer'), second = await client('navigation-reader');
    const project = await first.services.projects.create('Shared project');
    const id = await first.backend.createSessionDraft({ title: 'Quoted document', inputText: 'Keep the original draft', source: { projectFolder: project.path } });
    expect((await second.services.sessionRepository.getUIState(id))?.branchDrafts?.main?.inputText).toBe('Keep the original draft');
    const navigation = await second.services.projects.navigation({ path: '/' + id });
    expect(navigation.project?.project.id).toBe(project.project.id); expect(navigation.loadPaths).toHaveLength(1);
    expect((second.services as any).acquireConversation).toBeUndefined();
    const view = await second.backend.workbenchView({ initialNavigation: false });
    try {
        const refreshed = view.browser.invalidateNavigation(); expect(refreshed).toBeInstanceOf(Promise); await refreshed;
        expect((await view.browser.fs.driver.getChildren(navigation.loadPaths[0])).map(row => row.metadata.title)).toContain('Quoted document');
        expect((await second.backend.sessionTasks(id)).items).toEqual([]);
    } finally { await view.browser.dispose(); }
});
it('repairs a missing cached DTO by reading the prepared handshake without reopening the Session', async () => {
    const source = await client('repair-source'), id = await source.services.projects.sessions.create('Repair target', null);
    const posts: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
        const request = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
        if (request) posts.push(request.kind);
        const response = await auth.fetcher(url, init);
        if (request?.kind !== 'bootstrap') return response;
        const packet = await response.json(); delete packet.cache[Object.keys(packet.cache)[0]];
        return Response.json(packet);
    };
    const http = new HttpViewClient('repair', server.origin + '/api/application', fetcher); clients.push(http);
    const root = await http.start({initialView: {documents: [], workbench: {initialSessionId: id, initialNavigation: false}}});
    expect(root.initialView?.initial?.snapshot.sessionId).toBe(id);
    expect(posts).toEqual(['bootstrap', 'bootstrap-data']);
    expect(root.services.sessionManager.getSnapshot().sessionId).toBe(id);
});
it('rejects incompatible protocols, forged capabilities and cross-origin commands', async () => {
    const post = (body: object, headers: object = {}) => auth.fetcher(server.origin + '/api/application', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await post({ kind: 'bootstrap', clientId: 'bad', version: 999 })).status).toBe(400);
    expect((await post({ kind: 'bootstrap', clientId: 'old', version: 2 })).status).toBe(400);
    expect((await post({ kind: 'bootstrap', clientId: 'bad', version: RPC_VERSION }, { Origin: 'https://evil.example' })).status).toBe(403);
    const result = await post({ kind: 'call', clientId: 'bad', version: RPC_VERSION, call: { target: 'server:99999', method: 'execute', args: [] } });
    expect(await result.json()).toHaveProperty('error.code', 'ECAPABILITY');
});
it('batches parallel queries and subscription bindings without batching business commands', async () => {
    const requests: Array<{ kind: string; calls?: unknown[] }> = [];
    const fetcher: typeof fetch = async (input, init) => {
        if (typeof init?.body === 'string') requests.push(JSON.parse(init.body));
        return auth.fetcher(input, init);
    };
    const peer = new HttpViewClient('batched', server.origin + '/api/application', fetcher); clients.push(peer);
    const root = await peer.start(); requests.length = 0;
    await Promise.all([root.services.projects.list(), root.services.digitalTwin!.getSettings()]);
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ kind: 'queries', calls: expect.any(Array) });
    expect(requests[0].calls).toHaveLength(2);
    const unsubscribe = [root.services.agentService.onChange(() => {}), root.services.projects.subscribeChanges(() => {})];
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests.filter(request => request.kind === 'bindings')).toHaveLength(1);
    unsubscribe.forEach(release => release());
    const ref = await peer.peer.expose(root.services.commandBus) as { $ref: string };
    const rejected = await auth.fetcher(server.origin + '/api/application', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'queries', clientId: 'batched', version: RPC_VERSION, calls: [{ target: ref.$ref, method: 'execute', args: ['session.bind', {}] }] }) });
    expect(rejected.status).toBe(400);
});
it('transfers raw file bytes through view-scoped handles and retains write authorization', async () => {
    const requests: Array<{ url: string; bodyBytes?: number }> = [];
    const fetcher: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), bodyBytes: init?.body instanceof ArrayBuffer ? init.body.byteLength : undefined });
        return auth.fetcher(input, init);
    };
    const peer = new HttpViewClient('binary', server.origin + '/api/application', fetcher); clients.push(peer);
    const root = await peer.start(), fs = await root.services.vfs.openFileSystem('/home/admin/minds');
    const node = await fs.driver.createFile({ name: '字节.bin', parentPath: '/' }); requests.length = 0;
    const bytes = new Uint8Array(256 * 1024); bytes[0] = 128; bytes[bytes.length - 1] = 255;
    const written = vi.fn(), read = vi.fn();
    await fs.driver.writeContent(node.path, bytes.buffer, { onRevision: written }); expect(written).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await fs.driver.readContent(node.path, { encoding: 'binary', onRevision: read }))).toEqual(bytes);
    expect(read).toHaveBeenCalledTimes(1);
    expect(requests.filter(request => request.url.includes('/files?')).map(request => request.bodyBytes)).toEqual([bytes.byteLength, undefined]);
    await expect(fs.driver.writeContent(node.path, bytes.buffer, { expectedVersion: (await fs.driver.getNode(node.path))!.version + 1 })).rejects.toMatchObject({ code: 'ECONFLICT' });
    const etc = await root.services.vfs.openFileSystem('/etc');
    await expect(etc.driver.writeContent('/llm/providers.seq', bytes.buffer)).rejects.toThrow();
    const ref = await peer.peer.expose(fs.driver) as { $ref: string };
    const wrongView = await auth.fetcher(server.origin + `/api/application/files?clientId=other&version=${RPC_VERSION}`, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-View-Call': encodeURIComponent(JSON.stringify({ target: ref.$ref, method: 'readContent', args: [node.path] })) } });
    expect(wrongView.status).toBe(400);
});
it('updates another browser configuration cache after a backend change without requiring a local subscription', async () => {
    const first = await client('writer'), second = await client('observer');
    await first.services.agentService.saveProvider({ id: 'shared', name: 'Shared', implementation: 'openai-compatible', baseURL: 'https://example.test', models: [] });
    await vi.waitFor(() => expect(second.services.agentService.getProvider('shared')?.name).toBe('Shared'));
});

it.each(['queries', 'file'])('marks an expired %s view without creating a replacement or executing its operation', async kind => {
    const root = await client('expired'), fs = await root.services.vfs.openFileSystem('/home/admin/minds');
    const peer = clients.at(-1)!, ref = await peer.peer.expose(fs.driver) as { $ref: string };
    const closeResponse = await auth.fetcher(server.origin + '/api/application', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'close', clientId: 'expired', version: RPC_VERSION }) });
    expect(closeResponse.status).toBe(200);
    const response = kind === 'file'
        ? await auth.fetcher(server.origin + `/api/application/files?clientId=expired&version=${RPC_VERSION}`, { method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-View-Call': encodeURIComponent(JSON.stringify({ target: ref.$ref, method: 'readContent', args: ['/missing'] })) } })
        : await auth.fetcher(server.origin + '/api/application', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'queries', clientId: 'expired', version: RPC_VERSION, calls: [{ target: ref.$ref, method: 'getNode', args: ['/'] }] }) });
    expect(response.status).toBe(400); expect(response.headers.get('X-MindOS-View-Expired')).toBe('1');
    expect(await response.json()).toHaveProperty('error.code', 'ECAPABILITY');
});

it('records registered RPC names and batch size without recording UI document content or names', async () => {
    const root = await client('diagnostic');
    await root.backend.writeUiDocuments({ 'private-document-name': { secret: 'private-document-content' } });
    await root.backend.readUiDocuments(['private-document-name']);
    const writes = auditEvents.filter(event => event.rpcOperations?.includes('ApplicationBackend.writeUiDocuments'));
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ rpcKind: 'call', rpcBatchSize: 1 });
    await vi.waitFor(() => expect(server.events.find(event => event.requestId === writes[0].requestId)).toMatchObject({
        bodyReadMs: expect.any(Number), viewReadyMs: expect.any(Number), rpcMs: expect.any(Number), responseFlushMs: expect.any(Number),
    }));
    expect(JSON.stringify(auditEvents)).not.toContain('private-document');
    await Promise.all([root.services.projects.list(), root.services.digitalTwin!.getSettings()]);
    expect(auditEvents).toContainEqual(expect.objectContaining({ rpcKind: 'queries', rpcBatchSize: 2,
        rpcOperations: ['ProjectService.list', 'DigitalTwinService.getSettings'] }));
});

it('resumes the same view and replays missed configuration updates and callbacks once', async () => {
    let online = true, disconnect!: () => void;
    const requests: string[] = [], restored = vi.fn(), disconnected = vi.fn(), changed = vi.fn();
    const fetcher: typeof fetch = async (input, init) => {
        requests.push(init?.body ? JSON.parse(String(init.body)).kind : String(input));
        if (!online) throw new TypeError('Offline');
        const response = await auth.fetcher(input, init);
        if (!String(input).includes('/events?')) return response;
        const pipe = new TransformStream<Uint8Array>(), abort = new AbortController(); disconnect = () => abort.abort();
        void response.body!.pipeTo(pipe.writable, {signal: abort.signal}).catch(() => {});
        return new Response(pipe.readable, {headers: response.headers});
    };
    const peer = new HttpViewClient('resume', server.origin + '/api/application', fetcher, disconnected, undefined, restored); clients.push(peer);
    const first = await peer.start(), writer = await client('resume-writer');
    const stop = first.services.agentService.onChange(changed);
    await vi.waitFor(() => expect(requests).toContain('bindings'));
    online = false; disconnect();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
    await writer.services.agentService.saveProvider({id: 'missed', name: 'During interruption', implementation: 'openai-compatible', baseURL: 'https://example.test', models: []});
    await new Promise(resolve => setTimeout(resolve, 40));
    online = true; peer.retryConnection();
    await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(first.services.agentService.getProvider('missed')?.name).toBe('During interruption'));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(requests.filter(request => request === 'bootstrap')).toHaveLength(1);
    expect(requests.some(request => request.includes('&after='))).toBe(true); stop();
});

it('stops old-handle requests after the view expires, including binary file requests', async () => {
    const fetcher = vi.fn(auth.fetcher), disconnected = vi.fn();
    const peer = new HttpViewClient('lost-view', server.origin + '/api/application', fetcher, disconnected); clients.push(peer);
    const root = await peer.start(), fs = await root.services.vfs.openFileSystem('/home/admin/minds');
    await auth.fetcher(server.origin + '/api/application', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({kind: 'close', clientId: 'lost-view', version: RPC_VERSION})});
    await vi.waitFor(() => expect(disconnected.mock.calls.some(([error]) => error instanceof ViewExpiredError)).toBe(true));
    const count = fetcher.mock.calls.length;
    await expect(root.services.projects.list()).rejects.toMatchObject({code: 'ECAPABILITY'});
    await expect(fs.driver.readContent('/missing', {encoding: 'binary'})).rejects.toMatchObject({code: 'ECAPABILITY'});
    await expect(root.services.projects.sessions.create('Never sent', null)).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(fetcher).toHaveBeenCalledTimes(count);
    const response = await auth.fetcher(server.origin + `/api/application/events?clientId=lost-view&after=0&version=${RPC_VERSION}`);
    expect(response.status).toBe(400); expect(response.headers.get('X-MindOS-View-Expired')).toBe('1');
});

it('does not replay a command whose response was lost even after reconnecting successfully', async () => {
    let loseResponse = false, writes = 0;
    const restored = vi.fn(), fetcher: typeof fetch = async (input, init) => {
        const response = await auth.fetcher(input, init);
        if (loseResponse && init?.body && JSON.parse(String(init.body)).kind === 'call') {
            writes++; loseResponse = false; await response.body?.cancel(); throw new TypeError('Response lost');
        }
        return response;
    };
    const peer = new HttpViewClient('unknown-outcome', server.origin + '/api/application', fetcher, () => {}, undefined, restored); clients.push(peer);
    const root = await peer.start(); loseResponse = true;
    await expect(root.services.projects.sessions.create('Create only once', null)).rejects.toThrow('Response lost');
    await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce());
    expect(writes).toBe(1);
    const {sessions} = await root.services.projects.sessions.navigation();
    expect(sessions.filter(session => session.title === 'Create only once')).toHaveLength(1);
});
