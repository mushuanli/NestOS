import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApplicationPort, ApplicationEvent } from '@itookit/app-contracts/application';
import { ApplicationEvents } from '../src/server/application-events';

afterEach(() => vi.useRealTimers());
function source() {
    let listener!: (event: ApplicationEvent) => void;
    const release = vi.fn();
    const port = { subscribe: (value: typeof listener) => { listener = value; return release; } } as unknown as ApplicationPort;
    return { port, release, emit: (revision: number) => listener({ kind: 'invalidate', scope: 'sessions', revision }) };
}
function response() {
    const emitter = new EventEmitter(), frames: string[] = [];
    const state = { destroyed: false, writableLength: 0, writeHead: vi.fn(), flushHeaders: vi.fn(),
        write: (frame: string) => { frames.push(frame); return true; },
        destroy: () => { state.destroyed = true; emitter.emit('close'); }, end: () => { emitter.emit('close'); },
        once: emitter.once.bind(emitter) };
    return { response: state as unknown as ServerResponse, frames, state };
}
it('replays only events after a cursor and invalidates a gap without reissuing commands', () => {
    const events = new ApplicationEvents(2), owner = source(), first = response();
    events.attach('client', owner.port, first.response);
    const cursor = first.frames[0].split('\n')[0].slice(4);
    owner.emit(1); const latest = first.frames.at(-1)!.split('\n')[0].slice(4); first.state.end();
    owner.emit(2); const reconnected = response(); events.attach('client', owner.port, reconnected.response, latest);
    expect(reconnected.frames).toHaveLength(1); expect(reconnected.frames[0]).toContain('"revision":2'); reconnected.state.end();
    owner.emit(3); const gap = response(); events.attach('client', owner.port, gap.response, cursor);
    expect(gap.frames).toHaveLength(1); expect(gap.frames[0]).toContain('"scope":"all"');
    events.close(); expect(owner.release).toHaveBeenCalledOnce(); expect(events.active('client')).toBe(false);
});
it('bounds replay by bytes as well as event count', () => {
    const events = new ApplicationEvents(256, 1), owner = source(), first = response();
    events.attach('client', owner.port, first.response); const cursor = first.frames[0].split('\n')[0].slice(4); first.state.end();
    owner.emit(1); const resumed = response(); events.attach('client', owner.port, resumed.response, cursor);
    expect(resumed.frames).toHaveLength(1); expect(resumed.frames[0]).toContain('"scope":"all"'); events.close();
});
it('ends an existing event connection when certificate authorization is revoked', async () => {
    vi.useFakeTimers();
    const events = new ApplicationEvents(), owner = source(), stream = response(), authorize = vi.fn(async () => false);
    events.attach('client', owner.port, stream.response, undefined, authorize);
    await vi.advanceTimersByTimeAsync(15000);
    expect(authorize).toHaveBeenCalledOnce(); expect(stream.state.destroyed).toBe(true);
    expect(events.active('client')).toBe(false); events.close();
});
