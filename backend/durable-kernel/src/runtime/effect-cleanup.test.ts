import { afterEach, expect, it, vi } from 'vitest';
import { EffectCleanupRunner } from './effect-cleanup';

afterEach(() => vi.useRealTimers());

it('times out without overlapping cleanup and permits other Effects to finish', async () => {
    vi.useFakeTimers();
    const runner = new EffectCleanupRunner(20);
    let finish!: () => void;
    const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = expect(runner.run('one', cleanup)).rejects.toThrow('cleanup timed out');
    await vi.advanceTimersByTimeAsync(20);
    await first;
    const second = runner.run('one', cleanup);
    await runner.run('other', async () => {});
    expect(cleanup).toHaveBeenCalledTimes(1);
    finish();
    await second;
    expect(vi.getTimerCount()).toBe(0);
});

it('releases failed cleanup so a subsequent attempt can confirm completion', async () => {
    const runner = new EffectCleanupRunner(20);
    await expect(runner.run('one', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(runner.run('one', async () => {})).resolves.toBeUndefined();
});

it.each([0, -1, NaN, Infinity, 0.5, 2147483648])('rejects invalid cleanup timeout %s', value => {
    expect(() => new EffectCleanupRunner(value)).toThrow('effectCleanupTimeoutMs');
});
