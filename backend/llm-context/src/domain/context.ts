type RoundId = string;
type RefName = string;
import type { ChatMessage } from './message';

// ─── Brand aliases (Phase 2: string-based; branded IDs deferred to Phase 3) ─

export type ContextProfileId = string;
export type ContextSnapshotId = string;

// ─── BranchContextProfile ──────────────────────────────────────────────────

/** Per-branch context profile — immutable versioned object. */
export interface BranchContextProfile {
    id: ContextProfileId;
    revision: number;
    createdAt: number;

    /** Per-round context rules. Missing key → fall back to default. */
    rules: Record<RoundId, ContextRule>;
}

export type ContextRule =
    | { mode: 'include'; scope?: 'node' | 'subtree' }
    | { mode: 'exclude'; scope?: 'node' | 'subtree' }
    | { mode: 'summary'; artifactId: string; scope?: 'node' | 'subtree' };

// ─── ContextPlan (assembler input) ─────────────────────────────────────────

export interface ContextPlan {
    branchRef: RefName;
    branchHead: RoundId | null;
    profile: { id: ContextProfileId; revision: number };

    /**
     * The prompt being sent now. Always supplied by the caller; the assembler drops
     * the pending copy itself when the Round that owns it (`pendingRoundId`) is
     * actually included in context and already carries the same user message.
     * Deciding this in the caller from "the Round exists" loses the prompt whenever
     * that Round is excluded or summarized by the branch context policy.
     */
    pendingUserMessage?: ChatMessage;
    /** Round owning `pendingUserMessage`; its inclusion decides the de-duplication. */
    pendingRoundId?: RoundId;
    explicitInputs: InputBinding[];
    tokenBudget?: number;
}

export type InputBinding =
    | { kind: 'artifact'; artifactId: string; label: string; order: number }
    | { kind: 'upstream-output'; taskRunId: string; outputPort: string; inputLabel: string; order: number }
    | { kind: 'round'; roundId: RoundId; label: string; order: number }
    | { kind: 'text'; content: string; label: string; order: number };

// ─── ContextBlock (internal assembler representation) ──────────────────────

export type ContextBlock =
    | { kind: 'round'; roundId: RoundId; messages: ChatMessage[] }
    | { kind: 'summary'; sourceRoundIds: RoundId[]; artifactId: string }
    | { kind: 'artifact'; artifactId: string; label: string }
    | { kind: 'memory'; entryId: string; namespaceId: string; contentHash: string; content?: string }
    | { kind: 'system'; source: 'agent' | 'skill' | 'runtime' | 'project' | 'session-skill' | 'skill-index'; content: string };

// ─── ContextSnapshot (frozen output) ───────────────────────────────────────

export interface ContextSnapshot {
    id: ContextSnapshotId;
    taskRunId: string;
    createdAt: number;

    branchRef: RefName;
    branchHead: RoundId | null;
    profile: { id: ContextProfileId; revision: number };
    agent: { id: string; version: string };

    blocks: ContextBlock[];
    canonicalMessages: ChatMessage[];
    tokenCount: number;
    digest: string;
    explanation?: ContextExplanation;
}

export interface ContextDecision {
    source: string;
    reason: string;
    priority: number;
    required: boolean;
    tokenCount: number;
}

export interface ContextExplanation {
    included: ContextDecision[];
    excluded: ContextDecision[];
    summarized: ContextDecision[];
    tokenCount: number;
    digest: string;
}
