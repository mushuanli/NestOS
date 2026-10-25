import { describe, expect, it } from 'vitest';
import type { BranchContextProfile, ContextPlan, ContextSnapshot } from '@itookit/llm-context';

type Artifact = { id: string; content: unknown; contentHash?: string; [key: string]: unknown };
import { ContextAssembler } from './context-assembler';

async function hash(content: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fixture(options: { profile?: BranchContextProfile; artifact?: Artifact; tokenBudget?: number } = {}) {
    const rounds = new Map<string, any>([
        ['r1', {
            historyParentIds: [],
            input: [{ role: 'user', content: 'old question' }],
            output: [{ role: 'assistant', content: 'old answer' }],
        }],
        ['r2', {
            historyParentIds: ['r1'],
            input: [{ role: 'user', content: 'newer question' }],
            output: [{ role: 'assistant', content: 'newer answer' }],
        }],
    ]);
    const snapshots: ContextSnapshot[] = [];
    const assembler = new ContextAssembler({
        log: {} as any,
        manifest: {} as any,
        profileStore: { getProfile: async () => options.profile ?? null } as any,
        snapshotStore: {
            save: async (snapshot: ContextSnapshot) => {
                const persisted = { ...snapshot, digest: await hash(JSON.stringify(snapshot.canonicalMessages)) };
                snapshots.push(persisted);
                return persisted;
            },
        } as any,
        readRound: async id => rounds.get(id) ?? null,
        loadArtifact: async id => options.artifact?.id === id ? options.artifact : null,
        retrieveMemory: async () => [{ entryId: 'm1', namespaceId: 'agent', content: 'remember me', contentHash: 'memory-hash' }],
    });
    const plan: ContextPlan = {
        branchRef: 'main', branchHead: 'r2', profile: { id: 'p1', revision: 1 },
        pendingUserMessage: { role: 'user', content: 'pending question' }, explicitInputs: [],
        tokenBudget: options.tokenBudget,
    };
    return { assembler, plan, snapshots };
}

describe('ContextAssembler', () => {
    it('drops Skill discovery metadata before history while retaining loaded rules', async () => {
        const { assembler, plan } = await fixture({ tokenBudget: 100 });
        const result = await assembler.assemble(plan, 'run', { id: 'agent', version: '1' }, ['identity'], undefined,
            { skillInstructions: 'critical rule', skillIndex: 'index'.repeat(1000) });
        expect(result.messages.map(message => message.content)).toContain('old question');
        expect(result.messages.map(message => message.content)).toContain('critical rule');
        expect(result.snapshot.blocks.some(block => block.kind === 'system' && block.source === 'skill-index')).toBe(false);
        const roomy = await assembler.assemble({ ...plan, tokenBudget: 10000 }, 'run2', { id: 'agent', version: '1' }, [], undefined,
            { skillIndex: 'available metadata' });
        expect(roomy.snapshot.explanation?.included.some(item => item.priority === 30 && !item.required)).toBe(true);
    });

    it('applies profile rules, memory and returns the persisted digest', async () => {
        const profile: BranchContextProfile = {
            id: 'p1', revision: 1, createdAt: 1, rules: { r1: { mode: 'exclude' } },
        };
        const { assembler, plan } = await fixture({ profile });
        const result = await assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' }, 'system');
        expect(result.messages.map(message => message.content)).not.toContain('old question');
        expect(result.messages.map(message => message.content)).toContain('newer answer');
        expect(result.messages.some(message => String(message.content).includes('remember me'))).toBe(true);
        expect(result.messages.at(-1)).toMatchObject({ role: 'user', content: 'pending question' });
        expect(result.snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('materializes a hash-verified artifact input', async () => {
        const content = 'upstream final answer';
        const artifact: Artifact = {
            id: 'a1',
            nodeRunId: 'upstream',
            outputName: 'final',
            type: 'final-answer', content, contentHash: await hash(content), createdAt: 1,
        };
        const { assembler, plan } = await fixture({ artifact });
        plan.explicitInputs.push({ kind: 'artifact', artifactId: 'a1', label: 'source', order: 0 });
        const result = await assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' });
        expect(result.messages.some(message => String(message.content).includes(content))).toBe(true);
    });

    it('rejects missing or corrupt artifacts instead of hiding context damage', async () => {
        const artifact: Artifact = {
            id: 'a1',
            nodeRunId: 'upstream',
            outputName: 'final',
            type: 'final-answer', content: 'changed', contentHash: await hash('original'), createdAt: 1,
        };
        const { assembler, plan } = await fixture({ artifact });
        plan.explicitInputs.push({ kind: 'artifact', artifactId: 'a1', label: 'source', order: 0 });
        await expect(assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' })).rejects.toThrow(/hash mismatch/);
    });

    it('truncates only at ContextBlock boundaries and preserves pending user', async () => {
        const { assembler, plan } = await fixture({ tokenBudget: 12 });
        const result = await assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' });
        expect(result.snapshot.blocks.filter(block => block.kind === 'round')).toHaveLength(1);
        expect(result.messages.at(-1)).toMatchObject({ role: 'user', content: 'pending question' });
    });

    it('keeps the pending prompt when the owning Round is trimmed by the budget', async () => {
        const { assembler, plan } = await fixture({ tokenBudget: 12 });
        plan.pendingRoundId = 'r2';
        plan.pendingUserMessage = { role: 'user', content: 'newer question' };
        const result = await assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' }, ['system']);
        expect(result.messages.map(message => message.content)).toContain('newer question');
        expect(result.messages.filter(message => message.content === 'newer question')).toHaveLength(1);
    });

    it('drops the pending copy only when the owning Round reaches the context', async () => {
        const { assembler, plan } = await fixture();
        plan.pendingRoundId = 'r2';
        plan.pendingUserMessage = { role: 'user', content: 'newer question' };
        const result = await assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' });
        expect(result.messages.filter(message => message.content === 'newer question')).toHaveLength(1);
    });

    it('keeps the pending prompt when the owning Round is excluded from context', async () => {
        const profile: BranchContextProfile = { id: 'p1', revision: 1, createdAt: 1, rules: { r2: { mode: 'exclude' } } };
        const { assembler, plan } = await fixture({ profile });
        plan.pendingRoundId = 'r2';
        plan.pendingUserMessage = { role: 'user', content: 'newer question' };
        const result = await assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' }, ['system']);
        expect(result.messages.filter(message => message.content === 'newer question')).toHaveLength(1);
        expect(result.messages.at(-1)).toMatchObject({ role: 'user', content: 'newer question' });
    });

    it('keeps the pending prompt when the owning Round is summarized', async () => {
        const content = 'summary text';
        const artifact: Artifact = {
            id: 'sum1', nodeRunId: 'r2', outputName: 'summary', type: 'summary',
            content, contentHash: await hash(content), createdAt: 1,
        };
        const profile: BranchContextProfile = {
            id: 'p1', revision: 1, createdAt: 1, rules: { r2: { mode: 'summary', artifactId: 'sum1' } },
        };
        const { assembler, plan } = await fixture({ profile, artifact });
        plan.pendingRoundId = 'r2';
        plan.pendingUserMessage = { role: 'user', content: 'newer question' };
        const result = await assembler.assemble(plan, 'run-1', { id: 'agent', version: 'v1' }, ['system']);
        expect(result.messages.some(message => message.content === 'newer question')).toBe(true);
    });
});

it('resolves only policy-selected message materials and budgets the resolved content', async () => {
    const missing = {role: 'user' as const, content: 'missing material'};
    const assembler = new ContextAssembler({
        profileStore: {getProfile: async () => ({id: 'p1', revision: 1, createdAt: 1, rules: {r1: {mode: 'exclude'}}})},
        readRound: async id => id === 'r1' ? {input: [missing], output: [], historyParentIds: []} : null,
        resolveMessage: async message => {
            if (message === missing) throw new Error('required asset is missing');
            return {...message, content: 'verified-material-'.repeat(20)};
        },
    });
    const plan: ContextPlan = {branchRef: 'main', branchHead: 'r1', profile: {id: 'p1', revision: 1},
        pendingUserMessage: {role: 'user', content: 'current'}, explicitInputs: [], tokenBudget: 1000};
    const result = await assembler.assemble(plan, 'run', {id: 'agent', version: '1'}, [], undefined, {persist: false});
    expect(result.messages).toEqual([{role: 'user', content: 'verified-material-'.repeat(20)}]);
    expect(result.snapshot.tokenCount).toBe(Math.ceil('verified-material-'.repeat(20).length / 4));
    expect(result.snapshot.digest).toBe(await hash(JSON.stringify(result.messages)));
    await expect(assembler.assemble({...plan, profile: {id: '', revision: 0}}, 'other', {id: 'agent', version: '1'}, [], undefined, {persist: false}))
        .rejects.toThrow('required asset is missing');
});

it('does not discard a pending attachment change just because the text and owning Round match', async () => {
    const original = {role: 'user' as const, content: 'Review', attachments: [{type: 'file' as const, source: 'original.txt'}]};
    const assembler = new ContextAssembler({profileStore: {getProfile: async () => null},
        readRound: async () => ({input: [original], output: [], historyParentIds: []})});
    const plan: ContextPlan = {branchRef: 'main', branchHead: 'r1', pendingRoundId: 'r1', profile: {id: '', revision: 0},
        explicitInputs: [], pendingUserMessage: {...original, attachments: [{type: 'file', source: 'changed.txt'}]}};
    const changed = await assembler.assemble(plan, 'changed', {id: 'agent', version: '1'}, [], undefined, {persist: false});
    expect(changed.messages).toHaveLength(2);
    expect(changed.messages.at(-1)?.attachments?.[0].source).toBe('changed.txt');
    const same = await assembler.assemble({...plan, pendingUserMessage: original}, 'same', {id: 'agent', version: '1'}, [], undefined, {persist: false});
    expect(same.messages).toHaveLength(1);
});

it('keeps content and attachments separate when deduplicating a pending input', async () => {
    const attachments = [{type: 'file' as const, source: 'evidence.txt'}];
    const original = {role: 'user' as const, content: `Review\n${JSON.stringify(attachments)}`};
    const assembler = new ContextAssembler({profileStore: {getProfile: async () => null},
        readRound: async () => ({input: [original], output: [], historyParentIds: []})});
    const pending = {role: 'user' as const, content: 'Review', attachments};
    const plan: ContextPlan = {branchRef: 'main', branchHead: 'r1', pendingRoundId: 'r1', profile: {id: '', revision: 0},
        explicitInputs: [], pendingUserMessage: pending};
    const result = await assembler.assemble(plan, 'separate-materials', {id: 'agent', version: '1'}, [], undefined, {persist: false});
    expect(result.messages).toEqual([original, pending]);
});

it('keeps literal JSON text distinct from structured message content', async () => {
    const content = [{type: 'text' as const, text: 'Review'}];
    const original = {role: 'user' as const, content: JSON.stringify(content)};
    const pending = {role: 'user' as const, content};
    const assembler = new ContextAssembler({profileStore: {getProfile: async () => null},
        readRound: async () => ({input: [original], output: [], historyParentIds: []})});
    const plan: ContextPlan = {branchRef: 'main', branchHead: 'r1', pendingRoundId: 'r1', profile: {id: '', revision: 0},
        explicitInputs: [], pendingUserMessage: pending};
    const result = await assembler.assemble(plan, 'literal-and-structured', {id: 'agent', version: '1'}, [], undefined, {persist: false});
    expect(result.messages).toEqual([original, pending]);
});
