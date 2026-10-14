import { expect, it } from 'vitest';
import { mapConcurrent } from '../src/utils/map-concurrent';

it('bounds active work and returns input order despite reverse completion', async () => {
    const started: number[] = [], gates = new Map<number, () => void>();
    const work = mapConcurrent([0, 1, 2, 3], 2, async item => {
        started.push(item);
        await new Promise<void>(resolve => { gates.set(item, resolve); });
        return item * 2;
    });
    expect(started).toEqual([0, 1]);
    gates.get(1)!(); await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates.get(2)!(); await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    gates.get(3)!(); gates.get(0)!();
    expect(await work).toEqual([0, 2, 4, 6]);
});

it('stops queued work on failure and waits for active work before rejecting', async () => {
    let fail!: (error: Error) => void, release!: () => void, settled = false;
    const started: number[] = [];
    const work = mapConcurrent([0, 1, 2], 2, async item => {
        started.push(item);
        await new Promise<void>((resolve, reject) => { if (item === 0) fail = reject; else release = resolve; });
    });
    const observed = work.catch(error => { settled = true; return error; });
    const error = new Error('offline'); fail(error);
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1]); expect(settled).toBe(false);
    release(); expect(await observed).toBe(error);
});

it('does not invoke work for an empty catalog', async () => {
    expect(await mapConcurrent([], 4, async () => { throw new Error('unexpected'); })).toEqual([]);
});
