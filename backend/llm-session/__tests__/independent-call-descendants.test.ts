import {expect, it, vi} from 'vitest';
import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import {IndependentCallDescendants} from '../src/session/independent-call-descendants';
const query = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'root'};
function fixture() {
    const root = {id: 'root', rootTaskId: 'root', sessionId: 'child', version: 1, status: 'created', effects: {}, interactions: {}, program: {kind: 'task'}} as TaskRecord;
    const snapshot = vi.fn(async () => ({tasks: [root], asOfSequence: 12})), resolve = vi.fn(async () => root);
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
    const kernel = {inspectSession: vi.fn(async () => ({snapshot}))} as unknown as Kernel;
    return {reader: new IndependentCallDescendants(kernel, logger, resolve), resolve, logger, snapshot};
}
it('validates a bounded cursor and public fields before touching the route', async () => {
    const f = fixture();
    for (const extra of [{afterTaskId: ''}, {afterTaskId: 3}, {afterTaskId: 'a'.repeat(513)}, {parameters: 'PRIVATE BODY'}, {requestId: 'unexpected'}])
        await expect(f.reader.read({...query, ...extra} as never)).rejects.toMatchObject({code: 'CALL_DESCENDANTS_QUERY_INVALID'});
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.snapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('PRIVATE BODY');
});
it('reads the original scope and sequence, and diagnostic failures cannot change the result', async () => {
    const f = fixture(); f.logger.debug.mockImplementation(() => {throw new Error('observer');});
    expect(await f.reader.read(query)).toEqual({...query, asOfSequence: 12, descendants: {total: 0, items: []}});
    f.snapshot.mockRejectedValueOnce(Object.assign(new Error('PRIVATE STORAGE'), {code: 'STORAGE_CORRUPT'}));
    await expect(f.reader.read(query)).rejects.toMatchObject({code: 'STORAGE_CORRUPT'});
    expect(f.logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({stage: 'snapshot', code: 'STORAGE_CORRUPT', operationId: 'call'}));
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('PRIVATE STORAGE');
});
