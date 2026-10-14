import type {
    ContextBlock,
    ContextPlan,
    BranchContextProfile,
    ContextSnapshot,
    ContextSnapshotId,
    ContextExplanation,
} from '../domain/context';
import type { ChatMessage } from '../domain/message';
import { sha256Hex } from '../content/digest';
import { collectContextLineage } from './round-history';
type RoundId = string;
type Artifact = { content: unknown; contentHash?: string };
const generateUUID = () => globalThis.crypto?.randomUUID?.() ?? `context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
import { ProviderMessageAdapter, type ProviderKind } from './provider-message-adapter';

export interface RetrievedMemoryEntry {
    entryId: string;
    namespaceId: string;
    content: string;
    contentHash: string;
}

export interface ContextAssemblerDeps {
    log?: unknown;
    profileStore: {
        getProfile(
            profileId: string,
            revision?: number,
        ): Promise<BranchContextProfile | null>;
    };
    snapshotStore?: { save(snapshot: ContextSnapshot): Promise<ContextSnapshot> };
    readRound: (roundId: RoundId) => Promise<{
        input: ChatMessage[];
        output: ChatMessage[];
        historyParentIds: RoundId[];
        defaultContextMode?: 'include' | 'exclude';
        _deleted?: boolean;
    } | null>;
    loadArtifact?: (artifactId: string) => Promise<Artifact | null>;
    retrieveMemory?: (
        plan: ContextPlan,
        agent: { id: string; version: string },
    ) => Promise<RetrievedMemoryEntry[]>;
    providerAdapter?: ProviderMessageAdapter;
    provider?: ProviderKind;
}

export interface AssemblyOptions {
    persist?: boolean; projectInstructions?: string; skillInstructions?: string; skillIndex?: string;
}

export interface AssemblyResult {
    snapshot: ContextSnapshot;
    messages: ChatMessage[];
}

/** Deterministic, auditable ContextPlan -> ContextSnapshot pipeline. */
export interface IContextAssembler {
    assemble(plan: ContextPlan, taskRunId: string, agent: { id: string; version: string },
        systemPrompt?: string[] | string, skillsPrompt?: string,
        options?: AssemblyOptions): Promise<AssemblyResult>;
}

export type ContextAssemblerFactory = (deps: ContextAssemblerDeps) => IContextAssembler;
export const createContextAssembler: ContextAssemblerFactory = deps => new ContextAssembler(deps);

export class ContextAssembler implements IContextAssembler {
    constructor(private readonly deps: ContextAssemblerDeps) {}

    async assemble(
        plan: ContextPlan, taskRunId: string, agent: { id: string; version: string },
        systemPrompt?: string[] | string, skillsPrompt?: string, options: AssemblyOptions = {},
    ): Promise<AssemblyResult> {
        const blocks = this.policyBlocks(systemPrompt, skillsPrompt, options);
        blocks.push(...await this.historyBlocks(plan));
        for (const memory of await this.deps.retrieveMemory?.(plan, agent) ?? []) blocks.push({ kind: 'memory', ...memory });
        blocks.push(...await this.inputBlocks(plan));
        const pending: ContextBlock | null = plan.pendingUserMessage
            ? { kind: 'round', roundId: '', messages: [plan.pendingUserMessage] } : null;
        if (pending) blocks.push(pending);
        let selected = await this.fitTokenBudget(blocks, plan.tokenBudget, pending);
        if (pending) selected = this.dropDuplicatedPending(selected, plan, pending);
        const messages = (this.deps.providerAdapter ?? new ProviderMessageAdapter()).validate(
            await this.flattenBlocks(selected), { provider: this.deps.provider ?? 'generic' });
        const snapshot = this.snapshot(plan, taskRunId, agent, selected, messages);
        const persisted = await this.persist(snapshot, options.persist !== false);
        if (persisted.explanation) persisted.explanation.digest = persisted.digest;
        return { snapshot: persisted, messages: persisted.canonicalMessages };
    }

    private async historyBlocks(plan: ContextPlan): Promise<ContextBlock[]> {
        const profile = plan.profile.id ? await this.deps.profileStore.getProfile(plan.profile.id, plan.profile.revision) : null;
        const blocks: ContextBlock[] = [];
        for (const { roundId, messages, defaultContextMode } of await this.collectMainline(plan.branchHead)) {
            const rule = profile?.rules[roundId];
            if (rule?.mode === 'exclude' || (!rule && defaultContextMode === 'exclude')) continue;
            if (rule?.mode === 'summary') {
                await this.requireArtifact(rule.artifactId);
                blocks.push({ kind: 'summary', sourceRoundIds: [roundId], artifactId: rule.artifactId });
            } else blocks.push({ kind: 'round', roundId, messages: [...messages] });
        }
        return blocks;
    }

    private async inputBlocks(plan: ContextPlan): Promise<ContextBlock[]> {
        const blocks: ContextBlock[] = [];
        for (const binding of [...(plan.explicitInputs ?? [])].sort((a, b) => a.order - b.order)) {
            if (binding.kind === 'artifact') {
                await this.requireArtifact(binding.artifactId);
                blocks.push({ kind: 'artifact', artifactId: binding.artifactId, label: binding.label });
            } else if (binding.kind === 'round') {
                const round = await this.deps.readRound(binding.roundId);
                if (!round || round._deleted) throw new Error(`Context round not found: ${binding.roundId}`);
                blocks.push({ kind: 'round', roundId: binding.roundId, messages: [...round.input, ...round.output] });
            } else if (binding.kind === 'text') {
                blocks.push({ kind: 'system', source: 'runtime', content: `${binding.label}:\n${binding.content}` });
            }
        }
        return blocks;
    }

    private policyBlocks(systemPrompt: string[] | string = [], skillsPrompt: string | undefined, options: AssemblyOptions): ContextBlock[] {
        const prompts = typeof systemPrompt === 'string' ? [systemPrompt] : systemPrompt;
        const blocks: ContextBlock[] = prompts.filter(Boolean).map(content => ({ kind: 'system', source: 'agent', content }));
        const contributions = { project: options.projectInstructions, 'session-skill': options.skillInstructions,
            'skill-index': options.skillIndex, skill: skillsPrompt } as const;
        for (const [source, content] of Object.entries(contributions)) {
            if (content) blocks.push({ kind: 'system', source: source as keyof typeof contributions, content });
        }
        return blocks;
    }

    private snapshot(plan: ContextPlan, taskRunId: string, agent: { id: string; version: string },
        blocks: ContextBlock[], canonicalMessages: ChatMessage[]): ContextSnapshot {
        const tokenCount = this.estimateTokens(canonicalMessages);
        return { id: generateUUID() as ContextSnapshotId, taskRunId, createdAt: Date.now(), branchRef: plan.branchRef,
            branchHead: plan.branchHead, profile: plan.profile, agent, blocks, canonicalMessages,
            tokenCount, digest: '', explanation: this.explain(blocks, tokenCount) };
    }

    private async persist(snapshot: ContextSnapshot, persist: boolean): Promise<ContextSnapshot> {
        if (!persist) return { ...snapshot, digest: await this.sha256(JSON.stringify(snapshot.canonicalMessages)) };
        if (!this.deps.snapshotStore) throw new Error('Context snapshot persistence is not configured');
        return this.deps.snapshotStore.save(snapshot);
    }

    private async collectMainline(branchHead: RoundId | null): Promise<Array<{
        roundId: RoundId;
        messages: ChatMessage[];
        defaultContextMode?: 'include' | 'exclude';
    }>> {
        return (await collectContextLineage(branchHead, this.deps.readRound)).map(({ id, round }) => ({
            roundId: id, messages: [...round.input, ...round.output], defaultContextMode: round.defaultContextMode,
        }));
    }

    /**
     * A regenerate/resend Round already carries this prompt. Drop the appended copy
     * only when that Round survived trimming with the same user message; an excluded,
     * summarized or trimmed-away Round must keep the copy.
     */
    private dropDuplicatedPending(blocks: ContextBlock[], plan: ContextPlan, pending: ContextBlock): ContextBlock[] {
        const prompt = plan.pendingUserMessage;
        if (!prompt || !plan.pendingRoundId) return blocks;
        const carried = blocks.some(block => block !== pending && block.kind === 'round'
            && block.roundId === plan.pendingRoundId
            && block.messages.some(message => sameUserMessage(message, prompt)));
        return carried ? blocks.filter(block => block !== pending) : blocks;
    }

    private async flattenBlocks(blocks: ContextBlock[]): Promise<ChatMessage[]> {
        const messages: ChatMessage[] = [];
        for (const block of blocks) {
            if (block.kind === 'round') {
                messages.push(...block.messages);
            } else if (block.kind === 'system') {
                messages.push({ role: block.source === 'runtime' ? 'user' : 'system', content: block.content });
            } else if (block.kind === 'summary' || block.kind === 'artifact') {
                const artifact = await this.requireArtifact(block.artifactId);
                const label = block.kind === 'summary' ? 'Conversation summary' : block.label;
                messages.push({ role: 'user', tags: ['context-reference'], content: `${label}:\n${this.artifactText(artifact)}` });
            } else if (block.kind === 'memory') {
                messages.push({
                    role: 'user', tags: ['context-reference'],
                    content: `Memory (${block.namespaceId}/${block.entryId}):\n${block.content ?? ''}`,
                });
            }
        }
        return messages;
    }

    private async fitTokenBudget(blocks: ContextBlock[], tokenBudget?: number, keep?: ContextBlock | null): Promise<ContextBlock[]> {
        if (!tokenBudget || tokenBudget < 1) return blocks;
        const kept = [...blocks];
        while (kept.length > 1 && this.estimateTokens(await this.flattenBlocks(kept)) > tokenBudget) {
            // Discard discovery metadata first; preserve policy and the final pending user.
            const discovery = kept.findIndex(block => block.kind === 'system' && block.source === 'skill-index');
            const index = discovery >= 0 ? discovery
                : kept.findIndex((block, i) => block.kind !== 'system' && i !== kept.length - 1 && block !== keep);
            if (index < 0) break;
            kept.splice(index, 1);
        }
        return kept;
    }

    private async requireArtifact(artifactId: string): Promise<Artifact> {
        const artifact = await this.deps.loadArtifact?.(artifactId) ?? null;
        if (!artifact) throw new Error(`Context artifact not found: ${artifactId}`);
        const actual = await this.sha256(this.artifactText(artifact));
        if (artifact.contentHash && actual !== artifact.contentHash) {
            throw new Error(`Context artifact hash mismatch: ${artifactId}`);
        }
        return artifact;
    }

    private artifactText(artifact: Artifact): string {
        return typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content);
    }

    private estimateTokens(messages: ChatMessage[]): number {
        return Math.ceil(messages.reduce((chars, message) => chars + messageText(message).length, 0) / 4);
    }

    private explain(blocks: ContextBlock[], tokenCount: number): ContextExplanation {
        const included = blocks.filter(block => block.kind !== 'summary').map(block => ({
            source: block.kind === 'round' ? `round:${block.roundId}` : block.kind === 'artifact' ? `artifact:${block.artifactId}` : block.kind,
            reason: 'selected by branch/context policy', priority: block.kind === 'system' ? (block.source === 'skill-index' ? 30 : 100) : 50,
            required: block.kind === 'system' && block.source !== 'skill-index', tokenCount: Math.ceil(JSON.stringify(block).length / 4),
        }));
        const summarized = blocks.filter(block => block.kind === 'summary').map(block => ({
            source: `round:${block.sourceRoundIds.join(',')}`, reason: 'summary rule', priority: 40, required: false,
            tokenCount: 0,
        }));
        return { included, excluded: [], summarized, tokenCount, digest: '' };
    }

    private async sha256(input: string): Promise<string> {
        return sha256Hex(input);
    }
}

function messageText(message: ChatMessage): string {
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function sameUserMessage(candidate: ChatMessage, pending: ChatMessage): boolean {
    return candidate.role === 'user' && messageText(candidate) === messageText(pending);
}
