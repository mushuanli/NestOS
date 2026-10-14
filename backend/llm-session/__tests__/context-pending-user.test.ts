import { expect, it, vi } from 'vitest';
import type { ContextPlan } from '@itookit/llm-context';
import { ContextAssembler } from '@itookit/llm-context';
import { ConversationContextBuilder } from '../src/session/conversation-context';
import { snapshotDirectAgentPolicy } from '../src/contracts/direct-agent-policy';

function builder(): ConversationContextBuilder {
    return new ConversationContextBuilder({ engine: {}, loadArtifact: async () => null } as never, snapshotDirectAgentPolicy());
}

/** Regenerate/resend reuses the Round as branch head; the plan must still carry the prompt. */
it('always plans the pending user message with its owning Round', async () => {
    const assemble = vi.spyOn(ContextAssembler.prototype, 'assemble')
        .mockResolvedValue({ snapshot: {} as never, messages: [] });
    try {
        const execution = {
            task: { id: 'run', sessionId: 'session', input: { text: 'current question' } },
            config: { id: 'agent' },
            roundId: 'r1',
            log: {
                loadManifest: async () => ({ currentBranch: 'main', branches: { main: 'r1' }, branchMeta: {} }),
                readRound: async () => ({ input: [], output: [], historyParentIds: [] }),
            },
        };
        await builder().assemble(execution as never, { branchRef: 'main', branchHead: 'r1' });

        const plan = assemble.mock.calls[0][0] as ContextPlan;
        expect(plan.pendingUserMessage).toEqual({ role: 'user', content: 'current question' });
        expect(plan.pendingRoundId).toBe('r1');
    } finally {
        assemble.mockRestore();
    }
});
