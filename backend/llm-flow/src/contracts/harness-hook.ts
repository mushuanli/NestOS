import type { JsonValue } from './flow-definition';

export type HarnessHookEvent =
    | 'run.started'
    | 'run.completed'
    | 'task.started'
    | 'task.completed'
    | 'task.failed'
    | 'agent.spawned'
    | 'agent.stopped'
    | 'tool.before'
    | 'tool.after'
    | 'approval.requested'
    | 'context.beforeCompact'
    | 'context.afterCompact';

export interface HarnessHookContext {
    event: HarnessHookEvent;
    sessionId: string;
    runId?: string;
    nodeId?: string;
    taskId?: string;
    payload?: JsonValue;
}

export interface HarnessHookResult {
    action?: 'continue' | 'deny';
    message?: string;
}

/** Host-provided trusted hook boundary; hook implementations are not stored in a Flow. */
export interface HarnessHookRunner {
    readonly descriptor: {
        source: string;
        contentHash: string;
        trusted: boolean;
        timeoutMs?: number;
        maxMessageLength?: number;
    };
    emit(context: HarnessHookContext): Promise<HarnessHookResult | void>;
}
