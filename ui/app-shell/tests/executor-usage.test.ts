import { expect, it, vi } from 'vitest';
import { ExecutorUsage } from '../src/persistence/executor-usage';

it('loads recency lazily once, ignores invalid values and persists actual usage independently of configuration', async () => {
    const read = vi.fn(async () => ({writer: 10, reviewer: 20, invalid: 'later', negative: -1})), write = vi.fn();
    const usage = new ExecutorUsage({read, write}); expect(read).not.toHaveBeenCalled();
    await Promise.all([usage.load(), usage.load()]); expect(read).toHaveBeenCalledOnce();
    expect(usage.lastUsed('writer')).toBe(10); expect(usage.lastUsed('invalid')).toBe(0);
    const changed = vi.fn(), stop = usage.subscribe(changed);
    usage.record('writer'); expect(usage.lastUsed('writer')).toBeGreaterThan(usage.lastUsed('reviewer'));
    expect(write).toHaveBeenCalledWith('mindos_executor_usage_v1', expect.objectContaining({writer: usage.lastUsed('writer')}));
    expect(changed).toHaveBeenCalledOnce(); stop(); usage.record('reviewer'); expect(changed).toHaveBeenCalledOnce();
});

it('preserves usage recorded during an earlier stored document read', async () => {
    let resolve!: (data: unknown) => void;
    const usage = new ExecutorUsage({read: () => new Promise(done => { resolve = done; }), write: vi.fn()});
    const loaded = usage.load(); usage.record('writer'); const recent = usage.lastUsed('writer');
    resolve({writer: 1}); await loaded; expect(usage.lastUsed('writer')).toBe(recent);
});
