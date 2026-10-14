import { afterEach, expect, it, vi } from 'vitest';
import { FSError } from '@itookit/vfs-core';
import { readProgress } from '../src/digital-twin/read-progress';
import { TwinAnalysis } from '../src/digital-twin/analysis';

const job = { sessionId: 's', connectionId: 'c' };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('reads a fresh snapshot after a conflict and records the retry context', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const read = vi.fn().mockRejectedValueOnce(new FSError('ECONFLICT', 'changed')).mockResolvedValue({ throughIndex: 2 });
    const result = readProgress(read, job, 'task');
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ throughIndex: 2 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('[DigitalTwin]', expect.objectContaining({ stage: 'diagnostic_retry', taskId: 'task', attempt: 1 }));
});

it('bounds conflict retries and preserves the last failure', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = new FSError('ECONFLICT', 'changed');
    const read = vi.fn().mockRejectedValue(error);
    const rejected = expect(readProgress(read, job, 'task')).rejects.toBe(error);
    await vi.runAllTimersAsync(); await rejected;
    expect(read).toHaveBeenCalledTimes(4);
});

it('does not retry an IO failure', async () => {
    const error = new FSError('EIO', 'unavailable'), read = vi.fn().mockRejectedValue(error);
    await expect(readProgress(read, job, 'task')).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
});

function authorizationHost(sessionId = 'twin-analysis-job', state = 'running') {
    const data = { sessionId, state, connectionId: 'c', sourceId: 'source', sourceRevision: 'r', sourceHash: 'h', epoch: 1,
        scanScope: { sourceId: 'source' } };
    const get = vi.fn(async (family: string) => family === 'job' ? { id: 'job', data } : null);
    const records = { get, list: vi.fn(), store: { inspect: async () => ({ forgetEpoch: 1 }) } };
    const sources = { readCurrent: async () => ({ source: { revision: 'r', data: { hash: 'h', connectionId: 'c' } } }) };
    type Args = ConstructorParameters<typeof TwinAnalysis>;
    const analysis = new TwinAnalysis(records as unknown as Args[0], sources as unknown as Args[1], {} as Args[2],
        () => {}, async () => ({ conditions: [], writes: [] }));
    return { analysis, records };
}

it('authorizes only the current job and retries a conflicting read', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'info').mockImplementation(() => {});
    const { analysis, records } = authorizationHost();
    records.get.mockRejectedValueOnce(new FSError('ECONFLICT', 'changed'));
    const result = analysis.authorize('twin-analysis-job', 'c');
    await vi.runAllTimersAsync(); await expect(result).resolves.toBeUndefined();
    expect(records.get).toHaveBeenCalledWith('job', 'job');
    expect(records.list).not.toHaveBeenCalled();
});

it('still rejects a mismatched session or a cancelled job', async () => {
    await expect(authorizationHost('twin-analysis-other').analysis.authorize('twin-analysis-job', 'c'))
        .rejects.toThrow('TWIN_ANALYSIS_PERMISSION_DENIED');
    await expect(authorizationHost('twin-analysis-job', 'cancelled').analysis.authorize('twin-analysis-job', 'c'))
        .rejects.toThrow('TWIN_ANALYSIS_PERMISSION_DENIED');
});
