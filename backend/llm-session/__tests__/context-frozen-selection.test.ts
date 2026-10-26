import {afterEach, expect, it, vi} from 'vitest';
import {ContextAssembler, type ContextPlan} from '@itookit/llm-context';
import {ConversationContextBuilder} from '../src/session/conversation-context';
import {snapshotDirectAgentPolicy} from '../src/contracts/direct-agent-policy';

const builder = () => new ConversationContextBuilder({engine: {getManifest: async () => ({})}, loadArtifact: async () => null} as never,
    snapshotDirectAgentPolicy());
function input(profile?: {id: string; revision: number}) {
    return {task: {id: 'request', sessionId: 'actual-session', input: {text: 'Private input'},
        frozen: {branchRef: 'main', branchHead: null, contextProfile: profile}},
        config: {id: 'agent'}, roundId: 'round', contextFiles: [], log: {
            loadManifest: async () => ({currentBranch: 'other', branches: {main: 'later-round', other: 'unrelated'},
                branchMeta: {main: {contextProfile: {id: 'new-profile', revision: 9}}}}),
        }};
}
afterEach(() => {vi.restoreAllMocks();});
it('preserves a frozen empty branch head when history advances before preparation', async () => {
    expect(await builder().resolveLocation(input() as never)).toEqual({branchRef: 'main', branchHead: null});
});
it.each([undefined, {id: 'admitted-profile', revision: 2}])('uses the admitted profile %s rather than a later branch setting', async profile => {
    const assemble = vi.spyOn(ContextAssembler.prototype, 'assemble').mockResolvedValue({snapshot: {} as never, messages: []});
    await builder().assemble(input(profile) as never, {branchRef: 'main', branchHead: null});
    const plan = assemble.mock.calls[0][0] as ContextPlan;
    expect(plan.profile).toEqual(profile ?? {id: '', revision: 0});
});
