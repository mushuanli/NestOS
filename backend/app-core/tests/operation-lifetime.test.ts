import {expect, it} from 'vitest';
import {OperationLifetime} from '../src/run/operation-lifetime';
it('rejects new preparation and waits for the complete admitted operation before closing', async () => {
    const lifetime = new OperationLifetime();
    let release!: () => void, started!: () => void, closed = false;
    const entered = new Promise<void>(resolve => {started = resolve;});
    const work = lifetime.run(async () => {started(); await new Promise<void>(resolve => {release = resolve;}); return 'ready';});
    await entered;
    const closing = lifetime.close().then(() => {closed = true;});
    await expect(lifetime.run(async () => 'late')).rejects.toMatchObject({code: 'SERVICE_STOPPING'});
    expect(closed).toBe(false); release();
    await expect(work).resolves.toBe('ready'); await closing; expect(closed).toBe(true);
});
