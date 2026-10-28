import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAuthorizationHost } from '@itookit/kernel-adapters/llm/core';
import { createApplicationRuntime } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { RpcPeer } from '@itookit/app-transport/application';
import { createHostedView } from '@itookit/node-host/http';
import { installViewProjections } from '@itookit/app-transport/application';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); vi.unstubAllGlobals(); });
async function setup(providerAuthorization?: ProviderAuthorizationHost) {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false, providerAuthorization });
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
    it('drains queued file unsubscriptions before disposing their owning workspace', async () => {
        const {root, server, client} = await setup();
        const settings = await root.backend.settings([{name: 'Notes', workspace: 'notes'}]);
        const files = await settings.openWorkspace('Notes');
        const stop = files.on('node:created', () => {}); await client.whenIdle();
        let finish!: () => void, begun = false; const gate = new Promise<void>(resolve => {finish = resolve;});
        const order: string[] = [], handle = server.handle.bind(server);
        vi.spyOn(server, 'handle').mockImplementation(async (call, refresh) => {
            if (call.method === 'call') {begun = true; order.push('unsubscribe-start'); await gate; order.push('unsubscribe-end');}
            if (call.method === 'dispose') order.push('dispose');
            return handle(call, refresh);
        });
        stop(); await vi.waitFor(() => expect(begun).toBe(true));
        const closing = settings.dispose(); await Promise.resolve(); await Promise.resolve();
        expect(order).toEqual(['unsubscribe-start']);
        finish(); await closing; await client.whenIdle();
        expect(order).toEqual(['unsubscribe-start', 'unsubscribe-end', 'dispose']);
    });

    it('roundtrips document anchor capabilities and releases subscriptions without disposing borrowed files', async () => {
        const {root} = await setup();
        const files = await root.services.vfs.openFileSystem('/home/admin/notes');
        await files.driver.createFile({parentPath: '/', name: 'anchors.md', content: 'Selected text'});
        const port = await root.backend.documentChatFile({files, path: '/anchors.md'});
        expect(await port.get('a')).toEqual({});
        const created = await port.create('a', 'Selected text');
        expect(created.selection).toBe('Selected text');
        const changed = vi.fn(), stop = port.subscribe(changed);
        await root.services.sessionRepository.createSession('Trigger');
        await vi.waitFor(() => expect(changed).toHaveBeenCalled());
        stop(); await port.dispose();
        await expect(port.get('a')).rejects.toMatchObject({code: 'ECAPABILITY'});
        expect(await files.driver.exists('/anchors.md')).toBe(true);
        expect(await root.backend.documentChatBacklinks('absent', 'main')).toEqual([]);
    });

    it('exports disposal for owned attachment views and keeps the repository alive after release', async () => {
        const {root, runtime} = await setup();
        const sessionId = await runtime.sessionRepository.createSession('Owned attachments');
        const local = await runtime.sessionRepository.openAttachments(sessionId), dispose = vi.spyOn(local, 'dispose');
        vi.spyOn(runtime.sessionRepository, 'openAttachments').mockResolvedValueOnce(local);
        const assets = await root.services.sessionRepository.openAttachments(sessionId);
        expect(typeof assets.dispose).toBe('function'); expect(typeof assets.openFile).toBe('function');
        await assets.driver.createFile({parentPath: '/', name: 'image.png', content: 'fixture'});
        expect(await assets.driver.readContent('/image.png', {encoding: 'utf-8'})).toBe('fixture');
        await assets.dispose(); expect(dispose).toHaveBeenCalledOnce();
        await expect(assets.capabilitiesAt('/')).rejects.toMatchObject({code: 'ECAPABILITY'});
        expect((await root.services.sessionRepository.getManifest(sessionId)).id).toBe(sessionId);
    });
    it('preserves draft UUIDs over RPC and returns the replacement identity after clearing', async () => {
        const {root, runtime} = await setup(), projects = root.services.projects;
        const project = await projects.personal(), folder = await projects.sessionFolder(project);
        const draft = await projects.drafts.open(project.project.id, folder), first = draft.id;
        expect(first).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        await draft.save(JSON.stringify({version: 2, config: {text: 'Discard', agentId: 'default'}, files: []}));
        const replacement = await draft.clear();
        expect(replacement).not.toBe(first); expect(replacement).toBe((await projects.drafts.open(project.project.id, folder)).id);
        const prepared = await draft.prepare(); expect(prepared.sessionId).toBe(replacement);
        expect((await runtime.sessionRepository.getManifest(replacement)).id).toBe(replacement);
    });
    it('keeps toolbox path checks on the server while retaining managed-path write protection', async () => {
        const { root, server, runtime } = await setup();
        const agents = await runtime.vfs.openFileSystem('/home/admin/agents');
        await agents.driver.createFile({ parentPath: '/team/deep', name: '.gitignore', recursive: true, content: 'hidden.agent\n' });
        for (const name of ['hidden.agent', 'visible.agent']) await agents.driver.createFile({ parentPath: '/team/deep', name,
            content: JSON.stringify({ id: name, name, type: 'agent', config: {} }) });
        const toolbox = await root.backend.toolboxView(), calls: string[] = [];
        const handle = server.handle.bind(server);
        vi.spyOn(server, 'handle').mockImplementation((call, refresh) => { calls.push(server.operationName(call)); return handle(call, refresh); });
        const nodes = await toolbox.files.driver.getChildren('/agents/team/deep');
        expect(nodes.map((node: { name: string }) => node.name).sort()).toEqual(['hidden.agent', 'visible.agent']);
        expect(calls).toEqual(['IFSDriver.getChildren']);
        await expect(toolbox.files.driver.createFile({ parentPath: '/providers', name: 'forged.json', content: '{}' })).rejects.toThrow();
        await toolbox.files.driver.createFile({ parentPath: '/agents/team/deep', name: 'allowed.agent', content: '{}' });
        expect(await agents.driver.exists('/team/deep/allowed.agent')).toBe(true);
        await toolbox.dispose();
    });
    it('keeps delayed settings workspace views within the same file permissions', async () => {
        const { root } = await setup();
        const settings = await root.backend.settings([{ name: 'Notes', workspace: 'notes' }, { name: 'Sessions', workspace: 'chats' }]);
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
        const notes = await services.vfs.openFileSystem('/home/admin/notes');
        const file = await notes.driver.createFile({ name: 'remote.md', parentPath: '/' });
        await notes.driver.writeContent(file.path, '# Remote');
        expect(await notes.driver.readContent(file.path, { encoding: 'utf-8' })).toBe('# Remote');
        expect(await notes.openFile(file.path).read({ encoding: 'utf-8' })).toBe('# Remote');
        const model = services.agentService;
        expect(await model.getAgents()).not.toHaveLength(0);
        expect(model.findAgent('default')).toBeDefined();
        const snapshot = await services.digitalTwin.snapshot(); expect(snapshot.settings).toBeDefined();
        expect(await services.projects.list()).toBeInstanceOf(Array);
        const settings = await backend.settings([{ name: 'notes', fs: notes }]);
        expect(settings.getAvailableWorkspaces()).toEqual([{ name: 'notes', description: undefined }]);
    });
    it('keeps runtime ownership and arbitrary properties outside the public API', async () => {
        const { root, server } = await setup();
        expect(root.services.dispose).toBeUndefined(); expect(root.services.vfs.dispose).toBeUndefined();
        expect(root.services.commandBus.register).toBeUndefined();
        const result = await server.handle({ target: 'server:1', method: 'constructor', args: [] });
        expect(result.error?.code).toBe('ECAPABILITY');
        expect(result.error?.remoteCode).toBe('RPC_CAPABILITY_NOT_FOUND');
        await expect(root.services.vfs.openFileSystem('/')).rejects.toThrow();
        const etc = await root.services.vfs.openFileSystem('/etc');
        await expect(etc.driver.writeContent('/llm/providers.seq', '{}')).rejects.toThrow();
        await expect(etc.meta.tags.setTags('/llm/providers.seq', ['changed'])).rejects.toThrow();
        const chats = await root.services.vfs.openFileSystem('/home/admin/chats');
        await expect(chats.driver.createFile({ name: 'managed.json', parentPath: '/' })).rejects.toThrow();
    });
    it('carries binary files, callbacks, unsubscribe and async iterators without shipping source', async () => {
        const { root } = await setup();
        const fs = await root.services.vfs.openFileSystem('/home/admin/notes');
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

it('uses private subscription credentials through public model and connection ports without exposing tokens', async () => {
    const state = { supported: true, status: 'authorized' as const, account: 'user@example.com' };
    const host: ProviderAuthorizationHost = { state: () => state, begin: async () => state, complete: async () => state,
        cancel: async () => state, disconnect: async () => state, onChange: () => () => {},
        credentials: () => ({ session: { getToken: async () => ({ accessToken: 'backend-private-token',
            scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] }) } }) };
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer backend-private-token');
        if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'account-model', display_name: 'Account model', visibility: 'list' }] });
        const body = JSON.parse(init!.body as string); expect(body.store).toBe(false); expect(body.stream).toBe(true);
        return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed',
            model: 'account-model', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] } }) + '\n\n');
    });
    vi.stubGlobal('fetch', fetcher);
    const { root } = await setup(host), service = root.services.agentService;
    const toolbox = await root.backend.toolboxView();
    await toolbox.resources.create('providers', 'ChatGPT', undefined, 'chatgpt');
    await toolbox.dispose();
    expect(await service.getProviderAuthorization('chatgpt')).toEqual(state);
    expect(await service.beginProviderAuthorization('chatgpt')).toEqual(state);
    const provider = await service.getFullProvider('chatgpt');
    expect(provider).toMatchObject({ implementation: 'chatgpt', models: [] });
    const models = await service.listProviderModels(provider); expect(models[0].id).toBe('account-model');
    await service.saveProvider({ ...provider, models });
    const connection = (await service.getConnections()).find((item: { providerId: string }) => item.providerId === 'chatgpt');
    expect(connection).toMatchObject({ hasApiKey: false, credentialsReady: true });
    expect(await service.testConnection({ provider: 'chatgpt', model: 'account-model' })).toMatchObject({ success: true });
    expect(service.credentials).toBeUndefined(); expect(service.authorization).toBeUndefined();
    expect(JSON.stringify(await service.getFullProvider('chatgpt'))).not.toContain('backend-private-token');
});
