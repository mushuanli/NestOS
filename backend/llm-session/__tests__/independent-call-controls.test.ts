import {FlowCommand} from '@itookit/llm-flow/contracts';
import {expect, it, vi} from 'vitest';
import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import type {ICommandBus} from '../src/contracts/command-bus';
import {IndependentCallCommand} from '../src/contracts/independent-calls';
import {IndependentCallControls} from '../src/session/independent-call-controls';

const query = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'task', requestId: 'cancel'};
function fixture() {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const cancel = vi.fn(async () => {}), read = vi.fn(async () => ({taskId: 'task', requestId: 'cancel', expectedEpoch: 0, controlEpoch: 0, status: 'cancelled' as const}));
    const controlTask = vi.fn(), withdrawTaskPause = vi.fn(), readTaskControlReceipt = vi.fn(), inspectSession = vi.fn(), execute = vi.fn();
    const logger = {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()};
    const resolve = vi.fn(async () => ({program: {kind: 'agent.loop'}} as TaskRecord));
    const commands = {execute, register: (name: string, handler: (args: any) => Promise<any>) => handlers.set(name, handler)} as unknown as ICommandBus;
    new IndependentCallControls({commands, logger, resolve, kernel: {cancel, readTaskCancellationReceipt: read, controlTask, withdrawTaskPause, readTaskControlReceipt, inspectSession} as unknown as Kernel}).register();
    return {handlers, cancel, read, logger, resolve, controlTask, withdrawTaskPause, readTaskControlReceipt, inspectSession, execute};
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


it.each(['pause', 'resume', 'withdraw'] as const)('routes %s with a frozen epoch and reads its original control admission', async action => {
    const f = fixture(), mode = action === 'pause' ? 'pause' : 'run', kind = action === 'withdraw' ? 'withdraw-pause' : mode;
    const receipt = {requestId: 'cancel', action: kind, expectedEpoch: 4, accepted: {mode, epoch: 5, requestId: 'cancel', acknowledged: false}};
    f.readTaskControlReceipt.mockResolvedValue(receipt);
    expect(await f.handlers.get(IndependentCallCommand.Control)!({...query, action, expectedEpoch: 4})).toEqual({...query, action, receipt});
    if (action === 'withdraw') expect(f.withdrawTaskPause).toHaveBeenCalledWith('child', 'task', {requestId: 'cancel', expectedEpoch: 4});
    else expect(f.controlTask).toHaveBeenCalledWith('child', 'task', mode, {requestId: 'cancel', expectedEpoch: 4});
    expect(await f.handlers.get(IndependentCallCommand.ControlReceipt)!({...query, action})).toEqual({...query, action, receipt});
    expect(f.controlTask.mock.calls.length + f.withdrawTaskPause.mock.calls.length).toBe(1); expect(f.cancel).not.toHaveBeenCalled();
});
it('rejects unknown state actions and mismatched control receipts without forwarding signal or goal fields', async () => {
    const f = fixture();
    for (const extra of [{action: 'PRIVATE INVALID ACTION'}, {action: 'pause', signal: {type: 'inject'}}, {action: 'pause', goal: {status: 'complete'}}])
        await expect(f.handlers.get(IndependentCallCommand.Control)!({...query, expectedEpoch: 0, ...extra})).rejects.toMatchObject({code: 'CALL_CONTROL_INVALID'});
    expect(f.resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('PRIVATE INVALID ACTION');
    f.readTaskControlReceipt.mockResolvedValue({requestId: 'cancel', action: 'run', accepted: {requestId: 'cancel', mode: 'run'}});
    await expect(f.handlers.get(IndependentCallCommand.ControlReceipt)!({...query, action: 'pause'})).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    expect(f.controlTask).not.toHaveBeenCalled();
});


it('rejects malformed cancellation targets and does not broaden state controls to descendants', async () => {
    const f = fixture();
    for (const targetTaskId of ['', ' ', null, 4, {}])
        await expect(f.handlers.get(IndependentCallCommand.Cancel)!({...query, targetTaskId, expectedEpoch: 0})).rejects.toMatchObject({code: 'CALL_CONTROL_INVALID'});
    await expect(f.handlers.get(IndependentCallCommand.Control)!({...query, targetTaskId: 'worker', action: 'pause', expectedEpoch: 0})).rejects.toMatchObject({code: 'CALL_CONTROL_INVALID'});
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
});


it('routes a descendant Flow through its scheduler control port and verifies the target receipt', async () => {
    const f = fixture(), root = {id: 'task', sessionId: 'child', rootTaskId: 'task', program: {kind: 'agent.loop'}} as TaskRecord;
    const target = {...root, id: 'nested-flow', parentTaskId: root.id, program: {kind: 'flow.aggregate'}};
    f.resolve.mockResolvedValue(root);
    f.inspectSession.mockResolvedValue({attachTask: async (id: string) => ({status: async () => ({task: id === target.id ? target : root})})});
    const receipt = {requestId: 'cancel', taskId: target.id, expectedEpoch: 3, controlEpoch: 3, status: 'cancelled'};
    f.execute.mockResolvedValue(receipt);
    const scope = {...query, targetTaskId: target.id};
    expect(await f.handlers.get(IndependentCallCommand.Cancel)!({...scope, expectedEpoch: 3})).toEqual({...scope, receipt});
    expect(f.execute.mock.calls).toEqual([
        [FlowCommand.RunCancel, {sessionId: 'child', taskId: target.id, requestId: 'cancel', expectedEpoch: 3}],
        [FlowCommand.RunCancellationReceipt, {sessionId: 'child', taskId: target.id, requestId: 'cancel'}],
    ]);
    expect(f.cancel).not.toHaveBeenCalled();
    f.execute.mockResolvedValue({...receipt, taskId: root.id});
    await expect(f.handlers.get(IndependentCallCommand.CancellationReceipt)!(scope)).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
});
