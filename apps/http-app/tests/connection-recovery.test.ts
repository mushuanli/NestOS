import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionRecovery } from '../src/client/connection-recovery';

const recoveries: ConnectionRecovery[] = [];
afterEach(() => { recoveries.splice(0).forEach(value => value.stop()); vi.useRealTimers(); });
function recovery(check: (signal: AbortSignal) => Promise<boolean>, ready = vi.fn()) {
    const value = new ConnectionRecovery(check, ready); recoveries.push(value); return { value, ready };
}

it('stays idle until disconnected and probes with bounded backoff until ready', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const times: number[] = [];
    const check = vi.fn(async () => { times.push(Date.now()); return times.length === 6; });
    const { value, ready } = recovery(check);
    value.retry(); expect(check).not.toHaveBeenCalled();
    value.start(); value.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(times).toEqual([0, 1000, 3000, 7000, 15000, 30000]); expect(ready).toHaveBeenCalledOnce();
    value.start(); value.retry(); await vi.advanceTimersByTimeAsync(60000);
    expect(check).toHaveBeenCalledTimes(6); expect(vi.getTimerCount()).toBe(0);
});

it('wakes a waiting retry without starting parallel probes', async () => {
    vi.useFakeTimers(); let finish!: (ready: boolean) => void;
    const check = vi.fn().mockResolvedValueOnce(false).mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const { value, ready } = recovery(check); value.start(); await vi.advanceTimersByTimeAsync(0);
    value.retry(); value.retry(); await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    value.retry(); value.start(); expect(check).toHaveBeenCalledTimes(2);
    finish(true); await vi.advanceTimersByTimeAsync(0); expect(ready).toHaveBeenCalledOnce();
});

it('treats probe failures as unavailable and cancels the pending retry on disposal', async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockRejectedValue(new Error('unavailable'));
    const { value, ready } = recovery(check); value.start(); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); value.stop();
    await vi.advanceTimersByTimeAsync(60000); value.start();
    expect(check).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('aborts an active probe and ignores its late success', async () => {
    vi.useFakeTimers(); let finish!: (ready: boolean) => void, signal!: AbortSignal;
    const { value, ready } = recovery(current => { signal = current; return new Promise(resolve => { finish = resolve; }); });
    value.start(); value.stop(); expect(signal.aborted).toBe(true);
    finish(true); await vi.advanceTimersByTimeAsync(0);
    expect(ready).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
