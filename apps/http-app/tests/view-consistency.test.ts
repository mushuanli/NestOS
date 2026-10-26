import { afterEach, expect, it, vi } from 'vitest';
import { RpcPeer } from '@itookit/app-transport/application';
import { HttpViewClient } from '@itookit/app-transport/http';
import { bindApplicationBackend } from '@itookit/app-core/host';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';
import { ProjectFavorites } from '../../../backend/app-core/src/projects/favorites/service';
import type { ProjectFavorite, ProjectFavoriteTarget } from '@itookit/app-contracts/services';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(releases.splice(0).reverse().map(release => release())); });
async function pair(value: unknown) {
    let client!: RpcPeer;
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', call => server.handle(call));
    releases.push(() => client.close(), () => server.close());
    const boot = await server.bootstrap(value); client.applyUpdates(boot.updates);
    return { server, client, root: client.decode(boot.value!) };
}
it('replays an SSE patch arriving before its bootstrap response', async () => {
    let name = 'before', stream!: ReadableStreamDefaultController<Uint8Array>;
    const model = { getConnections: async () => [], saveConnection: async () => {}, listConnections: () => [],
        getProviders: () => [{ id: 'p', name, description: 'stable history'.repeat(1000) }] };
    const server = new RpcPeer('server', async () => ({})); releases.push(() => server.close());
    const fetcher: typeof fetch = async (input, init) => {
        if (String(input).includes('/events?')) return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
        if (JSON.parse(String(init?.body)).kind === 'close') { stream.close(); return new Response('{}'); }
        const boot = await server.bootstrap({ model });
        name = 'after'; server.invalidate('configuration');
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ updates: await server.refresh() })}\n\n`));
        await new Promise(resolve => setTimeout(resolve, 10)); return new Response(JSON.stringify(boot));
    };
    const client = new HttpViewClient('initial-race', '/api/application', fetcher); releases.push(() => client.close());
    const root = await client.start() as unknown as { model: typeof model & { getProvider(id: string): { name: string } } };
    expect(root.model.getProvider('p').name).toBe('after');
});
it('keeps favorite identities and synchronous snapshots consistent after writes and reloads', async () => {
    const rows = new Map<string, ProjectFavorite[]>();
    const favorites = new ProjectFavorites({ read: async id => structuredClone(rows.get(id) ?? []), update: async (id, change) => {
        const items = change(structuredClone(rows.get(id) ?? [])); rows.set(id, items); return { items, changed: true };
    } });
    const { root } = await pair(favorites), target: ProjectFavoriteTarget = { kind: 'file', path: '/workspace/a', nodeType: 'file' };
    await root.list('project'); await root.toggle('project', target, 'A');
    expect(root.has('project', target)).toBe(true);
    expect(root.has('project', { path: '/workspace/a', nodeType: 'directory', kind: 'file' })).toBe(true);
    await root.toggle('project', target, 'A'); expect(root.has('project', target)).toBe(false);
    rows.set('project', [{ id: 'external', title: 'A', target }]);
    await root.list('project'); expect(root.has('project', target)).toBe(true);
});
function files() {
    const listeners = new Set<() => void>();
    return { listeners, fs: { viewId: crypto.randomUUID(), revision: 0,
        driver: { getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {} },
        meta: { assets: {}, tags: {} }, onAny: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } };
}
it('reclaims disposed resource graphs without revoking a shared filesystem', async () => {
    const shared = files(), owned = files(), dispose = vi.fn();
    const factory = { workbenchView: async () => ({ fs: owned.fs, shared: shared.fs, dispose }), toolboxView: () => {}, taskDetails: () => {} };
    const { root } = await pair({ shared: shared.fs, factory });
    for (let index = 0; index < 750; index++) {
        const view = await root.factory.workbenchView();
        await view.dispose();
        await expect(view.fs.driver.getNode('/')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    }
    expect(dispose).toHaveBeenCalledTimes(750); expect(owned.listeners.size).toBe(0);
    expect(await root.shared.driver.getNode('/')).toBeNull(); expect(shared.listeners.size).toBe(1);
});
it('refreshes a conversation snapshot after a poll without a domain event', async () => {
    let state = 'before';
    const { root } = await pair({ snapshot: () => ({ state }), subscribe: () => () => {}, respond: async () => {}, refresh: async () => { state = 'after'; return { state }; } });
    expect(root.snapshot()).toEqual({ state: 'before' });
    await root.refresh(); expect(root.snapshot()).toEqual({ state: 'after' });
});

it('transports a native command catalog and refreshes its snapshot after a command receipt', async () => {
    const catalog = [{name: 'compact', description: 'Compact', kind: 'action'}];
    let messages: unknown[] = [];
    const {root} = await pair({snapshot: () => ({messages}), subscribe: () => () => {}, respond: async () => {}, commands: async () => catalog,
        command: async (name: string, args: string) => {
            messages = [{id: 'native-command', role: 'system', text: name + ':' + args}]; return {messages};
        }});
    expect(await root.commands()).toEqual(catalog);
    await root.command('compact', 'retain decisions');
    expect(root.snapshot().messages).toEqual([{id: 'native-command', role: 'system', text: 'compact:retain decisions'}]);
});
it('transports native model metadata and preserves the per-submission selection', async () => {
    const catalog = {models: [{id: 'native', label: 'Native', reasoningEfforts: [{id: 'high', label: 'High'}]}]};
    const send = vi.fn(async () => ({messages: []}));
    const {root} = await pair({snapshot: () => ({messages: [], supportsModels: true}), subscribe: () => () => {}, respond: async () => {}, models: async () => catalog, send});
    expect(await root.models()).toEqual(catalog);
    await root.send('Prompt', [], {modelId: 'native', reasoningEffort: 'high'});
    expect(send).toHaveBeenCalledExactlyOnceWith('Prompt', [], {modelId: 'native', reasoningEffort: 'high'});
});

it('preserves original command input independently of its parsed arguments over RPC', async () => {
    const command = vi.fn(async () => ({messages: []}));
    const {root} = await pair({snapshot: () => ({messages: []}), subscribe: () => () => {}, respond: async () => {}, command});
    await root.command('verify', 'src', {modelId: 'native'}, '  /verify src\n');
    expect(command).toHaveBeenCalledExactlyOnceWith('verify', 'src', {modelId: 'native'}, '  /verify src\n');
});
it('refreshes toolbox grouping and inventory with navigation without a configuration event', async () => {
    let groups = [{ id: 'old', kind: 'skills', name: 'Old', paths: ['/skills/old'] }];
    const inventory = { remoteAgentSource: {}, providers: new Map([['old', { name: 'Old' }]]) };
    const resources = { sources: {}, hasProvider: () => true, subscribe: () => () => {},
        drawers: { snapshot: () => groups, assign: async () => {} },
        navigation: async () => {
            groups = [{ id: 'new', kind: 'skills', name: 'New', paths: ['/skills/new'] }];
            inventory.providers = new Map([['new', { name: 'New' }]]);
            return { directories: [], loadedDirectories: ['/skills'], descriptions: new Map([['skills/new', { name: 'New' }]]) };
        } };
    const { root } = await pair({ resources, inventory });
    expect(root.resources.drawers.snapshot()[0].id).toBe('old');
    expect(root.inventory.providers.has('old')).toBe(true);
    const navigation = await root.resources.navigation();
    expect(navigation.descriptions.get('skills/new').name).toBe('New');
    expect(root.resources.drawers.snapshot()).toEqual(groups);
    expect(root.resources.drawers.get('old')).toBeUndefined();
    expect(root.resources.drawers.forPath('/skills/new').id).toBe('new');
    expect([...root.inventory.providers.keys()]).toEqual(['new']);
});
it('releases nested services and their subscriptions with the owning view', async () => {
    const listeners = new Set<() => void>(), dispose = vi.fn();
    const settings = { getContacts: () => [], readPreference: async () => '', dispose,
        onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const { root } = await pair({ workbenchView: async () => ({ settings, dispose }), toolboxView: () => {}, taskDetails: () => {} });
    const view = await root.workbenchView(); view.settings.onChange(() => {});
    await vi.waitFor(() => expect(listeners.size).toBe(2));
    await view.dispose();
    expect(dispose).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0);
    await expect(view.settings.readPreference('/')).rejects.toMatchObject({ code: 'ECAPABILITY' });
});
it('retains asynchronously registered skill listeners until unsubscribe', async () => {
    const listeners = new Set<() => void>(), changed = vi.fn();
    const { root } = await pair({ describe: async () => undefined, list: async () => [],
        onChange: async (_session: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
    const stop = await root.onChange('session', changed);
    expect(typeof stop).toBe('function'); await root.list('session');
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce()); stop();
    await vi.waitFor(() => expect(listeners.size).toBe(0));
});

it('queries task details by identity and projects key events before crossing the boundary', async () => {
    const task = { id: 'task', sessionId: 'session', program: { kind: 'test' }, status: 'running', effects: { e: { status: 'pending', leaseToken: 'private-lease' } },
        control: { mode: 'cancel', acknowledged: false }, output: 'result', version: 2 };
    const page = { items: [
        { taskId: 'task', sequence: 1, occurredAt: 1, type: 'agent.event', payload: { type: 'text-delta', text: 'hidden delta' } },
        { taskId: 'task', sequence: 2, occurredAt: 2, type: 'task.control.changed', payload: {} },
        { taskId: 'other', sequence: 3, occurredAt: 3, type: 'task.failed', payload: {} },
    ], throughIndex: 3, nextAfterIndex: 2, firstAvailableIndex: 1 };
    const kernel = { task: async () => task, taskEventPage: vi.fn(async () => page) };
    const backend = bindApplicationBackend({ kernel: { kernel } } as unknown as LocalApplicationServices);
    const { root, server } = await pair(backend), calls = vi.spyOn(server, 'handle');
    const detail = await root.taskDetails('session', 'task');
    expect(calls).toHaveBeenCalledOnce(); expect(calls.mock.calls[0][0].args).toEqual(['session', 'task']);
    expect(detail.stat).toMatchObject({ control: { requested: 'cancel', acknowledged: false }, activeOperations: 1 });
    expect(detail.events).toMatchObject({ throughIndex: 3, nextAfterIndex: 2, items: [{ type: 'task.control.changed', sequence: 2 }] });
    expect(JSON.stringify(detail)).not.toMatch(/private-lease|hidden delta/);
    await root.taskEvents('session', 'task', { afterIndex: 2, throughIndex: 3 });
    expect(kernel.taskEventPage).toHaveBeenLastCalledWith('session', 'task', { afterIndex: 2, throughIndex: 3 });
});
it('ignores late updates for disposed capabilities instead of resurrecting them or reporting a gap', async () => {
    const source = files();
    const { root, server, client } = await pair({ workbenchView: async () => ({ fs: source.fs, dispose() {} }), toolboxView() {}, taskDetails() {} });
    const calls = vi.spyOn(server, 'handle'), view = await root.workbenchView();
    const delayed = (await calls.mock.results[0].value).updates;
    await view.dispose(); const count = calls.mock.calls.length;
    client.applyUpdates(delayed); await client.waitUpdates(delayed);
    await expect(view.fs.driver.getNode('/')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    expect(calls.mock.calls.length).toBe(count);
});

it.each(['missing', 'throws'])('preserves a per-view session filter through RPC without native UUID (%s)', async mode => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: original.getRandomValues.bind(original),
        ...(mode === 'throws' ? {randomUUID: () => {throw new Error('Native UUID unavailable');}} : {})});
    try {
        let filter: string | undefined;
        const browser = {fs: {}, dispose: async () => {}, transferItems: async () => {}, readFileDirectory: async () => [], invalidateNavigation: async () => {},
            setSessionFilter: async (agentId?: string) => {filter = agentId;}};
        const {root} = await pair({workbenchView: async () => ({browser}), toolboxView: async () => {}, taskDetails: async () => {}});
        const view = await root.workbenchView(); await view.browser.setSessionFilter('writer'); expect(filter).toBe('writer');
        await view.browser.setSessionFilter(); expect(filter).toBeUndefined();
    } finally {vi.unstubAllGlobals();}
});
