import type { FlowRevision, JsonValue } from '@itookit/llm-flow/contracts';

export const FlowInvocationCommand = { Invoke: 'session.flow.invoke', List: 'session.flow.invocations' } as const;
export interface FlowInvocationInput { connectionId?: string; sessionId: string; requestId: string; flowId: string; revision: number; parameters: Record<string, JsonValue> }
export interface FlowInvocationRecord extends FlowInvocationInput {
    flow: FlowRevision;
    resolvedConnectionId?: string | null;
    createdAt: number;
    rootTaskId?: string;
    error?: string;
    branch?: string;
    head?: string | null;
}
