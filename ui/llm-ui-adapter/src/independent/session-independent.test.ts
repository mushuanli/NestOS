import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger, type ChatSubmission} from '@itookit/llm-ui';
import {IndependentCallCommand, SessionCommand} from '@itookit/llm-session/contracts';
import {createSessionChatBinding} from './session';

const bindings: ReturnType<typeof createSessionChatBinding>[] = [];
afterEach(() => {bindings.splice(0).forEach(binding => binding.dispose()); vi.useRealTimers();});
async function fixture() {
    const target = {kind: 'agent' as const, id: 'worker', version: '1', digest: 'published'};
    const execute = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
        if (command === SessionCommand.ListTargets) return {entries: [{target, name: 'Worker'}], issues: []};
        if (command === IndependentCallCommand.Submit || command === IndependentCallCommand.Inspect)
            return {operationId: 'call', callerSessionId: 'parent', executionSessionId: 'child', status: 'accepted'};
        throw new Error(command);
    });
    const operations = createOperationLedger(), onError = vi.fn();
    const binding = createSessionChatBinding({independentCalls: true, targetSelection: true, operations, onError,
        commands: {execute} as never, hasCommittedSubmission: vi.fn(async () => false), session: {id: 'parent',
            getSnapshot: () => ({view: {manifest: {currentBranch: 'main'}}}), getSessions: () => [], isGenerating: () => false, onEvent: () => () => {}} as never});
    bindings.push(binding); await binding.refreshTargets();
    const input: ChatSubmission = {text: 'task', attachments: [], target, selection: {callMode: 'independent'}};
    const context = {viewId: binding.source.getSnapshot().viewId, operationId: 'call'};
    await binding.operations.register({context, conversationId: 'parent', kind: 'send', status: 'submitting', input: input as never});
    return {binding, execute, operations, input, context, onError};
}

it('freezes independent mode with the original request and submits to the child route', async () => {
    const f = await fixture();
    expect(f.binding.source.getSnapshot().selectors?.find(selector => selector.id === 'callMode')?.choices.map(choice => choice.id)).toEqual(['current', 'independent']);
    expect(await f.binding.actions.send!({...f.input, selection: {callMode: 'current'}}, f.context)).toMatchObject({status: 'accepted'});
    expect(f.execute).toHaveBeenCalledWith(IndependentCallCommand.Submit, expect.objectContaining({title: 'worker',
        request: expect.objectContaining({expectedSessionId: 'parent', expectedBranch: 'main'})}));
    expect(f.execute.mock.calls.some(([name]) => name === SessionCommand.Submit)).toBe(false);
    expect(f.operations.getSnapshot()[0].input).toMatchObject({independentTitle: 'worker', sessionRequest: {submission: {id: 'call'}}});
    expect(f.binding.source.getSnapshot().messages).toEqual([]);
});

it('observes durable child admission while the original submit reply is suspended', async () => {
    vi.useFakeTimers(); const f = await fixture(), original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation((name, args) => name === IndependentCallCommand.Submit ? new Promise(() => {}) : original(name, args));
    void f.binding.actions.send!(f.input, f.context);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.binding.source.getSnapshot().operationReceipts).toEqual([{operationId: 'call', status: 'accepted'}]);
    expect(f.execute.mock.calls.filter(([name]) => name === IndependentCallCommand.Submit)).toHaveLength(1);
    expect(f.execute.mock.calls.some(([name]) => name === SessionCommand.InspectSubmissionReceipt)).toBe(false);
    f.binding.setActive(false); const count = f.execute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000); expect(f.execute).toHaveBeenCalledTimes(count);
});

it('keeps a created child unknown until actual admission and rejects another caller receipt', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue({operationId: 'call', callerSessionId: 'parent', executionSessionId: 'child', status: 'unknown'});
    expect(await f.binding.actions.reconcile!('call')).toMatchObject({status: 'unknown'});
    f.execute.mockResolvedValue({operationId: 'call', callerSessionId: 'foreign', executionSessionId: 'child', status: 'accepted'});
    await expect(f.binding.actions.reconcile!('call')).rejects.toMatchObject({code: 'CALL_SUBMISSION_RECEIPT_MISMATCH'});
    expect(f.binding.source.getSnapshot().operationReceipts).toEqual([]);
});

it('restarts observation after hiding even if the old receipt query never resolves', async () => {
    vi.useFakeTimers(); const f = await fixture(), original = f.execute.getMockImplementation()!;
    let queries = 0;
    f.execute.mockImplementation((name, args) => name === IndependentCallCommand.Inspect && ++queries === 1 ? new Promise(() => {}) : original(name, args));
    await vi.advanceTimersByTimeAsync(1000); expect(queries).toBe(1);
    f.binding.setActive(false); f.binding.setActive(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.binding.source.getSnapshot().operationReceipts).toEqual([{operationId: 'call', status: 'accepted'}]);
});

it('refuses to freeze an independent call without an observed branch', async () => {
    const operations = createOperationLedger(), execute = vi.fn(async (_command: string) => ({entries: [], issues: []}));
    const binding = createSessionChatBinding({independentCalls: true, targetSelection: true, operations,
        commands: {execute} as never, hasCommittedSubmission: async () => false, session: {id: 'parent', getSnapshot: () => ({}),
            getSessions: () => [], isGenerating: () => false, onEvent: () => () => {}} as never});
    bindings.push(binding);
    await expect(binding.operations.register({context: {operationId: 'unscoped', viewId: binding.source.getSnapshot().viewId},
        conversationId: 'parent', kind: 'send', status: 'submitting', input: {text: 'keep', attachments: [], selection: {callMode: 'independent'},
            target: {kind: 'agent', id: 'worker', version: '1', digest: 'published'}}})).rejects.toMatchObject({code: 'CALL_BRANCH_REQUIRED'});
    expect(operations.getSnapshot()).toEqual([]);
    expect(execute.mock.calls.some(([name]) => name === IndependentCallCommand.Submit)).toBe(false);
});

it('does not automatically consume another branch call but can explicitly inspect its frozen request', async () => {
    vi.useFakeTimers(); const f = await fixture(); f.binding.dispose(); f.execute.mockClear();
    const reopened = createSessionChatBinding({independentCalls: true, operations: f.operations, commands: {execute: f.execute} as never,
        hasCommittedSubmission: async () => false, session: {id: 'parent', getSnapshot: () => ({view: {manifest: {currentBranch: 'review'}}}),
            getSessions: () => [], isGenerating: () => false, onEvent: () => () => {}} as never});
    bindings.push(reopened);
    await vi.advanceTimersByTimeAsync(2000); expect(f.execute).not.toHaveBeenCalled();
    expect(await reopened.actions.reconcile!('call')).toMatchObject({status: 'accepted'});
    expect(f.execute).toHaveBeenCalledWith(IndependentCallCommand.Inspect, expect.objectContaining({request: expect.objectContaining({expectedBranch: 'main'})}));
});
