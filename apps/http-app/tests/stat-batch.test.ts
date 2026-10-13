import { expect, it, vi } from 'vitest';
import { StatBatch } from '../src/client/stat-batch';
import type { HttpTransport } from '../src/client/transport';

it('merges independent and repeated probes without caching across requests', async () => {
    const call = vi.fn(async (_method, args) => args[0].map(() => ({ type: 'directory' })));
    const batch = new StatBatch({ call } as unknown as HttpTransport);
    expect(await Promise.all([batch.read('/a'), batch.read('/a'), batch.read('/b')])).toEqual([
        { type: 'directory' }, { type: 'directory' }, { type: 'directory' },
    ]);
    expect(call).toHaveBeenCalledExactlyOnceWith('statTypes', [['/a', '/b']], expect.any(AbortSignal));
    call.mockImplementationOnce(async () => null);
    expect(await batch.read('/a')).toBeNull();
    expect(call).toHaveBeenLastCalledWith('statType', ['/a'], expect.any(AbortSignal));
});
it('rejects every waiting probe and permits a later read after failure', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ type: 'directory' });
    const batch = new StatBatch({ call } as unknown as HttpTransport);
    const first = batch.read('/a'), second = batch.read('/b');
    await expect(first).rejects.toThrow('offline'); await expect(second).rejects.toThrow('offline');
    expect(await batch.read('/a')).toEqual({ type: 'directory' });
});

it('cancels one waiter without cancelling the shared transport for its peer', async () => {
    let finish!: (value: unknown) => void;
    const call = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const batch = new StatBatch({ call } as unknown as HttpTransport);
    const controller = new AbortController();
    const cancelled = batch.read('/a', controller.signal), peer = batch.read('/b');
    const rejected = expect(cancelled).rejects.toThrow('cancelled');
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await rejected;
    expect((call.mock.calls[0] as unknown as [string, unknown, AbortSignal])[2].aborted).toBe(false);
    finish([{ type: 'directory' }, { type: 'file' }]);
    expect(await peer).toEqual({ type: 'file' });
});
