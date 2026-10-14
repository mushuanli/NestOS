import { expect, it, vi } from 'vitest';
import { TwinAnalysis } from '../src/digital-twin/analysis';

it('reobserves cancellation conflicts without repeating the external cancellation effect', async () => {
    const get = vi.fn().mockResolvedValueOnce({ revision: 1, data: { state: 'running', progress: 0 } })
        .mockResolvedValueOnce({ revision: 2, data: { state: 'running', progress: 1 } })
        .mockResolvedValueOnce({ revision: 3, data: { state: 'cancelled', progress: 1 } })
        .mockResolvedValueOnce({ revision: 4, data: { state: 'cancelled', progress: 2 } });
    const save = vi.fn().mockRejectedValueOnce(new Error('Twin revision conflict')).mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Twin revision conflict')).mockResolvedValueOnce(undefined);
    const cancel = vi.fn(async () => {});
    const analysis = new TwinAnalysis({ get, save } as never, {} as never, { cancel } as never);
    await analysis.cancel('job');
    expect(cancel).toHaveBeenCalledOnce();
    expect(save.mock.calls[1]).toEqual(['job', 'job', expect.objectContaining({ state: 'cancelled', progress: 1 }), 2]);
    expect(save.mock.calls[3]).toEqual(['job', 'job', expect.objectContaining({ cancelConfirmed: true, progress: 2 }), 4]);
});

it('propagates unrelated storage failures without cancelling externally', async () => {
    const failure = new Error('unavailable');
    const get = vi.fn().mockRejectedValue(failure), cancel = vi.fn();
    const analysis = new TwinAnalysis({ get } as never, {} as never, { cancel } as never);
    await expect(analysis.cancel('job')).rejects.toBe(failure);
    expect(get).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled();
});
