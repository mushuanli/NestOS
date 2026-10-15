import { RPC_VERSION } from '../src/rpc/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLocalFSBackend, type LocalFSBackend } from '@itookit/vfsdriver-local';
import { createApplicationApi } from '../src/server/application-host';
import { createCertificates } from '../src/server/create-certificates';
import { NodeSqliteSidecarDb } from '../src/server/sqlite-sidecar';
import { HttpViewClient } from '../src/client/view-client';
import { authenticatedFetch, close, secureServers } from './tls-fixture';

let certificateRoot: string, certificates: string, directory: string, backend: LocalFSBackend;
let api: ReturnType<typeof createApplicationApi>, server: Awaited<ReturnType<typeof secureServers>>, auth: Awaited<ReturnType<typeof authenticatedFetch>>;
const clients: HttpViewClient[] = [];
beforeAll(async () => { certificateRoot = await mkdtemp(path.join(tmpdir(), 'mindos-view-certs-')); certificates = path.join(certificateRoot, 'certs'); await createCertificates(certificates, ['127.0.0.1']); });
afterAll(async () => { await rm(certificateRoot, { recursive: true, force: true }); });
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mindos-view-'));
    const root = path.join(directory, 'data'), ui = path.join(directory, 'ui'); await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<title>MindOS</title>');
    backend = await openLocalFSBackend({ rootDir: root, sidecarDir: path.join(directory, 'meta'), createDb: NodeSqliteSidecarDb.open });
    api = createApplicationApi(backend, root); server = await secureServers(backend, root, ui, certificates, api); auth = await authenticatedFetch(certificates);
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
