import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createSessionChatBinding} from './session';

function fixture() {
    let contract = {targetId: 'reader', label: 'Reader', signature: {id: 'flow', revision: 1, digest: 'published'}};
    let changed = () => {};
    const execute = vi.fn(async () => {}), committed = vi.fn(async () => true);
    const binding = createSessionChatBinding({session: {id: 'session', getSnapshot: () => ({view: {manifest: {currentBranch: 'main'}}}),
        onEvent: () => () => {}, getSessions: () => [], isGenerating: () => false} as never,
        commands: {execute} as never, hasCommittedSubmission: committed, operations: createOperationLedger(),
        inputContract: () => contract, subscribeInput: callback => {changed = callback; return () => {};}});
    const input = {text: '', attachments: [], input: {targetId: 'reader', signature: {...contract.signature}, values: {count: 0}}};
    const context = {operationId: 'structured-submit', viewId: binding.source.getSnapshot().viewId};
    return {binding, execute, input, context, committed, change: () => {contract = {...contract, signature: {...contract.signature, revision: 2}}; changed();}};
}

it('projects the published input contract and sends frozen arguments through the normal Session queue ingress', async () => {
    const f = fixture();
    expect(f.binding.source.getSnapshot().inputContract?.signature).toEqual(f.input.input.signature);
    expect(await f.binding.actions.send!(f.input, f.context)).toMatchObject({status: 'accepted'});
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.Send, expect.objectContaining({text: '', agentId: 'reader',
        overrides: {flowParameters: {count: 0}, flowExpectedSignature: f.input.input.signature},
        sendIntent: expect.objectContaining({submission: {id: 'structured-submit', source: {kind: 'conversation', ownerId: 'session', id: 'structured-submit'}}})}));
    f.binding.dispose();
});

it('rejects changed contracts and conflicting selector targets before dispatch', async () => {
    const f = fixture();
    expect(await f.binding.actions.send!({...f.input, selection: {agentId: 'other'}}, f.context)).toMatchObject({status: 'rejected', code: 'STALE_INPUT_SIGNATURE'});
    f.change();
    expect(await f.binding.actions.send!(f.input, f.context)).toMatchObject({status: 'rejected', code: 'STALE_INPUT_SIGNATURE'});
    expect(await f.binding.actions.send!({text: 'legacy', attachments: []}, f.context)).toMatchObject({status: 'rejected'});
    expect(f.execute).not.toHaveBeenCalled(); expect(f.committed).not.toHaveBeenCalled();
    f.binding.dispose();
});
