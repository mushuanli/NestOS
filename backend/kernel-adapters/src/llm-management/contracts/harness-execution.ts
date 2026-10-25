import type { EffectExecutionContext, EffectReconcileResult, JsonValue } from '@itookit/durable-kernel';

/** A named execution target references existing host-owned node credentials and project grants. */
export interface HarnessExecutionConnection {
    id: string;
    name: string;
    kind: 'harness';
    nodeConnectionId: string;
    projectId: string;
    profileId: string;
    enabled?: boolean;
    selection?: { modelId: string; reasoningEffort?: string };
}

/** Configuration revisions are independent of admission snapshots and retained deletion tombstones. */
export interface HarnessExecutionConnectionRecord {
    version: 1;
    revision: number;
    connection: HarnessExecutionConnection | null;
}

/** Settings discover only already-authorized project profiles, without endpoint or credential data. */
export interface HarnessExecutionConnectionTarget {
    nodeConnectionId: string;
    projectId: string;
    projectName: string;
    profiles: Array<{ id: string; name?: string; kind: string }>;
    available: boolean;
    errorCode?: string;
}

/** Admission freezes target identity; the host revalidates the grant before every acquisition. */
export interface HarnessConnectionSnapshot extends HarnessExecutionConnection {
    version: 1;
    revision: number;
    project: JsonValue;
}

export interface HarnessExecutionRequest {
    connection: HarnessConnectionSnapshot;
    prompt: string;
    attachments?: HarnessInputAttachment[];
    resourceHandleId: string;
    notificationKey: string;
}

/** Target adapters resolve authorized immutable assets before applying native inline limits. */
export type HarnessInputAttachment = HarnessInlineAttachment | HarnessAssetAttachment;
export interface HarnessInlineAttachment {kind: 'text' | 'image'; name: string; content: string; mimeType?: string;}
export interface HarnessAssetAttachment {kind: 'asset'; name: string; asset: import('@itookit/tools/contracts').BinaryAssetReference;}

export interface HarnessExecutionResult {
    text: string;
    sessionId: string;
    turnId: string;
    usage?: JsonValue;
}

/** Persisted notification/response channels keep interactions inside the active cancellable Effect. */
export interface HarnessInteractionNotification {
    id: string;
    kind: 'approval' | 'input';
    prompt: string;
    attachments?: HarnessInputAttachment[];
    payload?: JsonValue;
}

/**
 * Transport and project authorization are supplied by the application, never by model arguments.
 * A rejection may carry executionOutcome: 'not-started' only with authoritative evidence that no turn ran.
 * Other nonterminal execution errors retain an uncertain outcome at the Kernel boundary.
 */
export interface HarnessExecutionProvider {
    execute(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<HarnessExecutionResult>;
    reconcile(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<EffectReconcileResult<HarnessExecutionResult>>;
    cancel(request: HarnessExecutionRequest, context: EffectExecutionContext): Promise<void>;
}
