import type { DagRunSpec, FlowRevision, JsonValue, FlowCallSource, FlowResolvedInput } from '@itookit/llm-flow/contracts';

export const FlowInvocationCommand = { Invoke: 'session.flow.invoke', List: 'session.flow.invocations' } as const;
export interface FlowInvocationInput {
    /** Explicit independent call; ordinary submissions remain in the current Session. */
    execution?: 'child';
    connectionBindings?: Record<string, string>; connectionId?: string; sessionId: string; requestId: string;
    flowId: string; revision: number; parameters: Record<string, JsonValue>;
    source?: FlowCallSource;
    expectedSignature?: Pick<FlowRevision, 'id' | 'revision' | 'digest'>;
    inputSources?: Record<string, import('./content-transfer').TransferReference>;
    retryOfInvocationId?: string;
    /** Cross-Session reruns are limited to an explicitly created child of this source. */
    retryOfSessionId?: string;
}
export interface FlowInvocationRecord extends FlowInvocationInput {
    /** Host-owned route; parent records are references, not another execution. */
    executionSessionId?: string;
    callerSessionId?: string;
    target?: import('@itookit/llm-flow/contracts').TargetRef;
    /** Missing only in legacy records; use flowInvocationId for their stable read identity. */
    invocationId?: string;
    flow: FlowRevision;
    inputResolution?: FlowResolvedInput;
    inputResolutionDigest?: string;
    /** Admitted graph retained until the durable root owns the execution snapshot. */
    preparedGraph?: DagRunSpec;
    resolvedConnectionId?: string | null;
    createdAt: number;
    rootTaskId?: string;
    error?: string;
    branch?: string;
    head?: string | null;
    /** Validated immutable materials survive deletion or editing of their source conversation. */
    inputTransfers?: Record<string, import('./content-transfer').ContentTransfer>;
}

/** Legacy aliases are deterministic and do not mint another identity during recovery. */
export function flowInvocationId(record: Pick<FlowInvocationRecord, 'invocationId' | 'sessionId' | 'requestId'>): string {
    return record.invocationId ?? `legacy:${encodeURIComponent(record.sessionId)}:${encodeURIComponent(record.requestId)}`;
}
