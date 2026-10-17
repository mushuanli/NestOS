import {afterEach, expect, expectTypeOf, it, vi} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/application';
import type {ApplicationServices, ApplicationViewEvent, ApplicationViewObservation, LocalApplicationServices} from '@itookit/app-contracts/services';
import {ViewObservation} from '../../../backend/app-core/src/host/view-observation';

const peers: RpcPeer[] = [];
afterEach(async () => {await Promise.all(peers.splice(0).map(peer => peer.close()));});
async function pair(value: unknown) {
    const server = new RpcPeer('server', async () => ({})), client = new RpcPeer('client', call => server.handle(call));
    peers.push(server, client);
    const boot = await server.bootstrap(value); client.applyUpdates(boot.updates);
    return {server, client, root: client.decode(boot.value!)};
}

it('transports a contract-only observation and preserves the cursor returned with its baseline', async () => {
    let listener!: (event: ApplicationViewEvent) => void, cursor = 3;
    const stop = vi.fn(), snapshot = {sessionId: 's', sessions: [], status: 'idle' as const, isRunning: false};
    const observation: ApplicationViewObservation = {
        getViewCursor: () => cursor,
        getSessionBaseline: () => ({cursor: 2, snapshot}),
        observeView: vi.fn(async (_after, next) => {listener = next; return stop;}), dispose: async () => {},
    };
    const {server, client, root} = await pair(observation);
    expect(observation.observeView).toHaveBeenCalledWith(3, expect.any(Function));
    expect(root.getSessionBaseline()).toEqual({cursor: 2, snapshot});
    cursor = 4; listener({sequence: cursor, topic: 'files', value: undefined});
    client.applyUpdates(await server.refresh());
    expect(root.getViewCursor()).toBe(4); expect(root.getSessionBaseline().cursor).toBe(2);
    await server.close(); expect(stop).toHaveBeenCalledOnce();
});

it('re-encodes only the changed baseline row through the public host observation', async () => {
    let event!: (value: unknown) => void, reads = 0, text = 'before';
    const rows = Array.from({length: 1000}, (_, index) => ({id: `m${index}`, get content() {reads++; return index === 999 ? text : 'stable';}}));
    const subscribe = () => () => {};
    const observation = new ViewObservation({sessionRepository: {subscribe}, sessionFiles: {subscribe}, kernel: {kernel: {onChanged: subscribe}},
        agentService: {onChange: subscribe}, sessionManager: {onGlobalEvent: subscribe, onEvent: (next: typeof event) => {event = next; return subscribe();},
            getSnapshot: () => ({sessionId: 's', sessions: rows, status: 'running', isRunning: true})}} as never);
    try {
        const {server, client, root} = await pair(observation);
        const initial = root.getSessionBaseline(); reads = 0; text += ' token';
        event({type: 'message:updated', payload: {messageId: 'm999', field: 'output', delta: ' token'}});
        event({type: 'stream:content', payload: {delta: ' token'}});
        const updates = await server.refresh(); client.applyUpdates(updates);
        expect(reads).toBe(1); expect(JSON.stringify(updates).length).toBeLessThan(1500);
        const current = root.getSessionBaseline();
        expect(current.cursor).toBe(2); expect(current.snapshot.sessions[999].content).toBe(text);
        expect(current.snapshot.sessions[0]).toEqual(initial.snapshot.sessions[0]);
        expect(initial.snapshot.sessions[999].content).toBe('before');
        event({type: 'branch:switched', payload: {}}); reads = 0;
        client.applyUpdates(await server.refresh()); expect(reads).toBe(1000);
    } finally {await observation.dispose();}
});

it('propagates asynchronous observer registration failures and can register a replacement', async () => {
    const stop = vi.fn(), subscribe = vi.fn().mockRejectedValueOnce(new Error('Registration failed')).mockResolvedValue(stop);
    const observation: ApplicationViewObservation = {getViewCursor: () => 0,
        getSessionBaseline: () => ({cursor: 0, snapshot: {sessionId: '', sessions: [], status: 'idle', isRunning: false}}),
        observeView: subscribe, dispose: async () => {}};
    const server = new RpcPeer('server', async () => ({})); peers.push(server);
    await expect(server.bootstrap(observation)).rejects.toThrow('Registration failed');
    await expect(server.bootstrap(observation)).resolves.toHaveProperty('value');
    await server.close(); expect(stop).toHaveBeenCalledOnce();
});

it('releases an observer whose asynchronous registration finishes after peer shutdown', async () => {
    const stop = vi.fn(); let resolve!: (release: () => void) => void, started!: () => void;
    const ready = new Promise<void>(done => {started = done;});
    const observation: ApplicationViewObservation = {getViewCursor: () => 0,
        getSessionBaseline: () => ({cursor: 0, snapshot: {sessionId: '', sessions: [], status: 'idle', isRunning: false}}),
        observeView: () => {started(); return new Promise(done => {resolve = done;});}, dispose: async () => {}};
    const server = new RpcPeer('server', async () => ({})); peers.push(server);
    const result = server.bootstrap(observation).catch((error: unknown) => error);
    await ready; await server.close(); resolve(stop);
    expect(await result).toMatchObject({code: 'EIO'}); expect(stop).toHaveBeenCalledOnce();
});

it('keeps storage inspection in the host contract and out of remote kernel capabilities', async () => {
    expectTypeOf<ApplicationServices['kernel']['kernel']>().not.toHaveProperty('inspectSession');
    expectTypeOf<LocalApplicationServices['kernel']['kernel']>().toHaveProperty('inspectSession');
    const inspectSession = vi.fn(async () => ({}));
    const {root} = await pair({openSession: async () => {}, openTask: async () => {}, inspectSession});
    expect(root.inspectSession).toBeUndefined(); expect(inspectSession).not.toHaveBeenCalled();
});
