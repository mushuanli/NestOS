import {expect, it, vi} from 'vitest';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallCancelRequest} from '@itookit/llm-session/contracts';
import {CallControlOperations} from './call-control';
const request: IndependentCallCancelRequest = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'task', requestId: 'cancel', expectedEpoch: 3};
const query = () => {const {expectedEpoch: _epoch, ...rest} = request; return rest;};
const result = () => ({...query(), receipt: {taskId: 'task', requestId: 'cancel', expectedEpoch: 3, controlEpoch: 3, status: 'cancelled'}});
function fixture() {
    let saved: readonly OperationRecord[] = [];
    const execute = vi.fn(async (_name: string, _args?: unknown) => result() as unknown);
    const open = () => {const ledger = createOperationLedger({initial: saved, save: async records => {saved = structuredClone(records);}});
        return {ledger, controls: new CallControlOperations(ledger, {execute} as never, 'parent')};};
    return {execute, open, saved: () => saved};
}
it('persists before dispatch and reopens a suspended cancellation by query without resending', async () => {
    const f = fixture(), first = f.open();
    f.execute.mockImplementationOnce(async () => {expect(f.saved()[0].input).toMatchObject({request}); return new Promise(() => {});});
    void first.controls.cancel(request, () => true);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(IndependentCallCommand.Cancel, request));
    const second = f.open(); await second.controls.cancel(request, () => true);
    expect(f.execute).toHaveBeenLastCalledWith(IndependentCallCommand.CancellationReceipt, query());
    expect(f.saved()[0].status).toBe('accepted'); expect(f.execute.mock.calls).toHaveLength(2);
    await second.controls.cancel(request, () => true); expect(f.execute.mock.calls).toHaveLength(2);
    expect(f.saved()[0].draft).toBeUndefined();
});
it('never dispatches if persistence fails or the view closes during registration', async () => {
    const execute = vi.fn(), ledger = createOperationLedger({save: async () => {throw new Error('Disk failed');}});
    await expect(new CallControlOperations(ledger, {execute} as never, 'parent').cancel(request, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_SAVE_FAILED'});
    expect(execute).not.toHaveBeenCalled();
    const f = fixture(), view = f.open(); expect(await view.controls.cancel(request, () => false)).toMatchObject({status: 'rejected', code: 'CALL_VIEW_CLOSED'});
    expect(f.execute).not.toHaveBeenCalled();
});
it.each(['missing', 'scope', 'epoch'])('keeps %s evidence unresolved and preserves frozen intent', async failure => {
    const f = fixture(), first = f.open(); f.execute.mockRejectedValueOnce(new Error('Lost'));
    await expect(first.controls.cancel(request, () => true)).rejects.toThrow('Lost');
    const value = failure === 'missing' ? query() : failure === 'scope' ? {...result(), executionSessionId: 'other'} : {...result(), receipt: {...result().receipt, expectedEpoch: 4}};
    f.execute.mockResolvedValue(value); const second = f.open();
    if (failure === 'missing') expect(await second.controls.reconcile('cancel')).toMatchObject({status: 'unknown'});
    else await expect(second.controls.reconcile('cancel')).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    expect(f.saved()[0].status).toBe('unknown');
    await expect(second.controls.cancel({...request, taskId: 'other'}, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_IDENTITY_MISMATCH'});
    expect(f.execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Cancel)).toHaveLength(1);
});
it('does not regress accepted admission when the original dispatch fails late', async () => {
    const f = fixture(), view = f.open(); let reject!: (error: Error) => void;
    f.execute.mockImplementationOnce(() => new Promise((_resolve, no) => {reject = no;}));
    const sending = view.controls.cancel(request, () => true); void sending.catch(() => {});
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    await view.controls.reconcile('cancel'); reject(new Error('Late network error')); expect(await sending).toMatchObject({status: 'accepted'});
    expect(view.ledger.getSnapshot()[0].status).toBe('accepted');
});

it.each(['pause', 'resume', 'withdraw'] as const)('recovers %s by original receipt without dispatching a second control', async action => {
    const f = fixture(), first = f.open(), input = {...request, action};
    f.execute.mockRejectedValueOnce(new Error('Response lost'));
    await expect(first.controls.control(input, () => true)).rejects.toThrow('Response lost');
    f.execute.mockResolvedValue({...query(), action, receipt: {requestId: request.requestId, expectedEpoch: 3,
        action: action === 'resume' ? 'run' : action === 'withdraw' ? 'withdraw-pause' : 'pause', accepted: {requestId: request.requestId, epoch: 4}}});
    const restored = f.open(); expect(await restored.controls.control(input, () => true)).toMatchObject({status: 'accepted'});
    expect(f.execute).toHaveBeenLastCalledWith(IndependentCallCommand.ControlReceipt, {...query(), action});
    expect(f.execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Control)).toHaveLength(1);
    expect(restored.controls.latest('main', 'call', 'task')).toBeUndefined();
    expect(restored.controls.latest('main', 'call', 'task', 'state')?.status).toBe('accepted');
    await expect(restored.controls.control({...input, action: action === 'pause' ? 'resume' : 'pause'}, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_IDENTITY_MISMATCH'});
});
it('does not regress a verified control when an earlier missing receipt arrives late', async () => {
    const f = fixture(), view = f.open(); let missing!: (value: unknown) => void;
    f.execute.mockImplementationOnce(() => new Promise(resolve => {missing = resolve;}));
    const sending = view.controls.cancel(request, () => true);
    await vi.waitFor(() => expect(missing).toBeTypeOf('function'));
    await view.controls.reconcile(request.requestId); missing(query());
    expect(await sending).toMatchObject({status: 'accepted'}); expect(view.ledger.getSnapshot()[0].status).toBe('accepted');
});
it.each(['action', 'epoch', 'accepted-id'])('rejects a mismatched state-control %s receipt', async fault => {
    const f = fixture(), view = f.open(), input = {...request, action: 'pause' as const};
    const receipt = {requestId: request.requestId, expectedEpoch: fault === 'epoch' ? 5 : 3,
        action: fault === 'action' ? 'run' : 'pause', accepted: {requestId: fault === 'accepted-id' ? 'other' : request.requestId, epoch: 4}};
    f.execute.mockResolvedValue({...query(), action: 'pause', receipt});
    await expect(view.controls.control(input, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    expect(view.ledger.getSnapshot()[0].status).toBe('unknown');
});
it('freezes an answer, restores by receipt without its body, and keeps its channel separate from controls', async () => {
    const f = fixture(), first = f.open(), input = {...query(), targetTaskId: 'worker', interactionId: 'ask', value: {approved: true}};
    f.execute.mockRejectedValueOnce(new Error('Lost answer reply'));
    await expect(first.controls.respond(input, () => true)).rejects.toThrow('Lost answer reply');
    f.execute.mockResolvedValue({...query(), targetTaskId: 'worker', interactionId: 'ask', receipt: {requestId: 'cancel', taskId: 'worker', interactionId: 'ask', resolvedAt: 1}});
    const restored = f.open(); expect(await restored.controls.respond(input, () => true)).toMatchObject({status: 'accepted'});
    expect(f.execute).toHaveBeenLastCalledWith(IndependentCallCommand.ResponseReceipt, {...query(), targetTaskId: 'worker', interactionId: 'ask'});
    expect(restored.controls.latest('main', 'call', 'task')).toBeUndefined();
    expect(restored.controls.answers('main', 'call', 'task')).toHaveLength(1);
    await expect(restored.controls.respond({...input, value: false}, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_IDENTITY_MISMATCH'});
    expect(f.execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Respond)).toHaveLength(1);
});
it('does not accept a receipt for another interaction as the original answer', async () => {
    const f = fixture(), first = f.open();
    f.execute.mockResolvedValue({...query(), targetTaskId: 'worker', interactionId: 'ask', receipt: {requestId: 'cancel', taskId: 'worker', interactionId: 'other', resolvedAt: 1}});
    await expect(first.controls.respond({...query(), targetTaskId: 'worker', interactionId: 'ask', value: 'Answer'}, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    expect(first.ledger.getSnapshot()[0].status).toBe('unknown');
});

const treeResult = () => ({...query(), receipt: {taskId: 'task', requestId: 'cancel', expectedEpoch: 3, controlEpoch: 3, rootStatus: 'succeeded', taskCount: 2, acceptedAt: 1}});
it('freezes remaining-tree intent separately and recovers the original request after reopening', async () => {
    const f = fixture(), first = f.open();
    f.execute.mockImplementationOnce(async () => new Promise(() => {}));
    void first.controls.cancelRemaining(request, () => true);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(IndependentCallCommand.CancelRemaining, request));
    expect(f.saved()[0].input).toMatchObject({protocol: 'independent-call-tree-cancel-v1', request});
    expect(first.controls.latest('main', 'call', 'task', 'cancel')).toBeUndefined();
    expect(first.controls.latest('main', 'call', 'task', 'remaining')?.status).toBe('submitting');
    const second = f.open(); f.execute.mockResolvedValue(treeResult()); await second.controls.cancelRemaining(request, () => true);
    expect(f.execute).toHaveBeenLastCalledWith(IndependentCallCommand.TreeCancellationReceipt, query());
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.saved()[0].status).toBe('accepted'); expect(f.saved()[0].draft).toBeUndefined();
});
it('rejects reuse of an ordinary cancel identity for remaining-tree control', async () => {
    const f = fixture(), view = f.open(); await view.controls.cancel(request, () => true);
    await expect(view.controls.cancelRemaining(request, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_IDENTITY_MISMATCH'});
    expect(f.execute).toHaveBeenCalledTimes(1);
});
it('never dispatches remaining-tree control if its durable intent cannot be saved', async () => {
    const execute = vi.fn(), ledger = createOperationLedger({save: async () => {throw new Error('Disk failed');}});
    await expect(new CallControlOperations(ledger, {execute} as never, 'parent').cancelRemaining(request, () => true))
        .rejects.toMatchObject({code: 'CALL_CONTROL_SAVE_FAILED'});
    expect(execute).not.toHaveBeenCalled();
});
it('does not accept a single-task receipt or a mismatched tree epoch as remaining-tree admission', async () => {
    const f = fixture(), view = f.open();
    await expect(view.controls.cancelRemaining(request, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    expect(f.saved()[0].status).toBe('unknown');
    f.execute.mockResolvedValue({...treeResult(), receipt: {...treeResult().receipt, expectedEpoch: 4}});
    await expect(view.controls.reconcile(request.requestId)).rejects.toMatchObject({code: 'CALL_CONTROL_RECEIPT_MISMATCH'});
    expect(f.saved()[0].status).toBe('unknown');
    f.execute.mockResolvedValue(treeResult()); await view.controls.reconcile(request.requestId);
    expect(f.saved()[0].status).toBe('accepted');
    expect(f.execute.mock.calls.filter(([name]) => name === IndependentCallCommand.CancelRemaining)).toHaveLength(1);
});
it('does not regress verified remaining-tree admission when the original response fails late', async () => {
    const f = fixture(), view = f.open(); let reject!: (error: Error) => void;
    f.execute.mockImplementationOnce(async () => new Promise((_resolve, fail) => {reject = fail;}));
    const sending = view.controls.cancelRemaining(request, () => true);
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    f.execute.mockResolvedValue(treeResult()); await view.controls.reconcile(request.requestId);
    reject(new Error('Delayed transport failure'));
    expect(await sending).toEqual({operationId: request.requestId, status: 'accepted'});
    expect(view.ledger.getSnapshot()[0].status).toBe('accepted');
});
