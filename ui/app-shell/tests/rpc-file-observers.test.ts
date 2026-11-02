import {expect, it, vi} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/application';
import type {FSEvent} from '@itookit/vfs-core';
import {shareFileObservers} from '../../../shared/app-transport/src/application/file-observers';

it('shares remote filesystem observations across event types and releases only the final interest', async () => {
    const listeners = new Set<(event: FSEvent) => void>(), releases = vi.fn();
    const onAny = vi.fn((listener: (event: FSEvent) => void) => {listeners.add(listener); return () => {listeners.delete(listener); releases();};});
    const source = {viewId: 'test', revision: 0, driver: {}, meta: {}, capabilities: {}, onAny, on() {throw new Error('Typed remote observers should be local');}};
    let server!: RpcPeer; const errors = vi.fn();
    const client = new RpcPeer('client', call => server.handle(call), errors);
    server = new RpcPeer('server', call => client.handle(call), errors);
    try {
        const boot = await server.bootstrap(source); client.applyUpdates(boot.updates); const fs = client.decode(boot.value!);
        const baseline = onAny.mock.calls.length, first = vi.fn(), second = vi.fn(), any = vi.fn();
        const a = fs.on('node:created', first), b = fs.on('node:deleted', second), c = fs.onAny(any); await client.whenIdle();
        expect(onAny).toHaveBeenCalledTimes(baseline + 1);
        for (const listener of listeners) listener({type: 'node:created', payload: {nodes: []}} as unknown as FSEvent);
        await vi.waitFor(() => expect(any).toHaveBeenCalledOnce()); expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
        a(); b(); await client.whenIdle(); expect(releases).not.toHaveBeenCalled();
        c(); c(); await client.whenIdle(); expect(releases).toHaveBeenCalledOnce(); expect(errors).not.toHaveBeenCalled();
    } finally {await client.close(); await server.close();}
});
it('does not deliver a retiring connection to new interests, and counts identical callbacks independently', () => {
    const callbacks: Array<(event: FSEvent) => void> = [], stop = vi.fn();
    const fs = {onAny: (listener: (event: FSEvent) => void) => {callbacks.push(listener); return stop;}}; shareFileObservers(fs);
    const listener = vi.fn(), a = fs.onAny(listener), b = fs.onAny(listener); a(); callbacks[0]({} as FSEvent);
    expect(listener).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled(); b(); const c = fs.onAny(listener);
    callbacks[0]({} as FSEvent); expect(listener).toHaveBeenCalledOnce(); callbacks[1]({} as FSEvent); expect(listener).toHaveBeenCalledTimes(2); c();
});
it('allows a new interest to retry failed registration and delivers all listeners before reporting a failure', async () => {
    const callbacks: Array<(event: FSEvent) => void> = [], ready = Promise.reject(new Error('Registration failed'));
    const fs = {onAny: (listener: (event: FSEvent) => void) => {callbacks.push(listener); return Object.assign(() => {}, {ready: callbacks.length === 1 ? ready : Promise.resolve()});}};
    shareFileObservers(fs); const first = fs.onAny(() => {throw new Error('Listener failed');}); await Promise.resolve();
    const listener = vi.fn(), second = fs.onAny(listener); expect(callbacks).toHaveLength(2);
    expect(() => callbacks[1]({} as FSEvent)).toThrow('Listener failed'); expect(listener).toHaveBeenCalledOnce(); first(); second();
});
it('preserves interests when descriptor hydration replaces the raw proxy methods', () => {
    let callback!: (event: FSEvent) => void;
    const oldStop = vi.fn(), first = vi.fn(), second = vi.fn(), nextSubscribe = vi.fn(() => vi.fn());
    const fs = {onAny: (listener: typeof callback) => {callback = listener; return oldStop;}};
    shareFileObservers(fs); const a = fs.onAny(first); fs.onAny = nextSubscribe; shareFileObservers(fs); const b = fs.onAny(second);
    expect(nextSubscribe).not.toHaveBeenCalled(); callback({} as FSEvent); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    a(); b(); expect(oldStop).toHaveBeenCalledOnce(); const c = fs.onAny(first); expect(nextSubscribe).toHaveBeenCalledOnce(); c();
});
