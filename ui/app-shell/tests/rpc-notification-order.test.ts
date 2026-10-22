import { expect, it, vi } from 'vitest';
import { RpcPeer, type CapabilityRegistry } from '@itookit/app-transport/rpc';
import { CAPABILITIES } from '@itookit/app-transport/application';

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
