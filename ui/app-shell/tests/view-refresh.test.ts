import { afterEach, expect, it, vi } from 'vitest';
import { ViewRefresh } from '../src/lifecycle/view-refresh';

afterEach(() => { vi.useRealTimers(); });

it('retains hidden invalidations and coalesces them when the view becomes visible', async () => {
    vi.useFakeTimers(); let visible = false;
    const run = vi.fn(async () => {}), refresh = new ViewRefresh({ visible: () => visible, run, report: vi.fn() });
    refresh.mark('repository'); refresh.mark('files'); await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled(); expect(refresh.dirty).toBe(true);
    visible = true; await refresh.flush();
    expect(run).toHaveBeenCalledExactlyOnceWith(['repository', 'files']); expect(refresh.dirty).toBe(false);
    await refresh.close();
});

it('serializes refreshes, preserves changes during an in-flight read and joins explicit refresh', async () => {
    vi.useFakeTimers(); let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const run = vi.fn(async () => { if (run.mock.calls.length === 1) await gate; });
    const refresh = new ViewRefresh({ visible: () => true, run, report: vi.fn() });
    refresh.mark('first'); const first = refresh.flush(); await Promise.resolve();
    refresh.mark('second'); const second = refresh.flush();
    expect(run).toHaveBeenCalledOnce(); finish(); await Promise.all([first, second]);
    expect(run.mock.calls.map(args => args[0])).toEqual([['first'], ['second']]);
    await refresh.close();
});

it('retains failed refreshes for explicit retry and cancels scheduled work on close', async () => {
    vi.useFakeTimers(); const failure = new Error('Offline'), report = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const refresh = new ViewRefresh({ visible: () => true, run, report });
    refresh.mark('changed'); await refresh.flush(); expect(report).toHaveBeenCalledWith(failure); expect(refresh.dirty).toBe(true);
    await refresh.flush(); expect(refresh.dirty).toBe(false);
    refresh.mark('later'); await refresh.close(); await vi.runAllTimersAsync(); expect(run).toHaveBeenCalledTimes(2);
});

it('retries a failed snapshot without needing another event and backs off while keeping hidden views idle', async () => {
    vi.useFakeTimers(); let visible = true;
    const run = vi.fn().mockRejectedValueOnce({code: 'EIO'}).mockRejectedValueOnce({code: 'EIO'}).mockResolvedValue(undefined);
    const refresh = new ViewRefresh({visible: () => visible, run, report: vi.fn()});
    refresh.mark('events'); await refresh.flush();
    await vi.advanceTimersByTimeAsync(999); expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    visible = false; refresh.pause(); await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(2); expect(refresh.dirty).toBe(true);
    visible = true; await refresh.flush(); expect(run).toHaveBeenCalledTimes(3); expect(refresh.dirty).toBe(false);
    await refresh.close(); expect(vi.getTimerCount()).toBe(0);
});

it('retains an authorization failure for an explicit refresh without retrying it in a loop', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue({code: 'EACCES'});
    const refresh = new ViewRefresh({visible: () => true, run, report: vi.fn()});
    refresh.mark('events'); await refresh.flush(); await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledOnce(); expect(refresh.dirty).toBe(true);
    await refresh.close();
});
