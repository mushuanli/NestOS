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
    connectionBinding?: { connectionId?: string; defaults: import('@itookit/kernel-adapters/contracts').ModelDefaults };
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
