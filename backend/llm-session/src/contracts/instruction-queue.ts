import type { ChatAttachment } from './chat';
import type { ExecutionOverrides, HistoryPolicy, SessionOrigin } from '../core/types';
import type { SendIntent } from '@itookit/llm-flow/contracts';

/** A durable user request; execution history is resolved only when it is dispatched. */
export interface SessionInstructionInput {
    text: string;
    files: ChatAttachment[];
    agentId: string;
    overrides?: ExecutionOverrides;
    origin?: SessionOrigin;
    historyPolicy?: HistoryPolicy;
    sendIntent?: SendIntent;
}

export interface SessionInstruction extends SessionInstructionInput {
    /** Digest of the original request, before host-derived bindings or attachment paths. */
    submissionDigest?: string;
    connectionBinding?: {
        /** Frozen remote Agent identity and execution target; credentials remain host-owned. */
        harnessAgent?: import('../core/types').ExecutorConfig;
        connectionId?: string;
        source?: 'run' | 'session' | 'agent' | 'system';
        defaults: import('@itookit/kernel-adapters/contracts').ModelDefaults;
        /** Safe connection/model choices captured before queue acceptance. */
        connections?: import('./flow-connection-snapshot').FlowConnectionSnapshot;
    };
    /** Host-resolved source definitions; accepted instructions do not follow later edits. */
    flowBinding?: {
        source?: 'explicit';
        definition: import('@itookit/llm-flow/contracts').FlowRevision;
        dependencies: import('@itookit/llm-flow/contracts').FlowRevision[];
        agent: import('../core/types').ExecutorConfig;
        connections: import('./flow-connection-snapshot').FlowConnectionSnapshot;
        /** Absent only for legacy accepted instructions. */
        plan?: import('./flow-run-plan').FlowRunPlan;
    };
    id: string;
    branch: string;
    createdAt: number;
    state: 'pending' | 'dispatching' | 'failed' | 'uncertain';
    error?: string;
}

export interface SessionInstructionQueue {
    sessionId: string;
    revision: number;
    paused: boolean;
    reason?: 'failed' | 'aborted' | 'branch-changed' | 'recovery';
    items: SessionInstruction[];
}

/** Every edit is conditional on the projection the caller actually saw. */
export type InstructionQueueEdit = { expectedRevision: number } & (
    | { action: 'remove'; id: string }
    | { action: 'reorder'; ids: string[] }
    | { action: 'merge'; ids: string[] }
    | { action: 'pause' }
    | { action: 'resume' }
    | { action: 'retry'; id: string }
);
