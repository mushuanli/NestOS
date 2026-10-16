import type { DagRunSpec, FlowRevision, JsonValue } from '@itookit/llm-flow/contracts';

export const FlowInvocationCommand = { Invoke: 'session.flow.invoke', List: 'session.flow.invocations' } as const;
export interface FlowInvocationInput { connectionBindings?: Record<string, string>; connectionId?: string; sessionId: string; requestId: string; flowId: string; revision: number; parameters: Record<string, JsonValue> }
export interface FlowInvocationRecord extends FlowInvocationInput {
    flow: FlowRevision;
    /** Admitted graph retained until the durable root owns the execution snapshot. */
    preparedGraph?: DagRunSpec;
    resolvedConnectionId?: string | null;
    createdAt: number;
    rootTaskId?: string;
    error?: string;
    branch?: string;
    head?: string | null;
}
