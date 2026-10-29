import {expect, it, vi} from 'vitest';
import {createOperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {ControlOperations, type ControlInput} from './control-operations';

const input: ControlInput = {protocol: 'flow-control-v1', taskId: 'root', action: 'pause', expectedEpoch: 7};
function fixture() {
    let saved: readonly OperationRecord[] = [];
    const execute = vi.fn(async () => undefined as unknown);
    const open = () => {
        const ledger = createOperationLedger({initial: saved, save: async records => {saved = structuredClone(records);}});
        return {ledger, controls: new ControlOperations(ledger, {execute} as never, 'session')};
    };
    return {open, execute, saved: () => saved};
}
it('persists frozen control input before dispatch and recovers a lost reply across views by query only', async () => {
    const f = fixture(), first = f.open(), send = vi.fn(async (id: string) => {
        expect(f.saved()[0]).toMatchObject({context: {operationId: id}, input, status: 'submitting'});
        throw new Error('Reply lost');
    });
    await expect(first.controls.run(input, send)).rejects.toThrow('Reply lost');
    const record = f.saved()[0], second = f.open();
    expect(second.controls.pending('root')).toHaveLength(1);
    f.execute.mockResolvedValue({requestId: record.context.operationId, action: 'pause', expectedEpoch: 7,
        accepted: {requestId: record.context.operationId, acknowledged: false}, current: {requestId: 'later'}});
    await second.controls.reconcile(record.context.operationId);
    expect(f.execute).toHaveBeenCalledWith(FlowCommand.RunControlReceipt, {sessionId: 'session', taskId: 'root', requestId: record.context.operationId});
    expect(f.saved()[0].status).toBe('accepted'); expect(send).toHaveBeenCalledOnce();
    const third = f.open(); await third.controls.run(input, send); expect(send).toHaveBeenCalledOnce();
});
it('never dispatches when the initial persistent registration fails', async () => {
    const ledger = createOperationLedger({save: async () => {throw new Error('Storage unavailable');}}), send = vi.fn();
    await expect(new ControlOperations(ledger, {} as never, 'session').run(input, send)).rejects.toThrow('Storage unavailable');
    expect(send).not.toHaveBeenCalled();
});
it('keeps a missing or mismatched receipt unresolved and never sends during reconciliation', async () => {
    const f = fixture(), first = f.open(); await expect(first.controls.run(input, async () => {throw new Error('Lost');})).rejects.toThrow();
    const id = f.saved()[0].context.operationId, second = f.open();
    await second.controls.reconcile(id); expect(f.saved()[0].status).toBe('unknown');
    f.execute.mockResolvedValue({requestId: id, action: 'run', expectedEpoch: 7, accepted: {requestId: id}});
    await expect(second.controls.reconcile(id)).rejects.toThrow('identity mismatch');
    expect(f.saved()[0].status).toBe('unknown');
});
it('uses the same identity only for an explicit retry, including after reopening', async () => {
    const f = fixture(), send = vi.fn(async () => {throw new Error('Lost');});
    await expect(f.open().controls.run(input, send)).rejects.toThrow();
    await expect(f.open().controls.run(input, send)).rejects.toThrow();
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]); expect(f.saved()).toHaveLength(1);
});

it('recovers accepted remote control when the local result write fails', async () => {
    let saved: readonly OperationRecord[] = [], failing = false;
    const ledger = createOperationLedger({save: async records => {
        if (failing) throw new Error('Storage unavailable'); saved = structuredClone(records);
    }});
    const send = vi.fn(async () => {failing = true; return true;});
    await expect(new ControlOperations(ledger, {} as never, 'session').run(input, send)).rejects.toThrow('Storage unavailable');
    expect(saved[0].status).toBe('submitting');
    const id = saved[0].context.operationId;
    const restored = createOperationLedger({initial: saved}), execute = vi.fn(async () => ({requestId: id, action: 'pause', expectedEpoch: 7, accepted: {requestId: id}}));
    await new ControlOperations(restored, {execute} as never, 'session').reconcile(id);
    expect(restored.getSnapshot()[0].status).toBe('accepted'); expect(send).toHaveBeenCalledOnce();
});

it('freezes a child execution Session in the parent ledger and queries that Session after reopening', async () => {
    const f = fixture(), first = f.open(), child = {...input, executionSessionId: 'child'};
    await expect(first.controls.run(child, async () => {throw new Error('Lost child reply');})).rejects.toThrow();
    const record = f.saved()[0];
    expect(record).toMatchObject({conversationId: 'session', input: child});
    const reopened = f.open();
    expect(reopened.controls.pending('root')).toEqual([]);
    expect(reopened.controls.pending('root', 'child')).toHaveLength(1);
    await reopened.controls.reconcile(record.context.operationId);
    expect(f.execute).toHaveBeenCalledWith(FlowCommand.RunControlReceipt,
        {sessionId: 'child', taskId: 'root', requestId: record.context.operationId});
    const fromChild = createOperationLedger(), local = new ControlOperations(fromChild, {} as never, 'child');
    const send = vi.fn(async () => {}); await local.run({...input, executionSessionId: 'child'}, send);
    expect(send).toHaveBeenCalledWith(record.context.operationId);
    expect(fromChild.getSnapshot()[0].input).toEqual(input);
});

it('rejects an empty execution Session without silently retargeting a control to the parent', async () => {
    const f = fixture(), send = vi.fn();
    await expect(f.open().controls.run({...input, executionSessionId: ''}, send)).rejects.toThrow('execution Session is invalid');
    expect(send).not.toHaveBeenCalled(); expect(f.saved()).toEqual([]);
});

it('recovers a lost child cancellation by its original identity without reissuing the write', async () => {
    const f = fixture(), first = f.open(), cancellation = {...input, action: 'cancel' as const, executionSessionId: 'child'};
    const send = vi.fn(async () => {throw new Error('Cancellation response lost');});
    await expect(first.controls.run(cancellation, send)).rejects.toThrow('response lost');
    const id = f.saved()[0].context.operationId, second = f.open();
    f.execute.mockResolvedValue({requestId: id, taskId: 'root', expectedEpoch: 6, status: 'cancelled'});
    await expect(second.controls.reconcile(id)).rejects.toThrow('identity mismatch');
    expect(f.saved()[0].status).toBe('unknown');
    f.execute.mockResolvedValue({requestId: id, taskId: 'root', expectedEpoch: 7, status: 'cancelled'});
    await second.controls.reconcile(id);
    expect(f.execute).toHaveBeenLastCalledWith(FlowCommand.RunCancellationReceipt, {sessionId: 'child', taskId: 'root', requestId: id});
    expect(f.saved()[0].status).toBe('accepted'); expect(send).toHaveBeenCalledOnce();
});
