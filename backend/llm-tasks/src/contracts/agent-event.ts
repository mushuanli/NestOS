import type { AgentEventStreamThinking, AgentEventStreamContent, AgentEventCitations, AgentEventLlmRequest } from '@itookit/driver-llm/contracts';
export type { AgentEventStreamThinking, AgentEventStreamContent, AgentEventCitations, AgentEventLlmRequest } from '@itookit/driver-llm/contracts';
// Canonical AgentEvent schema — single event vocabulary for the entire LLM subsystem.
//
// Replaces 5 event vocabularies + 3 translation layers (~91 events) with ~22 events.
//
// Design rules:
//   - lifecycle / log-mutation events are authoritative (written to Log)
//   - streaming events are transient (never written to Log, overwritten by authoritative fall)
//   - tool events follow queued→running→success/error lifecycle
//   - await_signal is the ONLY pause mechanism (unifies HITL / plan-confirm / request_input)

import type { TokenUsage } from '@itookit/driver-llm/contracts';

// ─── Round lifecycle (authoritative) ──────────────────────────────────

export interface AgentEventRoundStart {
    type: 'round:start';
    roundId: string;
    sessionId: string;
    round: number;
}

export interface AgentEventRoundEnd {
    type: 'round:end';
    roundId: string;
    sessionId: string;
    round: number;
}

export interface AgentEventFinished {
    type: 'finished';
    usage: TokenUsage;
}

export interface AgentEventError {
    type: 'error';
    error: {
        message: string;
        code?: string;
        stack?: string;
    };
}

// ─── Tool lifecycle ──────────────────────────────────────────────────

export interface ToolCallInfo {
    toolId: string;
    name: string;
    input?: Record<string, unknown>;
}

export interface AgentEventToolQueued {
    type: 'tool:queued';
    call: ToolCallInfo;
}

export interface AgentEventToolRunning {
    type: 'tool:running';
    call: ToolCallInfo;
}

export interface AgentEventToolInput {
    type: 'tool:input';
    call: ToolCallInfo & { delta: string };
}

export interface AgentEventToolProgress {
    type: 'tool:progress';
    call: ToolCallInfo & { progress: import('@itookit/tools/contracts').ToolProgress };
}

export interface AgentEventToolSuccess {
    type: 'tool:success';
    call: ToolCallInfo & { result: string };
}

export interface AgentEventToolError {
    type: 'tool:error';
    call: ToolCallInfo & { error: string };
}

// ─── Pause protocol (unifies HITL / plan-confirm / request_input) ────

export interface PauseRequest {
    requestId: string;
    reason: 'hitl_confirm' | 'plan_confirm' | 'request_input' | string;
    message: string;
    options?: Array<{ label: string; value: unknown }>;
}

export interface AgentEventAwaitSignal {
    type: 'await_signal';
    request: PauseRequest;
}

// ─── Pause resolved ──────────────────────────────────────────────────

export interface AgentEventSignalResolved {
    type: 'signal_resolved';
    requestId: string;
}

// ─── Log mutations (UI re-projects on these) ─────────────────────────

export interface AgentEventLogAppended {
    type: 'log:appended';
    ref: string;
    roundId: string;
}

export interface AgentEventLogRefMoved {
    type: 'log:ref_moved';
    ref: string;
    previousHead: string;
    newHead: string;
}

export interface AgentEventLogRefRenamed {
    type: 'log:ref_renamed';
    ref: string;
    oldName: string;
    newName: string;
}

export interface AgentEventLogRefCreated {
    type: 'log:ref_created';
    ref: string;
}

export interface AgentEventLogRefDeleted {
    type: 'log:ref_deleted';
    ref: string;
}

export interface AgentEventLogMerged {
    type: 'log:merged';
    mergeRoundId: string;
    refs: string[];
}

// ─── Budget / context middleware events ──────────────────────────────

export interface AgentEventBudgetWarning {
    type: 'budget:warning';
    remaining: number;
    total: number;
}

export interface AgentEventBudgetExhausted {
    type: 'budget:exhausted';
    used: number;
    total: number;
}

export interface AgentEventContextCompressed {
    type: 'context:compressed';
    originalTokens: number;
    reducedTokens: number;
}

export interface AgentEventContextSnapshotCreated {
    type: 'context:snapshot_created';
    taskRunId: string;
    snapshotId: string;
    tokenCount: number;
}

export interface EventEnvelope<T> {
    eventId: string;
    sequence: number;
    occurredAt: number;
    sessionId?: string;
    goalId?: string;
    taskRunId?: string;
    causationId?: string;
    correlationId?: string;
    event: T;
}

// ─── Canonical union ─────────────────────────────────────────────────

export type AgentEvent =
    | AgentEventLlmRequest
    | AgentEventRoundStart
    | AgentEventRoundEnd
    | AgentEventFinished
    | AgentEventError
    | AgentEventStreamThinking
    | AgentEventStreamContent
    | AgentEventCitations
    | AgentEventToolQueued
    | AgentEventToolRunning
    | AgentEventToolInput
    | AgentEventToolProgress
    | AgentEventToolSuccess
    | AgentEventToolError
    | AgentEventAwaitSignal
    | AgentEventSignalResolved
    | AgentEventLogAppended
    | AgentEventLogRefMoved
    | AgentEventLogRefRenamed
    | AgentEventLogRefCreated
    | AgentEventLogRefDeleted
    | AgentEventLogMerged
    | AgentEventBudgetWarning
    | AgentEventBudgetExhausted
    | AgentEventContextCompressed
    | AgentEventContextSnapshotCreated
    ;
