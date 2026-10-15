import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectRemoteMountPort } from '@itookit/app-contracts/services';
import { observeConnections } from '../../src/host/connection-observation';

afterEach(() => vi.useRealTimers());
function fixture() {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const mounted = new Set(['remote']);
    const checkConnections = vi.fn(async (_id: string, _options?: { signal?: AbortSignal }) => {});
    const remote = { list: (id: string) => mounted.has(id) ? [{ mountId: id, at: '/' }] : [], checkConnections,
        onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as ProjectRemoteMountPort;
    return { remote, checkConnections, mounted, listeners };
}
it('shares probes across browsers, excludes local projects and stops after the last observer', async () => {
    const f = fixture(), first = observeConnections(f.remote), second = observeConnections(f.remote);
    f.mounted.add('other');
    await first.update(['remote', 'other', 'local'], 1); await second.update(['remote'], 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.checkConnections.mock.calls.map(([id]) => id)).toEqual(['remote', 'other']);
    await first.dispose(); await vi.advanceTimersByTimeAsync(0); expect(f.checkConnections).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000); expect(f.checkConnections).toHaveBeenCalledTimes(3);
    await second.dispose(); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.checkConnections).toHaveBeenCalledTimes(3); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it('ignores late interest updates and starts checking a newly mounted observed project', async () => {
    const f = fixture(), observer = observeConnections(f.remote);
    await observer.update(['later'], 2); await observer.update(['remote'], 1);
    await vi.advanceTimersByTimeAsync(0); expect(f.checkConnections).not.toHaveBeenCalled();
    f.mounted.add('later'); for (const listener of f.listeners) listener();
    await vi.advanceTimersByTimeAsync(0); expect(f.checkConnections.mock.calls.map(([id]) => id)).toEqual(['later']);
    await observer.update([], 3); await observer.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it('bounds project concurrency and aborts outstanding probes when interests disappear', async () => {
    const f = fixture(), observer = observeConnections(f.remote), ids = Array.from({ length: 12 }, (_, index) => String(index));
    ids.forEach(id => f.mounted.add(id));
    const signals: AbortSignal[] = [];
    f.checkConnections.mockImplementation(async (_id, options) => {
        const signal = options!.signal!; signals.push(signal);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await observer.update(ids, 1); expect(signals).toHaveLength(4);
    await observer.dispose(); await vi.advanceTimersByTimeAsync(0);
    expect(signals.every(signal => signal.aborted)).toBe(true); expect(f.checkConnections).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
});
