import { afterEach, expect, it, vi } from 'vitest';
import { RpcPeer } from '@itookit/app-transport/application';
import { installViewProjections } from '@itookit/app-transport/application';
import { QueryBatcher } from '@itookit/app-transport/http';
import { ViewNotifications } from '@itookit/node-host/http';
import type { ServerResponse } from 'node:http';
import type { Call, Reply, WireValue } from '@itookit/app-transport/rpc';

const peers: RpcPeer[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(peers.splice(0).map(peer => peer.close())); });
async function pair(value: unknown) {
    let client!: RpcPeer;
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', call => server.handle(call), undefined, installViewProjections);
    peers.push(server, client);
    const boot = await server.bootstrap(value); client.applyUpdates(boot.updates);
    return { server, client, root: client.decode(boot.value!) };
}
function models() {
    let changed = () => {};
    const providers = [{ id: 'provider', name: 'Before', implementation: 'test', baseURL: '', models: [] }];
    return { providers, changed: () => changed(), getConnections: async () => [], saveConnection: async () => {},
        getProviders: vi.fn(() => providers), listConnections: vi.fn(() => []),
        getFullProvider: async (id: string) => providers.find(provider => provider.id === id),
        onChange: (listener: () => void) => { changed = listener; return () => { changed = () => {}; }; } };
}
it('does not recompute unrelated configuration snapshots for repeated reads or file writes', async () => {
    const model = models();
    const files = { getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {} };
    const { root } = await pair({ model, files }); model.getProviders.mockClear();
    for (let index = 0; index < 10; index++) await root.files.getNode('/file');
    await root.files.writeContent('/file', 'new content');
    expect(model.getProviders).not.toHaveBeenCalled();
    model.providers[0].name = 'After'; model.changed();
    await root.files.getNode('/file');
    expect(model.getProviders).toHaveBeenCalledTimes(1);
    expect(root.model.getProvider('provider').name).toBe('After');
});
it('keeps concurrent subscription callbacks alive when another request releases its temporary callback', async () => {
    const listeners = new Set<(event: unknown) => void>(), revision = vi.fn(), event = vi.fn();
    const files = { getChildren: async () => [], search: async () => [], writeContent: async () => {},
        getNode: async (_path: string, options: any) => { await new Promise(resolve => setTimeout(resolve, 0)); await options.onRevision(1); return null; },
        onAny: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
    const { root } = await pair(files);
    const read = root.getNode('/', { onRevision: revision });
    const stop = root.onAny(event); await read;
    for (const listener of listeners) listener('changed');
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith('changed'));
    expect(revision).toHaveBeenCalledWith(1); stop();
});
it('keeps supported transaction reads on their active transaction instead of the query batch path', async () => {
    const contents = new Map<string, string>();
    const tx = { getNode: async () => null, createFile: async () => ({ path: '/file' }), delete: async () => {},
        writeContent: async (path: string, value: string) => { contents.set(path, value); }, readContent: async (path: string) => contents.get(path) };
    const files = { getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {},
        transaction: async (callback: (value: typeof tx) => Promise<void>) => callback(tx) };
    const { root, client } = await pair(files);
    await root.transaction(async (transaction: any) => {
        const ref = await client.expose(transaction) as { $ref: string };
        expect(client.remoteQuery({ target: ref.$ref, method: 'readContent', args: ['/file'] })).toBe(false);
        const node = await transaction.createFile({ name: 'file', parentPath: '/' });
        await transaction.writeContent(node.path, 'committed');
        expect(await transaction.readContent(node.path)).toBe('committed');
    });
    expect(contents.get('/file')).toBe('committed');
});
function session() {
    let changed = () => {};
    const snapshot = { sessionId: 'session', messages: [{ content: 'history '.repeat(4096) }] };
    return { snapshot, changed: () => changed(), getSnapshot: vi.fn(() => snapshot), getSessions: () => [],
        onGlobalEvent: (listener: () => void) => { changed = listener; return () => { changed = () => {}; }; } };
}
it('coalesces streaming changes and sends token deltas instead of repeating long history', async () => {
    const manager = session(); manager.snapshot.messages.push({ content: 'unchanged message' });
    const { root, server, client } = await pair(manager), unchanged = root.getSnapshot().messages[1];
    manager.getSnapshot.mockClear();
    for (let index = 0; index < 100; index++) { manager.snapshot.messages[0].content += 'token '; manager.changed(); }
    const updates = await server.refresh();
    expect(manager.getSnapshot).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updates).length).toBeLessThan(1500);
    expect(JSON.stringify(updates)).toContain('$patch');
    client.applyUpdates(updates);
    expect(root.getSnapshot()).toEqual(manager.snapshot);
    expect(root.getSnapshot().messages[1]).toBe(unchanged);
});
it('buffers out-of-order view patches and ignores stale snapshots', async () => {
    const manager = session(); const { root, server, client } = await pair(manager);
    manager.snapshot.messages[0].content += ' first'; manager.changed(); const first = await server.refresh();
    manager.snapshot.messages[0].content += ' second'; manager.changed(); const second = await server.refresh();
    client.applyUpdates(second);
    expect(root.getSnapshot().messages[0].content).not.toContain(' second');
    client.applyUpdates(first); await client.waitUpdates(second);
    expect(root.getSnapshot()).toEqual(manager.snapshot);
    client.applyUpdates(first); expect(root.getSnapshot()).toEqual(manager.snapshot);
});
it('refreshes previously requested remote status lookups after a scoped subscription event', async () => {
    const listeners = new Set<() => void>(); let observation = { execution: 'idle' };
    const status = { fileVersion: () => undefined, record: () => ({ observation }), get: () => observation,
        subscribe: (project: string, listener: () => void) => { expect(project).toBe('project'); listeners.add(listener); return () => listeners.delete(listener); } };
    const { root, server, client } = await pair(status);
    const release = root.subscribe('project', () => {});
    expect(root.get('project', 'profile', 'session')).toBeUndefined();
    await vi.waitFor(() => expect(root.get('project', 'profile', 'session')).toEqual({ execution: 'idle' }));
    observation = { execution: 'running' }; for (const listener of listeners) listener();
    client.applyUpdates(await server.refresh());
    expect(root.get('project', 'profile', 'session')).toEqual({ execution: 'running' }); release();
});
it('batches independent queries with a bound and preserves individual errors', async () => {
    const send = vi.fn(async (calls: Call[]): Promise<Reply[]> => calls.map(call => call.method === 'missing'
        ? { error: { name: 'Error', message: 'missing' } } : { value: call.args[0] }));
    const batcher = new QueryBatcher(send, () => {});
    const replies = await Promise.all(Array.from({ length: 65 }, (_, index) => batcher.query({ target: 'query', method: index === 2 ? 'missing' : 'read', args: [index] })));
    expect(send.mock.calls.map(([calls]) => calls.length)).toEqual([32, 32, 1]);
    expect(replies[2].error?.message).toBe('missing'); expect(replies[64].value).toBe(64);
});
it('sends ordered notifications with one snapshot refresh per event batch', async () => {
    vi.useFakeTimers(); const write = vi.fn(), refresh = vi.fn(async (): Promise<WireValue[]> => []);
    const queue = new ViewNotifications(() => ({ write, writableLength: 0, destroyed: false } as unknown as ServerResponse), refresh, error => { throw error; });
    for (let index = 0; index < 100; index++) await queue.enqueue({ target: 'listener', method: 'call', args: [index], notification: true });
    await vi.advanceTimersByTimeAsync(16);
    expect(refresh).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    const packet = JSON.parse(write.mock.calls[0][0].slice(6)); expect(packet.calls.map((call: Call) => call.args[0])).toEqual(Array.from({ length: 100 }, (_, index) => index));
    queue.close();
});
it('bounds all notification batches while refresh is blocked and coalesces repeated invalidations', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const stream = { write: vi.fn(), end: vi.fn(), writableLength: 0, destroyed: false };
    const refresh = vi.fn(async () => { await blocked; return []; });
    const queue = new ViewNotifications(() => stream as unknown as ServerResponse, refresh, error => { throw error; });
    await queue.enqueue({ target: 'event', method: 'call', args: [0] }); await vi.advanceTimersByTimeAsync(16);
    for (let index = 1; index <= 200; index++) {
        await queue.enqueue({ target: 'event', method: 'call', args: [index] }); await queue.enqueue();
        await vi.advanceTimersByTimeAsync(16);
    }
    expect(refresh).toHaveBeenCalledTimes(1); expect(stream.write).not.toHaveBeenCalled();
    resume(); await vi.advanceTimersByTimeAsync(16);
    expect(refresh).toHaveBeenCalledTimes(2);
    const values = stream.write.mock.calls.flatMap(([frame]) => JSON.parse(frame.slice(6)).calls.map((call: Call) => call.args[0]));
    expect(values).toEqual(Array.from({ length: 201 }, (_, index) => index)); queue.close();
});
it('includes in-flight notification calls in the queue limit', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    const stream = { write: vi.fn(), end: vi.fn(), writableLength: 0, destroyed: false };
    const queue = new ViewNotifications(() => stream as unknown as ServerResponse, () => new Promise(resolve => { resume = () => resolve([]); }), console.error);
    await queue.enqueue({ target: 'event', method: 'call', args: [] }); await vi.advanceTimersByTimeAsync(16);
    for (let index = 0; index < 256; index++) { await queue.enqueue({ target: 'event', method: 'call', args: [] }); await vi.advanceTimersByTimeAsync(16); }
    expect(stream.end).toHaveBeenCalledOnce(); resume(); await vi.advanceTimersByTimeAsync(16);
    expect(stream.write).not.toHaveBeenCalled(); queue.close();
});
it('bounds concurrent query batches while draining a large read burst', async () => {
    let active = 0, peak = 0;
    const batcher = new QueryBatcher(async calls => {
        active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 0)); active--;
        return calls.map(call => ({ value: call.args[0] }));
    }, () => {});
    const results = await Promise.all(Array.from({ length: 1024 }, (_, index) => batcher.query({ target: 'q', method: 'read', args: [index] })));
    expect(peak).toBe(2); expect(results.at(-1)?.value).toBe(1023);
});
it('treats read commands as queries without invalidating configuration', async () => {
    const model = models(), command = { execute: vi.fn(async () => []), list: () => [] };
    const { root } = await pair({ model, command }); model.getProviders.mockClear();
    await root.command.execute('session.get-sessions'); await root.command.execute('flow.draft.list');
    expect(model.getProviders).not.toHaveBeenCalled();
    await root.command.execute('session.send'); expect(model.getProviders).toHaveBeenCalledOnce();
});
it('does not refresh other conversations for a session management event', async () => {
    const manager = session(), snapshot = vi.fn(() => ({ messages: [] }));
    const { server } = await pair({ manager, other: { snapshot, respond: async () => {} } }); snapshot.mockClear();
    manager.changed(); await server.refresh(); expect(snapshot).not.toHaveBeenCalled();
});
it('re-encodes only the affected message after a scoped streaming event', async () => {
    let event = (_event: unknown) => {}, reads = 0, text = 'before';
    const rows = Array.from({ length: 1000 }, (_, index) => ({ id: `m${index}`, get content() { reads++; return index === 999 ? text : 'stable'; } }));
    const manager = { getSnapshot: () => ({ sessionId: 's', sessions: rows, status: 'running' }), getSessions: () => rows,
        onGlobalEvent: () => () => {}, onEvent: (listener: typeof event) => { event = listener; return () => {}; } };
    const { root, server, client } = await pair(manager); reads = 0;
    const unchanged = root.getSessions()[0]; text = 'before token';
    event({ type: 'message:updated', payload: { messageId: 'm999', delta: ' token', field: 'output' } });
    event({ type: 'stream:content', payload: { delta: ' token' } });
    const updates = await server.refresh(); client.applyUpdates(updates);
    expect(reads).toBe(1); expect(root.getSnapshot().sessions[999].content).toBe(text);
    expect(root.getSessions()[0]).toBe(unchanged); expect(JSON.stringify(updates).length).toBeLessThan(1000);
    reads = 0; text = 'recovered'; event({ type: 'branch:switched', payload: {} });
    client.applyUpdates(await server.refresh());
    expect(reads).toBe(1000); expect(root.getSessions()[999].content).toBe('recovered');
});
it('returns a snapshot reference instead of retransmitting unchanged native history', async () => {
    const snapshot = { messages: Array.from({ length: 1000 }, (_, index) => ({ id: String(index), text: 'x'.repeat(256) })) };
    let server!: RpcPeer, client!: RpcPeer; const replies: Reply[] = [];
    server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', async call => { const reply = await server.handle(call); replies.push(reply); return reply; }); peers.push(server, client);
    const boot = await server.bootstrap({ snapshot: () => snapshot, poll: async () => snapshot, respond: async () => snapshot });
    client.applyUpdates(boot.updates); const root = client.decode(boot.value!);
    expect(await root.poll()).toEqual(snapshot); expect(JSON.stringify(replies.at(-1)).length).toBeLessThan(500);
});
it('bounds notification bytes including a blocked in-flight batch', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    const stream = { write: vi.fn(), end: vi.fn(), writableLength: 0, destroyed: false };
    const queue = new ViewNotifications(() => stream as unknown as ServerResponse, () => new Promise(resolve => { resume = () => resolve([]); }), console.error);
    const call = { target: 'event', method: 'call', args: ['x'.repeat(600_000)] };
    await queue.enqueue(call); await vi.advanceTimersByTimeAsync(16); await queue.enqueue(call);
    expect(stream.end).toHaveBeenCalledOnce(); resume(); await vi.advanceTimersByTimeAsync(16); expect(stream.write).not.toHaveBeenCalled();
});


it('installs earlier event bindings before commands while independent queries remain concurrent', async () => {
    let register!: () => void;
    const gate = new Promise<void>(resolve => {register = resolve;});
    const listeners = new Set<(value: string) => void>(), received = vi.fn();
    const files = {getNode: async () => null, getChildren: async () => [], search: async () => [],
        onAny: (listener: (value: string) => void) => {listeners.add(listener); return () => listeners.delete(listener);},
        writeContent: vi.fn(async () => {for (const listener of listeners) listener('completed');})};
    let client!: RpcPeer;
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', async call => {if (server.binding(call)) await gate; return server.handle(call);});
    peers.push(server, client);
    const boot = await server.bootstrap(files); client.applyUpdates(boot.updates); const root = client.decode(boot.value!);
    const stop = root.onAny(received), sent = root.writeContent('/file', 'content');
    await expect(root.getChildren('/')).resolves.toEqual([]);
    expect(files.writeContent).not.toHaveBeenCalled();
    register(); await sent;
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith('completed'));
    stop();
});
