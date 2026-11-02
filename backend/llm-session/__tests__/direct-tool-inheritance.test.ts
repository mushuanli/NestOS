import {expect, it, vi} from 'vitest';
import {prepareDirectConversation, type DirectConversationInput} from '../src/session/direct-conversation';

it.each([
    [undefined, undefined, ['Read', 'Write']],
    [undefined, [], []],
    [undefined, ['custom'], ['custom']],
    [true, ['custom', 'Read'], ['Read', 'Write', 'custom']],
    [false, ['custom'], ['custom']],
] as const)('resolves inheritance %s and grants %j without mutating policy', async (inheritDefaultTools, ids, expected) => {
    const policy = {inheritDefaultTools, toolIds: ids ? [...ids] : undefined};
    const input = {task: {sessionId: 's', input: {sendIntent: {execution: {kind: 'agent', agentId: 'a', mode: 'agent'}}}},
        config: {capabilityPolicy: policy}, roundId: 'r'} as DirectConversationInput;
    const {execution} = await prepareDirectConversation({resolveHarnessToolIds: async () => ['Read', 'Write']}, input);
    expect(execution.config.capabilityPolicy?.toolIds).toEqual(expected);
    expect(policy.toolIds).toEqual(ids);
});
it('rejects invalid inheritance before granting tools', async () => {
    const resolveHarnessToolIds = vi.fn();
    const input = {task: {sessionId: 's', input: {}}, config: {capabilityPolicy: {inheritDefaultTools: 'yes'}}, roundId: 'r'};
    await expect(prepareDirectConversation({resolveHarnessToolIds}, input as unknown as DirectConversationInput)).rejects.toThrow('AGENT_TOOL_POLICY_INVALID');
    expect(resolveHarnessToolIds).not.toHaveBeenCalled();
});
