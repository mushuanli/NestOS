import { expect, it } from 'vitest';
import { snapshotDirectAgentPolicy } from '../src/contracts/direct-agent-policy';
import { ConversationRunCoordinator } from '../src/session/conversation-run-coordinator';

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid exchange budget %s before admission', maxExchanges => {
    expect(() => new ConversationRunCoordinator({ directAgentPolicy: { maxExchanges } } as never)).toThrow('positive safe integer');
});

it('isolates concurrent policies and protects policy views from mutation', () => {
    const prompt = ['Host instruction'];
    const first = snapshotDirectAgentPolicy({ systemPrompt: prompt, maxExchanges: 3 });
    const second = snapshotDirectAgentPolicy({ systemPrompt: ['Other host'], maxExchanges: 7 });
    prompt[0] = 'Changed';
    expect(first).toEqual({ systemPrompt: ['Host instruction'], maxExchanges: 3 });
    expect(second).toEqual({ systemPrompt: ['Other host'], maxExchanges: 7 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.systemPrompt)).toBe(true);
    expect(snapshotDirectAgentPolicy().systemPrompt).toEqual([]);
});
