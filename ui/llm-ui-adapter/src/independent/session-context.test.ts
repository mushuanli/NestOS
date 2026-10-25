import {afterEach, expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createSessionChatBinding} from './session';
const bindings: ReturnType<typeof createSessionChatBinding>[] = [];
afterEach(() => bindings.splice(0).forEach(binding => binding.dispose()));
const target = {kind: 'agent' as const, id: 'harness', version: '1', digest: 'published'};
const context = () => ({revision: 1, sessionId: 'parent', branchId: 'main', target, selection: {mode: 'fork', sourceBindingId: 'binding', expectedBindingRevision: 3, expectedGeneration: 1, checkpointRef: 'point'}});
async function fixture(enabled = true) {
    const execute = vi.fn(async (name: string, args?: any) => {
        if (name === SessionCommand.ContextOptions) return {...args, kind: 'direct-harness', basis: 'basis', dynamicPolicy: 'dispatch-validation-required',
            modes: {new: {supported: true}, fork: {supported: true}, continue: {supported: false}}, sources: [{ref: {bindingId: 'binding', revision: 3, generation: 1}, branchId: 'main', fork: {status: 'static-compatible', codes: []}}],
            checkpoints: [{ref: 'point', fork: {status: 'static-compatible', codes: []}}]};
        if (name === SessionCommand.InspectSubmissionReceipt) return {operationId: args.submission.id, status: 'accepted'};
        if (name === SessionCommand.ListTargets) return {entries: [{target, name: 'Harness'}], issues: []};
    });
    const ledger = createOperationLedger(), binding = createSessionChatBinding({contextSelection: enabled, targetSelection: true, operations: ledger,
        commands: {execute} as never, hasCommittedSubmission: async () => true, session: {id: 'parent',
            getSnapshot: () => ({view: {manifest: {currentBranch: 'main'}}}), getSessions: () => [], isGenerating: () => false, onEvent: () => () => {}} as never});
    bindings.push(binding); await binding.refreshTargets();
    const operation = {viewId: binding.source.getSnapshot().viewId, operationId: 'call'};
    return {binding, ledger, execute, operation};
}
it('freezes host context into the original request and ignores later mutable inputs when dispatching', async () => {
    const f = await fixture(), input = {text: 'Task', attachments: [], target, context: context()};
    await f.binding.operations.register({context: f.operation, conversationId: 'parent', kind: 'send', status: 'submitting', input});
    input.context.selection.checkpointRef = 'later'; await f.binding.actions.send!(input, f.operation);
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.Submit, expect.objectContaining({overrides: {harnessConversation: context().selection}}));
    expect(f.ledger.getSnapshot()[0].input).toMatchObject({context: context(), sessionRequest: {overrides: {harnessConversation: context().selection}}});
});
it.each(['branch', 'target', 'unsupported'])('rejects %s context before registering an operation', async kind => {
    const f = await fixture(kind !== 'unsupported'), selected = context();
    if (kind === 'branch') selected.branchId = 'other';
    if (kind === 'target') selected.target = {...target, version: '2'};
    await expect(f.binding.operations.register({context: f.operation, conversationId: 'parent', kind: 'send', status: 'submitting',
        input: {text: 'Task', attachments: [], target, context: selected}})).rejects.toHaveProperty('code', kind === 'unsupported' ? 'CONTEXT_SELECTION_UNAVAILABLE' : 'CONTEXT_DRAFT_SCOPE_CHANGED');
    expect(f.ledger.getSnapshot()).toEqual([]); expect(f.execute.mock.calls.some(([name]) => name === SessionCommand.Submit)).toBe(false);
});

it('rejects catalog drift before the operation ledger can become unknown', async () => {
    const f = await fixture(), original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (name, args) => {
        const page = await original(name, args);
        if (name === SessionCommand.ContextOptions) page!.sources![0].ref.revision = 4;
        return page;
    });
    await expect(f.binding.operations.register({context: f.operation, conversationId: 'parent', kind: 'send', status: 'submitting',
        input: {text: 'Task', attachments: [], target, context: context()}})).rejects.toHaveProperty('code', 'CONTEXT_BINDING_CHANGED');
    expect(f.ledger.getSnapshot()).toEqual([]); expect(f.execute.mock.calls.some(([name]) => name === SessionCommand.Submit)).toBe(false);
});
