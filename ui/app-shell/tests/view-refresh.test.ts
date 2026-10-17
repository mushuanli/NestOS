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
