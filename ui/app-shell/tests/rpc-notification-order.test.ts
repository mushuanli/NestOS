import { expect, it, vi } from 'vitest';
import { RpcPeer, type CapabilityRegistry } from '@itookit/app-transport/rpc';
import { CAPABILITIES } from '@itookit/app-transport/application';

it('transports exact Task pause withdrawal identity and preserves a rejected control epoch', async () => {
    let server!: RpcPeer;
    const errors = vi.fn(), request = {requestId: 'withdraw-original', expectedEpoch: 7};
    const withdrawPause = vi.fn(async (_request: typeof request) => ({epoch: 8, mode: 'run', requestId: request.requestId, acknowledged: false}));
    const client = new RpcPeer('client', call => server.handle(call), errors, undefined, undefined, CAPABILITIES);
    server = new RpcPeer('server', call => client.handle(call), errors, undefined, undefined, CAPABILITIES);
    try {
        const initial = await server.bootstrap({id: 'task', respond: async () => {}, wait: async () => {}, withdrawPause});
        client.applyUpdates(initial.updates); const task = client.decode(initial.value!);
        expect(task.withdrawPause).toBeTypeOf('function');
        expect(await task.withdrawPause(request)).toMatchObject({requestId: request.requestId, epoch: 8, acknowledged: false});
        expect(withdrawPause).toHaveBeenCalledOnce(); expect(withdrawPause).toHaveBeenCalledWith(request);
        withdrawPause.mockRejectedValueOnce(Object.assign(new Error('Control epoch conflict'), {code: 'CONFLICT'}));
        await expect(task.withdrawPause({...request, requestId: 'withdraw-stale'})).rejects.toMatchObject({code: 'CONFLICT'});
        expect(withdrawPause).toHaveBeenCalledTimes(2);
        expect(errors).not.toHaveBeenCalled();
    } finally {await client.close(); await server.close();}
});

it('transports the current HarnessClient observation API and releases subscriptions', async () => {
    let server!: RpcPeer, notify!: () => void;
    const release = vi.fn(), errors = vi.fn();
    const client = new RpcPeer('client', call => server.handle(call), errors, undefined, undefined, CAPABILITIES);
    server = new RpcPeer('server', call => client.handle(call), errors, undefined, undefined, CAPABILITIES);
    try {
        const initial = await server.bootstrap({ profiles: async () => ({ profiles: [] }), list: async () => ({ sessions: [] }),
            subscribe: (_id: string, listener: () => void) => { notify = listener; return release; },
            eventSnapshot: async () => ({ epoch: 'e', cursor: 1, events: [] }), close: async () => {} });
        client.applyUpdates(initial.updates); const source = client.decode(initial.value!);
        const received = vi.fn(), stop = source.subscribe('p', received); await client.whenIdle();
        notify(); await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
        expect(await source.eventSnapshot('p')).toMatchObject({ epoch: 'e', cursor: 1 });
        stop(); await client.whenIdle(); expect(release).toHaveBeenCalledOnce(); expect(errors).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
});

it('preserves observer event order when an earlier payload takes longer to encode', async () => {
    const schemas: CapabilityRegistry = { Source: { markers: ['subscribe'], fields: [], methods: { subscribe: 'subscribe' } } };
    let listener!: (event: unknown) => void, server!: RpcPeer;
    const errors = vi.fn(), received: Array<{sequence: number}> = [];
    const client = new RpcPeer('client', call => server.handle(call), errors, undefined, undefined, schemas);
    server = new RpcPeer('server', call => client.handle(call), errors, undefined, undefined, schemas);
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const payload = new Blob(['delayed']);
    const bytes = payload.arrayBuffer.bind(payload);
    vi.spyOn(payload, 'arrayBuffer').mockImplementation(async () => { await ready; return bytes(); });
    try {
        const initial = await server.bootstrap({ subscribe: (next: typeof listener) => { listener = next; return () => {}; } });
        client.applyUpdates(initial.updates);
        const source = client.decode(initial.value!);
        const stop = source.subscribe((event: {sequence: number}) => { received.push(event); });
        await client.whenIdle();
        listener({ sequence: 1, payload }); listener({ sequence: 2 });
        await Promise.resolve(); expect(received).toEqual([]);
        finish();
        await vi.waitFor(() => expect(received.map(event => event.sequence)).toEqual([1, 2]));
        expect(errors).not.toHaveBeenCalled(); stop();
    } finally { finish(); await client.close(); await server.close(); }
});

it.each(['dag.run', 'session.call'])('reads %s remaining-tree admission over RPC while its write awaits cleanup', async namespace => {
    let server!: RpcPeer, release!: () => void;
    const held = new Promise<void>(resolve => {release = resolve;}), errors = vi.fn();
    const receipt = {requestId: 'stop', taskId: 'root', expectedEpoch: 0, controlEpoch: 0, rootStatus: 'succeeded', acceptedAt: 1, taskCount: 3};
    const execute = vi.fn(async (name: string) => {
        if (name === `${namespace}.cancel-remaining`) {await held; return {taskId: 'root', receipt};}
        return receipt;
    });
    const classifications: Array<[unknown, boolean]> = [];
    const client = new RpcPeer('client', call => {classifications.push([call.args[0], server.query(call)]); return server.handle(call);}, errors, undefined, undefined, CAPABILITIES);
    server = new RpcPeer('server', call => client.handle(call), errors, undefined, undefined, CAPABILITIES);
    let pending: Promise<unknown> | undefined, observed: unknown, finished = false;
    try {
        const initial = await server.bootstrap({execute, list: () => []});
        client.applyUpdates(initial.updates); const commands = client.decode(initial.value!);
        pending = commands.execute(`${namespace}.cancel-remaining`, {sessionId: 'session', taskId: 'root', requestId: 'stop', expectedEpoch: 0})
            .then((value: unknown) => {finished = true; return value;});
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        const query = commands.execute(`${namespace}.tree-cancellation.receipt`, {sessionId: 'session', taskId: 'root', requestId: 'stop'})
            .then((value: unknown) => {observed = value;});
        await vi.waitFor(() => expect(observed).toEqual(receipt)); expect(finished).toBe(false);
        expect(classifications).toContainEqual([`${namespace}.cancel-remaining`, false]);
        expect(classifications).toContainEqual([`${namespace}.tree-cancellation.receipt`, true]);
        expect(errors).not.toHaveBeenCalled(); await query;
    } finally {release(); await pending; await client.close(); await server.close();}
});
