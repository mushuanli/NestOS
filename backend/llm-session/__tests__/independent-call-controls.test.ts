import {expect, it, vi} from 'vitest';
import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import type {ICommandBus} from '../src/contracts/command-bus';
import {IndependentCallCommand} from '../src/contracts/independent-calls';
import {IndependentCallControls} from '../src/session/independent-call-controls';

const query = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'task', requestId: 'cancel'};
function fixture() {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const cancel = vi.fn(async () => {}), read = vi.fn(async () => ({taskId: 'task', requestId: 'cancel', expectedEpoch: 0, controlEpoch: 0, status: 'cancelled' as const}));
    const logger = {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()};
    const resolve = vi.fn(async () => ({program: {kind: 'agent.loop'}} as TaskRecord));
    const commands = {register: (name: string, handler: (args: any) => Promise<any>) => handlers.set(name, handler)} as unknown as ICommandBus;
    new IndependentCallControls({commands, logger, resolve, kernel: {cancel, readTaskCancellationReceipt: read} as unknown as Kernel}).register();
    return {handlers, cancel, read, logger, resolve};
}
it('rejects invalid input before resolving ownership and logs only safe metadata', async () => {
    const f = fixture();
    await expect(f.handlers.get(IndependentCallCommand.Cancel)!({...query, requestId: 'PRIVATE PROMPT', expectedEpoch: -1}))
        .rejects.toMatchObject({code: 'CALL_CONTROL_INVALID'});
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({stage: 'validate', code: 'CALL_CONTROL_INVALID'}));
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('PRIVATE PROMPT');
});
it('does not expose adapter errors or treat a mismatched receipt as admission', async () => {
    const f = fixture(); f.cancel.mockRejectedValueOnce(new Error('PRIVATE REMOTE ERROR'));
    await expect(f.handlers.get(IndependentCallCommand.Cancel)!({...query, expectedEpoch: 0})).rejects.toThrow('PRIVATE REMOTE ERROR');
    expect(f.logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({stage: 'cancel', code: 'CALL_CONTROL_FAILED', operationId: 'cancel'}));
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('PRIVATE REMOTE ERROR');
    f.read.mockResolvedValueOnce({taskId: 'other', requestId: 'cancel', expectedEpoch: 0, controlEpoch: 0, status: 'cancelled'});
    await expect(f.handlers.get(IndependentCallCommand.CancellationReceipt)!(query)).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    expect(f.cancel).toHaveBeenCalledTimes(1);
});
it('keeps the durable outcome when the diagnostic observer throws', async () => {
    const f = fixture(); f.logger.info.mockImplementation(() => {throw new Error('Logger failed');});
    expect(await f.handlers.get(IndependentCallCommand.Cancel)!({...query, expectedEpoch: 0})).toMatchObject({...query, receipt: {status: 'cancelled'}});
    expect(f.cancel).toHaveBeenCalledWith('child', 'task', 'Cancelled from independent call', {requestId: 'cancel', expectedEpoch: 0});
});
