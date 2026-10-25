import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {SessionCommand, type SubmissionRequest, type SessionInstructionQueue, type SubmissionReceipt} from '@itookit/llm-session/contracts';
import type {CommandContext} from './CommandContext';
import {submitSessionCall, reconcileSessionCall} from './submit-session-call';

function setup() {
    const operations = createOperationLedger(), stop = vi.fn();
    let observe!: (queue: SessionInstructionQueue) => void, fail!: (reason: Error) => void;
    const pending = new Promise<string>((_resolve, reject) => {fail = reject;});
    const execute = vi.fn(() => pending), reconcileSubmission = vi.fn(async (): Promise<SubmissionReceipt> => ({operationId: 'call', status: 'accepted'}));
    const ctx = {operations, commands: {execute}, getSessionId: () => 'session', reconcileSubmission,
        observeInstructions: (listener: typeof observe) => {observe = listener; return stop;}} as unknown as CommandContext;
    const request: SubmissionRequest = {target: {kind: 'flow', id: 'worker', version: '1'}, expectedSessionId: 'session', expectedBranch: 'main',
        source: {kind: 'arguments', value: {count: 7}}, submission: {id: 'call', source: {kind: 'conversation', ownerId: 'session', id: 'call'}}};
    const queue = {sessionId: 'session', revision: 1, paused: false, items: [{id: 'call', sendIntent: {submission: request.submission}}]} as SessionInstructionQueue;
    return {ctx, operations, request, queue, execute, stop, reconcileSubmission, observe: () => observe(queue), fail};
}

function contextFor(f: ReturnType<typeof setup>) {
    const target = {kind: 'agent' as const, id: 'worker', version: '1', digest: 'published'};
    const selection = {mode: 'fork' as const, sourceBindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 1, checkpointRef: 'checkpoint-A'};
    Object.assign(f.request, {target, expectedTarget: target, source: {kind: 'composer', text: 'Input', attachments: [], values: {}}, overrides: {harnessConversation: selection}});
    return {revision: 1, sessionId: 'session', branchId: 'main', target, selection};
}

async function registered(f: ReturnType<typeof setup>, status: 'unknown' | 'submitting' | 'accepted', contextDraft?: ReturnType<typeof contextFor>) {
    await f.operations.register({context: {viewId: 'session', operationId: 'call'}, conversationId: 'session', kind: 'send', status,
        input: JSON.parse(JSON.stringify({key: 'frozen', request: f.request, ...(contextDraft ? {contextDraft} : {})}))});
}

it('releases a suspended submit from an independently reconciled durable receipt and ignores a late transport failure', async () => {
    const f = setup(), sending = submitSessionCall(f.ctx, f.request, 'frozen');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.Submit, f.request);
    expect(await reconcileSessionCall(f.ctx, 'call')).toMatchObject({status: 'accepted'});
    expect(await sending).toBe('call'); expect(f.stop).toHaveBeenCalledOnce();
    f.fail(new Error('Late transport failure'));
    await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledTimes(2));
    expect(f.operations.getSnapshot()[0].status).toBe('accepted'); expect(f.execute).toHaveBeenCalledOnce();
});

it('does not accept a matching queue identity when the full frozen request conflicts', async () => {
    const f = setup();
    f.reconcileSubmission.mockRejectedValue(Object.assign(new Error('Different accepted input'), {code: 'QUEUE_CONFLICT'}));
    const sending = submitSessionCall(f.ctx, f.request, 'frozen'), rejected = expect(sending).rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); f.observe();
    await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledOnce());
    expect(f.operations.getSnapshot()[0].status).toBe('submitting'); expect(f.stop).not.toHaveBeenCalled();
    f.fail(Object.assign(new Error('Conflicting submission'), {code: 'QUEUE_CONFLICT'})); await rejected;
    expect(f.operations.getSnapshot()[0].status).toBe('rejected'); expect(f.execute).toHaveBeenCalledOnce();
});

it('keeps observation after a transient receipt-read failure and can confirm the same suspended operation later', async () => {
    const f = setup(); f.reconcileSubmission.mockRejectedValueOnce(new Error('Receipt storage temporarily unavailable'));
    const sending = submitSessionCall(f.ctx, f.request, 'frozen');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); f.observe();
    await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledOnce());
    expect(f.operations.getSnapshot()[0].status).toBe('submitting'); expect(f.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => {f.observe(); expect(f.reconcileSubmission).toHaveBeenCalledTimes(2);});
    expect(await sending).toBe('call'); expect(f.stop).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
});

it('preserves a concurrent terminal rejection instead of reporting contradictory acceptance', async () => {
    const f = setup();
    await f.operations.register({context: {viewId: 'old', operationId: 'call'}, conversationId: 'session', kind: 'send', status: 'unknown', input: JSON.parse(JSON.stringify({request: f.request}))});
    f.reconcileSubmission.mockImplementationOnce(async () => {
        await f.operations.settle({operationId: 'call', status: 'rejected', code: 'CALL_TARGET_UNAVAILABLE', message: 'Admission rejected'});
        return {operationId: 'call', status: 'accepted'};
    });
    expect(await reconcileSessionCall(f.ctx, 'call')).toMatchObject({status: 'rejected', message: 'Admission rejected'});
    expect(f.operations.getSnapshot()[0].status).toBe('rejected'); expect(f.execute).not.toHaveBeenCalled();
});

it('persists and delivers the same frozen request and context evidence while ledger storage is suspended', async () => {
    let release!: () => void, entered!: () => void, first = true;
    const waiting = new Promise<void>(resolve => {release = resolve;}), saving = new Promise<void>(resolve => {entered = resolve;});
    let saved: readonly import('@itookit/llm-ui').OperationRecord[] = [];
    const operations = createOperationLedger({save: async records => {
        saved = structuredClone(records); if (first) {first = false; entered(); await waiting;}
    }}), f = setup(); f.ctx.operations = operations;
    const selection = {mode: 'fork' as const, sourceBindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 1, checkpointRef: 'checkpoint-A'};
    f.request.overrides = {harnessConversation: selection};
    const context = {revision: 1, sessionId: 'session', branchId: 'main', target: {kind: 'agent' as const, id: 'worker', version: '1', digest: 'published'}, selection};
    f.execute.mockResolvedValue('call');
    const sending = submitSessionCall(f.ctx, f.request, 'frozen', context); await saving;
    selection.checkpointRef = 'checkpoint-B'; context.revision = 2; context.target.digest = 'changed';
    f.request.source = {kind: 'arguments', value: {count: 99}}; release(); await sending;
    const record = saved[0].input as unknown as {request: SubmissionRequest; contextDraft: typeof context};
    expect(record.request.overrides?.harnessConversation).toMatchObject({checkpointRef: 'checkpoint-A'});
    expect(record.request.source).toMatchObject({value: {count: 7}});
    expect(record.contextDraft).toMatchObject({revision: 1, target: {digest: 'published'}, selection: {checkpointRef: 'checkpoint-A'}});
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.Submit, record.request);
    const restored = createOperationLedger({initial: JSON.parse(JSON.stringify(saved))}); f.ctx.operations = restored; f.execute.mockClear();
    expect(await reconcileSessionCall(f.ctx, 'call')).toMatchObject({status: 'accepted'}); expect(f.execute).not.toHaveBeenCalled();
});

it('keeps legacy request and operation input shapes when no context was selected', async () => {
    const f = setup(); f.execute.mockResolvedValue('call'); await submitSessionCall(f.ctx, f.request, 'frozen');
    const record = f.operations.getSnapshot()[0].input as unknown as {request: SubmissionRequest};
    expect(record).not.toHaveProperty('contextDraft'); expect(record.request.overrides).toBeUndefined();
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.Submit, f.request);
});

it.each([
    ['CONTEXT_TARGET_NOT_HARNESS', 'rejected'], ['CONTEXT_NATIVE_WRITE_UNSUPPORTED', 'rejected'], ['CONTEXT_POLICY_OVERRIDE_INVALID', 'rejected'],
    ['CONTEXT_POLICY_CHANGED', 'unknown'], ['CONTEXT_CHECKPOINT_INVALID', 'unknown'],
])('classifies %s without treating all context failures as safe rejection', async (code, status) => {
    const f = setup(); f.reconcileSubmission.mockResolvedValue({operationId: 'call', status: 'unknown'} as never);
    const sending = submitSessionCall(f.ctx, f.request, 'frozen').then(() => undefined, error => error);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); f.fail(Object.assign(new Error(code), {code}));
    expect(await sending).toBeInstanceOf(Error); expect(f.operations.getSnapshot()[0].status).toBe(status);
});

it('retains durable acceptance before classifying a late context rejection', async () => {
    const f = setup(), sending = submitSessionCall(f.ctx, f.request, 'frozen');
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.fail(Object.assign(new Error('Late transport response'), {code: 'CONTEXT_NATIVE_WRITE_UNSUPPORTED'}));
    expect(await sending).toBe('call'); expect(f.operations.getSnapshot()[0].status).toBe('accepted');
    expect(f.execute).toHaveBeenCalledOnce();
});

it.each(['unknown', 'submitting', 'accepted'] as const)('confirms a previous %s operation without treating a reselected draft as submitted', async status => {
    const f = setup(), context = contextFor(f); await registered(f, status, context);
    const newer = {...context, revision: 2};
    await expect(submitSessionCall(f.ctx, f.request, 'frozen', newer)).rejects.toMatchObject({
        code: 'CALL_SUBMISSION_PREVIOUS_ACCEPTED', outcome: 'accepted-previous'});
    expect(f.operations.getSnapshot()[0].status).toBe('accepted'); expect(f.execute).not.toHaveBeenCalled();
    expect((f.operations.getSnapshot()[0].input as {contextDraft?: unknown}).contextDraft).toMatchObject({revision: 1});
});

it('keeps an unknown previous operation unknown while preserving the reselected draft evidence', async () => {
    const f = setup(), context = contextFor(f); await registered(f, 'unknown', context);
    f.reconcileSubmission.mockResolvedValue({operationId: 'call', status: 'unknown'} as never);
    await expect(submitSessionCall(f.ctx, f.request, 'frozen', {...context, revision: 2})).rejects.toMatchObject({code: 'CALL_SUBMISSION_UNKNOWN', outcome: 'unknown'});
    expect(f.operations.getSnapshot()[0].status).toBe('unknown'); expect(f.execute).not.toHaveBeenCalled();
});

it('freezes current context evidence at entry before awaiting the old operation receipt', async () => {
    const f = setup(), context = contextFor(f); await registered(f, 'unknown', context);
    let finish!: () => void;
    f.reconcileSubmission.mockImplementation(() => new Promise(resolve => {finish = () => resolve({operationId: 'call', status: 'accepted'});}));
    const current = {...context, revision: 2}, sending = submitSessionCall(f.ctx, f.request, 'frozen', current);
    const result = expect(sending).rejects.toMatchObject({code: 'CALL_SUBMISSION_PREVIOUS_ACCEPTED', outcome: 'accepted-previous'});
    await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledOnce()); current.revision = 1; finish(); await result;
    expect(f.operations.getSnapshot()[0].status).toBe('accepted'); expect(f.execute).not.toHaveBeenCalled();
});

it('allows an explicitly retried matching context revision to consume its own accepted operation', async () => {
    const f = setup(), context = contextFor(f); await registered(f, 'unknown', context);
    expect(await submitSessionCall(f.ctx, f.request, 'frozen', structuredClone(context))).toBe('call');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.operations.getSnapshot()[0].status).toBe('accepted');
});

it('retains the legacy retry result when neither operation nor composer has context evidence', async () => {
    const f = setup(); await registered(f, 'unknown');
    expect(await submitSessionCall(f.ctx, f.request, 'frozen')).toBe('call'); expect(f.execute).not.toHaveBeenCalled();
});

it('does not turn a transient previous receipt read failure into rejection or a new Submit', async () => {
    const f = setup(), context = contextFor(f); await registered(f, 'unknown', context);
    f.reconcileSubmission.mockRejectedValue(new Error('Receipt offline'));
    await expect(submitSessionCall(f.ctx, f.request, 'frozen', {...context, revision: 2})).rejects.toMatchObject({code: 'CALL_SUBMISSION_UNKNOWN', outcome: 'unknown'});
    expect(f.operations.getSnapshot()[0].status).toBe('unknown'); expect(f.execute).not.toHaveBeenCalled();
});

it('keeps exact frozen input when the caller edits it while ledger persistence is pending', async () => {
    const f = setup(); let release!: () => void;
    const saved = new Promise<void>(resolve => {release = resolve;});
    f.ctx.operations = createOperationLedger({save: () => saved}); f.execute.mockResolvedValue('call');
    const sending = submitSessionCall(f.ctx, f.request, 'frozen');
    f.request.source = {kind: 'arguments', value: {count: 99}}; release();
    expect(await sending).toBe('call');
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.Submit, expect.objectContaining({source: {kind: 'arguments', value: {count: 7}}}));
});

it('refuses dispatch without an exact frozen-request receipt port', async () => {
    const f = setup(); f.ctx.reconcileSubmission = undefined;
    await expect(submitSessionCall(f.ctx, f.request, 'frozen')).rejects.toMatchObject({code: 'CALL_SUBMISSION_PORT_UNAVAILABLE'});
    expect(f.execute).not.toHaveBeenCalled(); expect(f.operations.getSnapshot()).toEqual([]);
});

it('rechecks a matching queue notification received while an earlier receipt read is pending', async () => {
    const f = setup(); let finish!: (receipt: SubmissionReceipt) => void;
    f.reconcileSubmission.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const sending = submitSessionCall(f.ctx, f.request, 'frozen');
    try {
        await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); f.observe();
        await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledOnce()); f.observe();
        finish({operationId: 'call', status: 'unknown'});
        await vi.waitFor(() => expect(f.reconcileSubmission).toHaveBeenCalledTimes(2));
        expect(await sending).toBe('call');
    } finally {finish?.({operationId: 'call', status: 'unknown'}); f.fail(new Error('End pending transport')); await sending.catch(() => {});}
});

// Attachment recovery proof regressions.
function fileDraft() {
    return {token: '0eaf7efe-3c23-4a4d-af0a-a2d7476b1ada', text: 'Input', settings: {},
        files: [{id: 'de0c042e-9327-4328-a7a8-3b00e8399a8b', name: 'input.txt', mimeType: 'text/plain', bytes: 3, sha256: 'a'.repeat(64)}]};
}
it('freezes attachment evidence before ledger persistence and does not embed file bodies', async () => {
    const f = setup(), draft = fileDraft(); let release!: () => void;
    const saved = new Promise<void>(resolve => {release = resolve;});
    f.ctx.operations = createOperationLedger({save: () => saved}); f.execute.mockResolvedValue('call');
    const sending = submitSessionCall(f.ctx, f.request, 'frozen', undefined, draft);
    draft.files[0].sha256 = 'b'.repeat(64); draft.text = 'Later edit'; release();
    expect(await sending).toBe('call');
    expect((f.ctx.operations.getSnapshot()[0].input as {draft: unknown}).draft).toEqual(fileDraft());
});
it.each(['unknown', 'submitting', 'accepted'] as const)('queries a previous %s file operation and preserves a different draft intent', async status => {
    const f = setup(), draft = fileDraft();
    await f.operations.register({context: {viewId: 'session', operationId: 'call'}, conversationId: 'session', kind: 'send', status,
        input: JSON.parse(JSON.stringify({key: 'frozen', request: f.request, draft}))});
    const current = {...draft, token: 'e30cf82d-05a0-4b99-90b8-5d783e05ef88'};
    await expect(submitSessionCall(f.ctx, f.request, 'frozen', undefined, current)).rejects.toMatchObject({code: 'CALL_SUBMISSION_PREVIOUS_ACCEPTED', outcome: 'accepted-previous'});
    expect(f.execute).not.toHaveBeenCalled(); expect(f.operations.getSnapshot()[0].status).toBe('accepted');
});
it('confirms a matching persisted attachment draft without another Submit', async () => {
    const f = setup(), draft = fileDraft();
    await f.operations.register({context: {viewId: 'session', operationId: 'call'}, conversationId: 'session', kind: 'send', status: 'unknown',
        input: JSON.parse(JSON.stringify({key: 'frozen', request: f.request, draft}))});
    expect(await submitSessionCall(f.ctx, f.request, 'frozen', undefined, structuredClone(draft))).toBe('call');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.operations.getSnapshot()[0].status).toBe('accepted');
});

// Concurrent persistence regressions.
it.each(['accepted', 'rejected', 'unknown'] as const)('does not Submit when registration persistence already knows the operation is %s', async status => {
    const f = setup(); f.ctx.operations = createOperationLedger({save: async records => records.map(record => ({...record, status}))});
    const sending = submitSessionCall(f.ctx, f.request, 'frozen');
    if (status === 'accepted') expect(await sending).toBe('call');
    else await expect(sending).rejects.toMatchObject({code: status === 'rejected' ? 'CALL_SUBMISSION_REJECTED' : 'CALL_SUBMISSION_UNKNOWN'});
    expect(f.execute).not.toHaveBeenCalled();
});
