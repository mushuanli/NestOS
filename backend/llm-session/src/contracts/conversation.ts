// Conversation log contracts. Runtime execution is owned by @itookit/durable-kernel.

import type { ChatMessage, Attachment } from '@itookit/llm-context';
import type { TokenUsage } from '@itookit/driver-llm/contracts';

// ─── Conversation Round ──────────────────────────────────────────────

/** ULID-based round ID. */
export type RoundId = string;

export interface ExecutionRef {
    taskId: string;
    role: 'primary' | 'background';
}

export interface ConversationRound {
    id: RoundId;
    sessionId: string;
    historyParentIds: string[];
    input: ChatMessage[];
    output: ChatMessage[];
    executions: ExecutionRef[];
    status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
    createdAt: number;
    completedAt?: number;
}

export interface Round extends ConversationRound {
    submission?: import('@itookit/llm-flow/contracts').SessionSubmission;
    /** Frozen workflow invocation owned by this branch round. */
    flow?: { flowId: import('@itookit/llm-flow/contracts').FlowId; connectionId?: string; revision: number; parameters?: Record<string, import('@itookit/llm-flow/contracts').JsonValue> };
    exposure?: 'public' | 'internal' | 'artifact';
    origin: 'merge' | 'rebase' | 'edit' | 'user';
    agentId?: string;
    usage?: TokenUsage;
    stale?: boolean;
    rebasedFrom?: RoundId;
    assembly?: AssemblyStrategy;
    defaultContextMode?: 'include' | 'exclude';
    defaultContextScope?: 'node' | 'subtree';
    result?: RoundResult;
    /** Failure reason for a terminal round without assistant output; projected into the transcript. */
    error?: string;
}

// ─── Conversation Log ────────────────────────────────────────────────

export interface ILog {
    append(ref: Ref, round: Round): Promise<RoundId>;
    fold(ref: Ref, strategy?: AssemblyStrategy): Promise<ChatMessage[]>;
    refs(): RefStore;
    merge(refs: Ref[], strategy: AssemblyStrategy): Promise<Ref>;
    rebase(ref: Ref, insertAfter: RoundId, rounds: Round[], opts?: { regenerate?: boolean }): Promise<Ref>;
}

export interface RefStore {
    create(name: string, at: RoundId): Ref | Promise<Ref>;
    move(ref: Ref, to: RoundId): void | Promise<void>;
    delete(ref: Ref): void | Promise<void>;
    list(): Ref[] | Promise<Ref[]>;
}

export type Ref = string;
export type RefName = string;

export type AssemblyStrategy =
    | { type: 'concat'; order: 'topo' | 'timestamp' }
    | { type: 'summarize-branches'; mainline: Ref }
    | { type: 'pick'; rounds: RoundId[] };

// ─── Signal — user interaction reduced to signals ────────────────────

export type Signal =
    | { type: 'send'; text: string; attachments?: Attachment[]; mode?: string }
    | { type: 'abort' }
    | { type: 'inject'; text: string }
    | { type: 'respond'; requestId: string; response: unknown }
    | { type: 'navigate'; ref: RefName };

export interface FlowActor {
    kind: 'node' | 'tool' | 'input' | 'approval';
    nodeId?: string;
    nodeName?: string;
    agentId?: string;
    skillIds?: string[];
    toolName?: string;
    toolCallId?: string;
    round?: number;
}

export interface FlowInteraction {
    parallelGroup?: string;
    requests?: Array<Omit<import('@itookit/llm-tasks/contracts').AgentEventLlmRequest, 'type'>>;
    actor?: FlowActor;
    input?: unknown;
    id: string;
    taskId: string;
    name: string;
    role: 'user' | 'assistant';
    status: 'running' | 'waiting_input' | 'success' | 'failed' | 'aborted';
    content: string;
    /** Model thinking for display only; kept separate from node output. */
    thinking?: string;
    createdAt: number;
    error?: string;
}

export interface RoundResult {
    /** Display projection only; never appended to model history. */
    flowInteractions?: FlowInteraction[];
    assistantBlocks: Array<{
        type: 'thinking' | 'text' | 'tool_use';
        [key: string]: unknown;
    }>;
    toolResults: Array<{
        toolUseId: string;
        content: string;
        isError: boolean;
    }>;
    usage?: TokenUsage;
    /** API-level finish reason from the final chunk (e.g. 'stop', 'length'). */
    finishReason?: string;
}
