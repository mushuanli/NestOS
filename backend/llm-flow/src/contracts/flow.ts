import type { FlowId, JsonValue } from './flow-definition';
import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';

export type FlowNodeId = string;

/** Business call identity; Kernel task attempts and native context bindings are separate. */
export interface InvocationIdentity {
    invocationId: string;
    parentInvocationId?: string;
    retryOfInvocationId?: string;
    retryOfSessionId?: string;
}

export function isInvocationIdentity(value: unknown): value is InvocationIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const identity = value as InvocationIdentity;
    const valid = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 1024;
    const allowed = ['invocationId', 'parentInvocationId', 'retryOfInvocationId', 'retryOfSessionId'];
    return Object.keys(value).every(key => allowed.includes(key)) && valid(identity.invocationId)
        && ['parentInvocationId', 'retryOfInvocationId', 'retryOfSessionId'].every(key => {
        const id = (identity as unknown as Record<string, unknown>)[key]; return id === undefined || valid(id);
    }) && (identity.retryOfSessionId === undefined || identity.retryOfInvocationId !== undefined);
}

export function invocationLabels(identity?: InvocationIdentity): Record<string, string> {
    return identity ? Object.fromEntries(Object.entries(identity).filter(([key, value]) =>
        ['invocationId', 'parentInvocationId', 'retryOfInvocationId', 'retryOfSessionId'].includes(key) && typeof value === 'string')) : {};
}

/** Opaque host correlation; the conversation layer does not interpret source policy. */
export interface SessionSubmission { id: string; source: { kind: string; ownerId: string; id: string } }

export interface SendIntent {
    submission?: SessionSubmission;
    branch: {
        mode: 'continue' | 'fork';
        baseRoundId?: string;
        newBranchName?: string;
    };
    retention: {
        mode: 'persistent' | 'temporary';
    };
    execution:
        | { kind: 'agent'; agentId: string; mode?: ChatExecutionMode }
        | { kind: 'flow'; connectionBindings?: Record<string, string>; flowId: FlowId; revision?: number; parameters?: Record<string, JsonValue> };
}

export function createAgentSendIntent(agentId: string): SendIntent {
    return {
        branch: { mode: 'continue' },
        retention: { mode: 'persistent' },
        execution: { kind: 'agent', agentId },
    };
}
