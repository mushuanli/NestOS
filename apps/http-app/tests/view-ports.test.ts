import { afterEach, describe, expect, it } from 'vitest';
import { createApplicationRuntime } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { RpcPeer } from '../src/application/peer';
import { createHostedView } from '../src/server/view-services';
import { installViewProjections } from '../src/application/projections';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });
async function setup() {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false });
    releases.push(() => runtime.dispose());
    const view = await createHostedView(runtime); releases.push(() => view.close());
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
    server = new RpcPeer('server', async call => { client.applyUpdates(await server.refresh()); return client.handle(call); }, console.error, undefined, domains => view.prepare(server, domains));
    releases.push(() => client.close(), () => server.close());
    const root = client.decode(await server.expose(view.root));
    client.applyUpdates(await server.refresh());
    return { root, server, client, runtime };
}
describe('full application view ports', () => {
    it('keeps delayed settings workspace views within the same file permissions', async () => {
        const { root } = await setup();
        const settings = await root.backend.settings([{ name: 'Notes', workspace: 'minds' }, { name: 'Sessions', workspace: 'chats' }]);
        expect(settings.workspaces).toEqual([{ name: 'Notes' }, { name: 'Sessions' }]);
        expect(settings.init).toBeUndefined();
        const notes = await settings.openWorkspace('Notes');
        await notes.driver.createFile({ name: 'allowed.md', parentPath: '/', content: 'OK' });
        expect(await notes.driver.readContent('/allowed.md', { encoding: 'utf-8' })).toBe('OK');
        const chats = await settings.openWorkspace('Sessions');
        await expect(chats.driver.createFile({ name: 'forged.json', parentPath: '/' })).rejects.toThrow();
        await expect(settings.configFiles.driver.createFile({ name: 'forged.json', parentPath: '/llm' })).rejects.toThrow();
        await expect(root.backend.settings([{ name: 'Outside', workspace: '../etc' }])).rejects.toThrow();
        await settings.dispose();
    });
    it('exposes OCR as lazy backend operations and creates defaults only on explicit configuration', async () => {
        const { root, runtime } = await setup(), ocr = await root.backend.ocr();
        expect(ocr.init).toBeUndefined(); expect(ocr.snapshot).toBeUndefined();
        expect(await ocr.readSettings()).toEqual({ systemPromptId: 'image-to-markdown' });
        const etc = await runtime.vfs.openFileSystem('/etc');
        expect(await etc.driver.exists('/llm/ocr.json')).toBe(false);
        await ocr.prepareConfiguration(); expect(await etc.driver.exists('/llm/ocr.json')).toBe(true);
    });
    it('provides files, configuration, projects, sessions and digital twin through the public graph', async () => {
        const { root } = await setup(), { services, backend } = root;
        expect(services.digitalTwin).toBeDefined();
        const notes = await services.vfs.openFileSystem('/home/admin/minds');
        const file = await notes.driver.createFile({ name: 'remote.md', parentPath: '/' });
        await notes.driver.writeContent(file.path, '# Remote');
        expect(await notes.driver.readContent(file.path, { encoding: 'utf-8' })).toBe('# Remote');
        expect(await notes.openFile(file.path).read({ encoding: 'utf-8' })).toBe('# Remote');
        const model = services.agentService;
        expect(await model.getAgents()).not.toHaveLength(0);
        expect(model.findAgent('default')).toBeDefined();
        const snapshot = await services.digitalTwin.snapshot(); expect(snapshot.settings).toBeDefined();
        expect(await services.projects.list()).toBeInstanceOf(Array);
        const settings = await backend.settings([{ name: 'minds', fs: notes }]);
        expect(settings.getAvailableWorkspaces()).toEqual([{ name: 'minds', description: undefined }]);
    });
    it('keeps runtime ownership and arbitrary properties outside the public API', async () => {
        const { root, server } = await setup();
        expect(root.services.dispose).toBeUndefined(); expect(root.services.vfs.dispose).toBeUndefined();
        expect(root.services.commandBus.register).toBeUndefined();
        const result = await server.handle({ target: 'server:1', method: 'constructor', args: [] });
        expect(result.error?.code).toBe('ECAPABILITY');
        await expect(root.services.vfs.openFileSystem('/')).rejects.toThrow();
        const etc = await root.services.vfs.openFileSystem('/etc');
        await expect(etc.driver.writeContent('/llm/providers.seq', '{}')).rejects.toThrow();
        await expect(etc.meta.tags.setTags('/llm/providers.seq', ['changed'])).rejects.toThrow();
        const chats = await root.services.vfs.openFileSystem('/home/admin/chats');
        await expect(chats.driver.createFile({ name: 'managed.json', parentPath: '/' })).rejects.toThrow();
    });
    it('carries binary files, callbacks, unsubscribe and async iterators without shipping source', async () => {
        const { root } = await setup();
        const fs = await root.services.vfs.openFileSystem('/home/admin/minds');
        const file = await fs.driver.createFile({ name: 'image.bin', parentPath: '/' });
        const bytes = new Uint8Array([0, 128, 255]).buffer;
        await fs.driver.writeContent(file.path, bytes);
        expect(new Uint8Array(await fs.driver.readContent(file.path, { encoding: 'binary' }))).toEqual(new Uint8Array(bytes));
        const nodes: string[] = []; const stop = fs.on('node:created', (event: any) => nodes.push(event.payload.nodes[0].path));
        await new Promise(resolve => setTimeout(resolve, 0));
        await fs.driver.createFile({ name: 'event.md', parentPath: '/' });
        await new Promise(resolve => setTimeout(resolve, 0)); expect(nodes).toContain('/event.md'); stop();
        const ids: string[] = []; for await (const session of root.services.kernel.kernel.listSessions()) ids.push(session.id);
        expect(ids).toEqual([]);
    });
});

it('preserves JSON Schema references and ordinary reserved field names as data', async () => {
    const server = new RpcPeer('server', async () => ({})), client = new RpcPeer('client', async () => ({}));
    const data = JSON.parse('{"$ref":"#/$defs/node","constructor":"field","__proto__":{"safe":true}}');
    expect(client.decode(await server.expose(data))).toEqual(data);
    expect(Object.getPrototypeOf(client.decode(await server.expose(data)))).toBe(Object.prototype);
    await client.close(); await server.close();
});

it('reads full Provider configuration only on an explicit asynchronous request', async () => {
    const { root, runtime, server } = await setup();
    await runtime.agentService.saveProvider({ id: 'secret', name: 'Secret', implementation: 'openai-compatible', baseURL: 'https://api.example.test', apiKey: 'private-key', models: [] });
    expect(JSON.stringify(await server.refresh())).not.toContain('private-key');
    expect(await root.services.agentService.getFullProvider('secret')).toHaveProperty('apiKey', 'private-key');
});

it('opens an owned Session read model and binds it on activation without exposing runtime ownership', async () => {
    const { root } = await setup();
    const id = await root.services.projects.sessions.create('Aggregated', null);
    const view = await root.backend.openSessionView(id);
    expect(view.manifest).toMatchObject({ id, title: 'Aggregated' }); expect(view.context.fs.driver).toBeDefined();
    const initial = await view.activate('main');
    expect(initial).toMatchObject({ sessionId: id, manifest: { id, currentBranch: 'main' }, snapshot: { sessionId: id } });
    expect(root.services.sessionManager.getSnapshot().sessionId).toBe(id);
    await view.dispose(); expect(root.services.sessionManager.getSnapshot().sessionId).toBe(id);
    await expect(view.activate()).rejects.toThrow();
    expect(view.commandBus).toBeUndefined(); expect(view.kernel).toBeUndefined();
});
