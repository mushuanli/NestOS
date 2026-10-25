import {createHash} from 'node:crypto';
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
import {ArtifactCommand, type ExecutionArtifactPage, type ExecutionArtifactChunk, FlowLibraryCommand, InputAssetCommand} from '@itookit/app-contracts';
import { FlowCommand, type FlowDraft, type FlowRevision, type DurableFlowSnapshot, validFlowImages } from '@itookit/llm-flow/contracts';
type SessionInstructionQueue = NonNullable<import('@itookit/app-contracts/services').SessionEditorInitialData['snapshot']['instructionQueue']>;

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
it('shares purpose defaults between HTTP settings and toolbox and rejects incompatible models', async () => {
    const root = await client('model-defaults'), service = root.services.agentService;
    await service.saveProvider({ id: 'defaults-test', name: 'Defaults', implementation: 'openai-compatible', apiKey: 'private-key', baseURL: 'https://example.test',
        models: [{ id: 'image', name: 'Image', category: 'image', operations: { 'image.generate': {
            inputModalities: ['text'], outputModalities: ['image'], formats: ['png'],
        } } }], media: { 'image.generate': { adapter: 'openai-images' } } });
    await service.saveConnection({ id: 'defaults-image', name: 'Image', providerId: 'defaults-test', tiers: { optimal: 'image' } });
    await root.services.llmDriver.setModelDefault('image.generate', 'defaults-image');
    expect(await service.getModelDefaults()).toEqual({ 'image.generate': 'defaults-image' });
    const view = await root.backend.toolboxView();
    try {
        expect(view.inventory.modelDefaults).toEqual({ 'image.generate': 'defaults-image' });
        expect(view.inventory.connections.get('defaults-image')?.operationModels).toEqual({ 'image.generate': 'Image' });
        expect(JSON.stringify([...view.inventory.connections])).not.toContain('private-key');
        await expect(service.setModelDefault('chat', 'defaults-image')).rejects.toMatchObject({ code: 'MODEL_DEFAULT_CAPABILITY' });
        await view.resources.setModelDefault('image.generate', null);
        expect(await root.services.llmDriver.getModelDefaults()).toEqual({});
    } finally { await view.dispose(); }
});
it('transports durable instruction queue edits and rejects stale client versions', async () => {
    const root = await client('instruction-queue');
    const id = await root.services.projects.sessions.create('Queued HTTP session', null);
    const commands = root.services.commandBus;
    await commands.execute('session.bind', { sessionId: id });
    await commands.execute('session.instructions.edit', { action: 'pause', expectedRevision: 0 });
    const a = await commands.execute('session.send', { text: 'first queued', files: [], agentId: 'default' });
    const b = await commands.execute('session.send', { text: 'second queued', files: [], agentId: 'default' });
    let queue = await commands.execute<SessionInstructionQueue>('session.instructions.get');
    expect(queue.items.map(item => item.text)).toEqual(['first queued', 'second queued']);
    expect(queue).not.toHaveProperty('accepted');
    await expect(commands.execute('session.instructions.edit', { action: 'remove', id: a, expectedRevision: 0 })).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
    queue = await commands.execute<SessionInstructionQueue>('session.instructions.edit', { action: 'reorder', ids: [b, a], expectedRevision: queue.revision });
    queue = await commands.execute<SessionInstructionQueue>('session.instructions.edit', { action: 'merge', ids: [a, b], expectedRevision: queue.revision });
    expect(queue.items).toHaveLength(1); expect(queue.items[0].text).toBe('second queued\n\nfirst queued');
    await commands.execute('session.instructions.edit', { action: 'remove', id: b, expectedRevision: queue.revision });
    await vi.waitFor(() => expect(root.services.sessionManager.getSnapshot().instructionQueue?.items).toEqual([]));
});
it('keeps staged image references valid across the authenticated command transport', async () => {
    const root = await client('image-upload');
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO9sAAAAASUVORK5CYII=';
    const asset = await root.services.commandBus.execute(InputAssetCommand.Import, {url});
    expect(validFlowImages([{type: 'image', source: {type: 'asset', asset}}], {mimeTypes: ['image/png']})).toBe(true);
    expect(await root.services.commandBus.execute(InputAssetCommand.Read, {reference: asset})).toBe(url);
    expect(auditEvents).toContainEqual(expect.objectContaining({event: 'application.complete', rpcCommands: [InputAssetCommand.Import],
        rpcErrorCount: 0, uploads: [{mimeType: 'image/png', bytes: (asset as {bytes: number}).bytes}]}));
    await expect(root.services.commandBus.execute(InputAssetCommand.Import, {url: 'data:image/svg+xml;base64,AQID'})).rejects.toMatchObject({code: 'INPUT_ASSET_FORMAT'});
    expect(auditEvents).toContainEqual(expect.objectContaining({event: 'application.complete', rpcCommands: [InputAssetCommand.Import],
        rpcErrorCount: 1, rpcErrorCodes: ['INPUT_ASSET_FORMAT']}));
    expect(JSON.stringify(auditEvents)).not.toContain(url); expect(JSON.stringify(auditEvents)).not.toContain('AQID');
});
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

it('publishes immutable Agent revisions and reconciles their exact receipt through authenticated RPC', async () => {
    const root = await client('agent-publication'), agents = root.services.agentService;
    await agents.saveAgent({id: 'http-published', name: 'HTTP published', type: 'agent', config: {systemPrompt: 'PRIVATE_HTTP_POLICY'}});
    const state = await agents.getAgentPublicationStatus!('http-published');
    const request = {agentId: 'http-published', operationId: 'publish-http', expectedSourceDigest: state.sourceDigest,
        expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: null};
    expect(await agents.getAgentPublicationReceipt!(request)).toBeNull();
    const first = await agents.publishAgent!(request); expect(first.target.version).toMatch(/^ap1_[a-f0-9]{64}$/);
    await agents.saveAgent({...first.definition, name: 'Unpublished HTTP name', config: {systemPrompt: 'NEW_HTTP_POLICY'}});
    expect(await agents.getAgentPublicationReceipt!(request)).toEqual(first); expect(await agents.publishAgent!(request)).toEqual(first);
    expect(await agents.getAgentRevision!('http-published', first.target.version)).toEqual(first);
    expect((await agents.getAgentPublicationStatus!('http-published')).hasDraftChanges).toBe(true);
    expect(JSON.stringify(auditEvents)).not.toContain('PRIVATE_HTTP_POLICY'); expect(JSON.stringify(auditEvents)).not.toContain('NEW_HTTP_POLICY');
});

it('queries a committed publication receipt while the original authenticated write response is still suspended', async () => {
    let release!: () => void, held = false;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const fetcher: typeof fetch = async (url, init) => {
        const request = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
        const response = await auth.fetcher(url, init);
        if (request?.kind === 'call' && request.call?.method === 'publishAgent') {held = true; await gate;}
        return response;
    };
    const peer = new HttpViewClient('held-publication', server.origin + '/api/application', fetcher); clients.push(peer);
    const root = await peer.start(), agents = root.services.agentService;
    await agents.saveAgent({id: 'held-agent', name: 'Held Agent', type: 'agent', config: {}});
    const state = await agents.getAgentPublicationStatus!('held-agent');
    const request = {agentId: 'held-agent', operationId: 'held-publication', expectedSourceDigest: state.sourceDigest,
        expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: null};
    const pending = agents.publishAgent!(request); const finished = vi.fn(); void pending.then(finished);
    try {
        await vi.waitFor(() => expect(held).toBe(true)); expect(finished).not.toHaveBeenCalled();
        const receipt = await agents.getAgentPublicationReceipt!(request);
        expect(receipt?.target.digest).toBe(state.draftDigest); expect(finished).not.toHaveBeenCalled();
        release(); expect(await pending).toEqual(receipt);
    } finally {release(); await pending.catch(() => {});}
});

it('stages generic binary files through authenticated RPC and inspects the immutable original upload', async () => {
    const root = await client('generic-files'), data = new TextEncoder().encode('PRIVATE_FILE_BODY').buffer;
    const identity = {uploadId: '12345678-1234-4123-8123-123456789abc', name: 'private-input.pdf', mimeType: 'application/pdf',
        bytes: data.byteLength, sha256: createHash('sha256').update(new Uint8Array(data)).digest('hex')};
    expect(await root.services.commandBus.execute(InputAssetCommand.Inspect, identity)).toEqual({state: 'missing'});
    const reference = await root.services.commandBus.execute(InputAssetCommand.ImportFile, {...identity, data});
    expect(reference).toEqual({kind: 'input', id: identity.uploadId, mimeType: identity.mimeType, bytes: data.byteLength, sha256: identity.sha256});
    expect(await root.services.commandBus.execute(InputAssetCommand.Inspect, identity)).toEqual({state: 'ready', reference});
    expect(await root.services.commandBus.execute(InputAssetCommand.ImportFile, {...identity, data})).toEqual(reference);
    expect(auditEvents).toContainEqual(expect.objectContaining({rpcCommands: [InputAssetCommand.ImportFile], uploads: [{mimeType: identity.mimeType, bytes: identity.bytes}]}));
    await expect(root.services.commandBus.execute(InputAssetCommand.ImportFile, {...identity, name: 'different.pdf', data}))
        .rejects.toMatchObject({code: 'INPUT_ASSET_CONFLICT'});
    expect(JSON.stringify(auditEvents)).not.toContain('PRIVATE_FILE_BODY'); expect(JSON.stringify(auditEvents)).not.toContain(identity.name);
});

it('atomically rejects an old Session UI revision across authenticated views without losing opaque records', async () => {
    const a = await client('ui-cas-a'), b = await client('ui-cas-b');
    const id = await a.services.projects.sessions.create('UI CAS', null), before = await a.services.sessionRepository.getManifest(id);
    const writes = await Promise.allSettled([
        a.services.sessionRepository.compareAndSetUIState!(id, before.revision!, {operationRecords: [{id: 'a', input: 'PRIVATE_UI_RECORD'}]}),
        b.services.sessionRepository.compareAndSetUIState!(id, before.revision!, {operationRecords: [{id: 'b', input: 'PRIVATE_UI_RECORD'}]}),
    ]);
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find(result => result.status === 'rejected')).toMatchObject({reason: {code: 'SESSION_UI_STATE_CONFLICT'}});
    const current = await b.services.sessionRepository.getManifest(id);
    expect(current.revision).toBe(before.revision! + 1); expect(current.uiState?.operationRecords).toHaveLength(1);
    await expect(b.services.sessionRepository.compareAndSetUIState!(id, -1, {})).rejects.toMatchObject({code: 'SESSION_UI_STATE_VERSION_INVALID'});
    expect(JSON.stringify(auditEvents)).not.toContain('PRIVATE_UI_RECORD');
});

it('keeps Flow pause, approval and queue control independent through authenticated RPC', async () => {
    const root = await client('flow-pause'), commands = root.services.commandBus;
    const sessionId = await root.services.projects.sessions.create('Pause RPC', null);
    await commands.execute('session.bind', {sessionId});
    await commands.execute('session.instructions.edit', {action: 'pause', expectedRevision: 0});
    await commands.execute('session.send', {text: 'PRIVATE_QUEUED_INPUT', files: [], agentId: 'default'});
    const queue = await commands.execute<SessionInstructionQueue>('session.instructions.get');
    const draft: FlowDraft = {id: 'pause-rpc' as never, name: 'Pause RPC', draftVersion: 1, updatedAt: 0, layout: {},
        nodes: [{id: 'gate' as never, name: 'Gate', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {},
            config: {requestId: 'answer', prompt: 'PRIVATE_APPROVAL_PROMPT'}}], edges: []};
    await commands.execute(FlowLibraryCommand.Restore, {templates: [draft]});
    const flow = await commands.execute<FlowRevision>(FlowCommand.RevisionGet, {id: draft.id, revision: 1});
    const {taskId} = await commands.execute<{taskId: string}>(FlowCommand.RunStart, {sessionId, flow});
    let snapshot!: DurableFlowSnapshot;
    await vi.waitFor(async () => {snapshot = await commands.execute(FlowCommand.RunGet, {sessionId, taskId});
        expect(snapshot.nodes[0]?.snapshot.task.interactions.answer?.status).toBe('pending');}, {timeout: 5000});
    await commands.execute(FlowCommand.RunGoalUpdate, {taskId, requestId: 'rpc-pause', expectedEpoch: 0, goal: {status: 'paused'}});
    snapshot = await commands.execute(FlowCommand.RunGet, {sessionId, taskId});
    const epoch = snapshot.root.task.control!.epoch;
    expect(snapshot.root.task.control).toMatchObject({mode: 'pause', acknowledged: true});
    await expect(commands.execute(FlowCommand.RunPauseWithdraw, {taskId, requestId: 'rpc-withdraw', expectedEpoch: epoch})).rejects.toMatchObject({code: 'CONFLICT'});
    await commands.execute(FlowCommand.RunRespond, {taskId, targetTaskId: snapshot.nodes[0].snapshot.task.id, requestId: 'answer', value: 'PRIVATE_APPROVAL_ANSWER'});
    expect((await commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId, taskId})).root.task.exit).toBeUndefined();
    await expect(commands.execute(FlowCommand.RunGoalUpdate, {taskId, requestId: 'stale-resume', expectedEpoch: epoch - 1, goal: {status: 'active'}})).rejects.toMatchObject({code: 'CONFLICT'});
    await commands.execute(FlowCommand.RunGoalUpdate, {taskId, requestId: 'rpc-resume', expectedEpoch: epoch, goal: {status: 'active'}});
    await vi.waitFor(async () => expect((await commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId, taskId})).root.task.status).toBe('succeeded'), {timeout: 5000});
    const beforeReceipt = await commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId, taskId});
    const receipt = await commands.execute<any>(FlowCommand.RunControlReceipt, {sessionId, taskId, requestId: 'rpc-pause'});
    expect(receipt).toMatchObject({action: 'pause', expectedEpoch: 0, accepted: {requestId: 'rpc-pause'}, current: {requestId: 'rpc-resume'}});
    expect(await commands.execute(FlowCommand.RunControlReceipt, {sessionId, taskId, requestId: 'missing'})).toBeUndefined();
    await expect(commands.execute(FlowCommand.RunControlReceipt, {sessionId: 'other', taskId, requestId: 'rpc-pause'})).rejects.toThrow();
    expect((await commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId, taskId})).root.task.version).toBe(beforeReceipt.root.task.version);
    expect(await commands.execute('session.instructions.get')).toEqual(queue);
    for (const privateText of ['PRIVATE_QUEUED_INPUT', 'PRIVATE_APPROVAL_PROMPT', 'PRIVATE_APPROVAL_ANSWER']) expect(JSON.stringify(auditEvents)).not.toContain(privateText);
}, 20000);

it('reads committed Flow artifacts and byte pages through the authenticated application RPC', async () => {
    const root = await client('execution-artifacts'), commands = root.services.commandBus;
    const sessionId = await root.services.projects.sessions.create('Artifact RPC', null);
    await commands.execute('session.bind', {sessionId});
    const flow: FlowDraft = {id: 'artifact-rpc' as never, name: 'Artifact RPC', draftVersion: 1, updatedAt: 0, layout: {},
        nodes: [{id: 'value' as never, name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: {value: 'RPC 产物'}}], edges: []};
    await commands.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const revision = await commands.execute<FlowRevision>(FlowCommand.RevisionGet, {id: flow.id, revision: 1});
    const run = await commands.execute<{taskId: string}>(FlowCommand.RunStart, {sessionId, flow: revision});
    let snapshot!: DurableFlowSnapshot;
    await vi.waitFor(async () => {snapshot = await commands.execute(FlowCommand.RunGet, {sessionId, taskId: run.taskId});
        expect(snapshot.root.task.status).toBe('succeeded');}, {timeout: 5000});
    const taskId = snapshot.nodes[0].snapshot.task.id;
    const page = await commands.execute<ExecutionArtifactPage>(ArtifactCommand.List, {sessionId, taskId});
    expect(page.items).toHaveLength(1);
    const bytes: number[] = []; let offset = 0;
    do {
        const chunk = await commands.execute<ExecutionArtifactChunk>(ArtifactCommand.Read, {reference: page.items[0].reference, offset, limit: 3});
        expect(chunk.data).toBeInstanceOf(ArrayBuffer); expect(chunk.offset).toBe(offset);
        bytes.push(...new Uint8Array(chunk.data)); if (chunk.nextOffset === undefined) break; offset = chunk.nextOffset;
    } while (true);
    const text = new TextDecoder().decode(new Uint8Array(bytes));
    expect(page.items[0].kind === 'json' ? JSON.parse(text) : text).toBe('RPC 产物');
    expect(auditEvents).toContainEqual(expect.objectContaining({event: 'application.complete', rpcCommands: [ArtifactCommand.Read]}));
    await expect(commands.execute(ArtifactCommand.Read, {reference: {...page.items[0].reference, sessionId: 'other'}})).rejects.toThrow();
}, 20000);

it('reads explicit context options while the original authenticated queue admission reply is suspended', async () => {
    let release!: () => void, held = false;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const fetcher: typeof fetch = async (url, init) => {
        const request = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined, response = await auth.fetcher(url, init);
        if (request?.kind === 'call' && request.call?.method === 'execute' && request.call?.args?.[0] === 'session.send') {held = true; await gate;}
        return response;
    };
    const peer = new HttpViewClient('context-options-held', server.origin + '/api/application', fetcher); clients.push(peer);
    const root = await peer.start(), commands = root.services.commandBus, agents = root.services.agentService;
    await agents.saveAgent({id: 'context-options-model', name: 'Model', type: 'agent', config: {}});
    const publication = await agents.getAgentPublicationStatus!('context-options-model');
    const revision = await agents.publishAgent!({agentId: 'context-options-model', operationId: 'publish-options', expectedSourceDigest: publication.sourceDigest,
        expectedRevisionDigest: publication.draftDigest, expectedPublishedVersion: null});
    const source = await root.services.projects.sessions.create('Options source', null), active = await root.services.projects.sessions.create('Active queue', null);
    await commands.execute('session.bind', {sessionId: active}); await commands.execute('session.instructions.edit', {action: 'pause', expectedRevision: 0});
    const pending = commands.execute('session.send', {text: 'PRIVATE_CONTEXT_OPTIONS_INPUT', files: [], agentId: 'default'});
    try {
        await vi.waitFor(() => expect(held).toBe(true));
        const options = await commands.execute('session.context.options', {sessionId: source, branchId: 'main', target: revision.target,
            overrides: {systemPromptAppend: 'PRIVATE_CONTEXT_OPTIONS_POLICY'}});
        expect(options).toMatchObject({kind: 'other', sessionId: source, target: revision.target, dynamicPolicy: 'dispatch-validation-required'});
        expect(await commands.execute('session.get-current-id')).toBe(active);
        expect(await commands.execute<SessionInstructionQueue>('session.instructions.get')).toMatchObject({paused: true, items: [expect.anything()]});
        expect(JSON.stringify(auditEvents)).not.toContain('PRIVATE_CONTEXT_OPTIONS_INPUT');
        expect(JSON.stringify(auditEvents)).not.toContain('PRIVATE_CONTEXT_OPTIONS_POLICY');
        expect(JSON.stringify(options)).not.toContain('PRIVATE_CONTEXT_OPTIONS_POLICY');
    } finally {release(); await pending;}
}, 20000);
