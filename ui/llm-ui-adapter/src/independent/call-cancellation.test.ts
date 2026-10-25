import {expect, it, vi} from 'vitest';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallCancelRequest} from '@itookit/llm-session/contracts';
import {CallCancellationOperations} from './call-cancellation';
const request: IndependentCallCancelRequest = {sessionId: 'parent', branchId: 'main', callId: 'call', executionSessionId: 'child', taskId: 'task', requestId: 'cancel', expectedEpoch: 3};
const query = () => {const {expectedEpoch: _epoch, ...rest} = request; return rest;};
const result = () => ({...query(), receipt: {taskId: 'task', requestId: 'cancel', expectedEpoch: 3, controlEpoch: 3, status: 'cancelled'}});
function fixture() {
    let saved: readonly OperationRecord[] = [];
    const execute = vi.fn(async (_name: string, _args?: unknown) => result() as unknown);
    const open = () => {const ledger = createOperationLedger({initial: saved, save: async records => {saved = structuredClone(records);}});
        return {ledger, controls: new CallCancellationOperations(ledger, {execute} as never, 'parent')};};
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
    await expect(new CallCancellationOperations(ledger, {execute} as never, 'parent').cancel(request, () => true)).rejects.toMatchObject({code: 'CALL_CONTROL_SAVE_FAILED'});
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
