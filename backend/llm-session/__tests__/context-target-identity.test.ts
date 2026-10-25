import {expect, it, vi} from 'vitest';
import {ContextAssembler} from '@itookit/llm-context';
import {ConversationContextBuilder} from '../src/session/conversation-context';
import {snapshotDirectAgentPolicy} from '../src/contracts/direct-agent-policy';

it('records the admitted Flow revision as the context identity without inventing an Agent version', async () => {
    const assemble = vi.spyOn(ContextAssembler.prototype, 'assemble').mockResolvedValue({snapshot: {} as never, messages: []});
    const builder = new ConversationContextBuilder({engine: {getManifest: async () => ({})}, loadArtifact: async () => null} as never,
        snapshotDirectAgentPolicy());
    const execution = {task: {id: 'task', sessionId: 's', input: {text: 'Request'}},
        config: {id: 'worker', type: 'flow', target: {kind: 'flow', id: 'worker', version: '3', digest: 'flow-digest'}},
        roundId: 'r', contextFiles: [], log: {loadManifest: async () => ({branchMeta: {}})}};
    try {
        await builder.assemble(execution as never, {branchRef: 'main', branchHead: null});
        expect(assemble.mock.calls[0][2]).toMatchObject({id: 'worker', version: '3'});
    } finally {assemble.mockRestore();}
});
