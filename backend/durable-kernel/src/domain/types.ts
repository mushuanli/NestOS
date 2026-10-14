import type { CacheSpec, CacheRead, CachePublish, CacheNamespace, CacheEntry, CacheReceipt, CacheManagementAction, CacheManagementReceipt } from './cache';
export * from './cache';
import type { IFileSystem } from '@itookit/vfs-core';
import type { InteractionRecord, InteractionRequest, InteractionResponse } from './interaction';

export * from './interaction';

export type SessionId = string;
export type TaskId = string;
export type AttemptId = string;
export type EffectId = string;
export type HandleId = string;
export type ContextCommitId = string;
export type ResourceId = string;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SessionStatus = 'open' | 'suspending' | 'suspended' | 'closing' | 'closed' | 'archived';
export type TaskStatus = 'created' | 'blocked' | 'ready' | 'running' | 'waiting'
    | 'succeeded' | 'failed' | 'cancelled';

export interface ProgramRef { kind: string; version: string; }
export interface StorageBindingRef { kind: string; locator: JsonValue; }
export interface ResolvedStorageBinding { fs: IFileSystem; rootPath: string; }
export interface SessionStorageResolver {
    readonly kind: string;
    resolve(reference: StorageBindingRef): Promise<ResolvedStorageBinding>;
}

/** takeover requires the caller to have stopped the previous execution instance. */
export interface RecoveryOptions {
    takeover?: boolean;
    /**
     * Observation only: milliseconds spent on one Session, split between its own Kernel state
     * and its managed resources. Recovery decisions never read this timing.
     */
    onSessionRecovered?: (sessionId: SessionId, timing: RecoveryTiming) => void;
}
export interface RecoveryTiming { state: number; resources: number }

/**
 * Storage §5 manifest: what a writer relied on, so a reader never guesses a newer or
 * partially migrated layout. Absent on records written before layout manifests existed.
 */
export interface SessionLayout {
    layoutVersion: number;
    /** Schema revision per durable record family the writer owns. */
    recordSchemas: Record<string, number>;
    /** Capabilities the writer relied on; an opener lacking one must refuse the Session. */
    requiredCapabilities: string[];
    migration: { status: 'none' | 'pending' | 'complete'; to: number };
}

export interface SessionRecord {
    id: SessionId;
    status: SessionStatus;
    layout?: SessionLayout;
    closeMode?: 'drain' | 'cancel';
    registrationPending?: boolean;
    storage: StorageBindingRef;
    nextEventSeq: number;
    version: number;
    createdAt: number;
    updatedAt: number;
}

export interface SharedStateEntry<T extends JsonValue = JsonValue> {
    key: string;
    value: T;
    version: number;
    updatedAt: number;
    updatedByTaskId?: TaskId;
}

/** Same-store lease condition checked inside the mutation transaction using host time. */
export interface SharedLeaseCondition {
    key: string;
    ownerId: string;
    epoch: number;
}

export interface LeaseGuardOptions {
    lease?: SharedLeaseCondition;
}

export interface SharedStateWriteOptions extends LeaseGuardOptions {
    expectedVersion?: number | null;
    taskId?: TaskId;
}

export interface SharedStateRevision<T extends JsonValue = JsonValue> {
    key: string;
    version: number;
    value?: T;
    deleted: boolean;
    updatedAt: number;
    updatedByTaskId?: TaskId;
}

export interface CrossSessionMessage<T extends JsonValue = JsonValue> {
    id: string;
    sourceSessionId: SessionId;
    sourceTaskId?: TaskId;
    targetTaskId?: TaskId;
    correlationId?: string;
    requestFingerprint?: string;
    deliverySequence?: number;
    consumedAt?: number;
    /** Target recorded source settlement; source then recorded that acknowledgement. */
    settlementAcknowledgedAt?: number;
    targetSessionId: SessionId;
    topic: string;
    payload: T;
    status: 'pending' | 'delivered' | 'rejected';
    rejectedAt?: number;
    rejection?: { code: 'target-closed' | 'target-terminal' | 'target-ancestor-cancelled' | 'expired'; message: string };
    /** Absolute delivery deadline; omitted means retry missing targets indefinitely. */
    expiresAt?: number;
    deliveryAttempts?: number;
    nextAttemptAt?: number;
    lastDeliveryError?: string;
    createdAt: number;
    deliveredAt?: number;
}

export interface TaskMessageRequest {
    expiresAt?: number;
    idempotencyKey: string;
    targetSessionId: SessionId;
    targetTaskId: TaskId;
    topic: string;
    correlationId?: string;
    payload: JsonValue;
}

export interface ContextCommit<T extends JsonValue = JsonValue> {
    id: ContextCommitId;
    sessionId: SessionId;
    parentIds: ContextCommitId[];
    delta: T;
    authorTaskId?: TaskId;
    createdAt: number;
}

export interface ContextBranch {
    name: string;
    head?: ContextCommitId;
    version: number;
    updatedAt: number;
}

export interface ContextCommitOptions {
    branch?: string;
    parents?: ContextCommitId[];
    expectedHead?: ContextCommitId | null;
    taskId?: TaskId;
}

export interface RetryPolicy {
    maxAttempts: number;
    backoffMs?: number;
}

export interface TaskDependency {
    task: TaskId;
    condition?: 'succeeded' | 'terminal';
    onFailure?: 'fail' | 'skip' | 'continue';
}

export interface TaskSpec<I = unknown> {
    /** Provenance for a fresh manual retry; the source Task must be terminal. */
    retryOfTaskId?: TaskId;
    /** Session-scoped durable submission key. Reusing it with another spec is rejected. */
    requestId?: string;
    program: ProgramRef;
    input: I;
    parent?: TaskId;
    spawnKey?: string;
    dependsOn?: TaskDependency[];
    retry?: RetryPolicy;
    priority?: number;
    labels?: Record<string, string>;
    /** Persist the Task without making it schedulable until TaskHandle.start(). */
    deferStart?: boolean;
}

export interface TaskAttempt {
    id: AttemptId;
    workerId: string;
    leaseToken: string;
    leaseEpoch: number;
    leaseUntil: number;
    startedAt: number;
    finishedAt?: number;
    outcome?: 'yielded' | 'lost' | 'failed' | 'completed' | 'cancelled';
}

export interface SerializableError {
    message: string;
    code?: string;
    stack?: string;
}

export interface ExitRecord<O = unknown> {
    taskId: TaskId;
    status: 'succeeded' | 'failed' | 'cancelled';
    output?: O;
    error?: SerializableError;
    completedAt: number;
}

export interface PersistedEffect {
    request: EffectRequest;
    status: 'pending' | 'leased' | 'succeeded' | 'failed' | 'cancelled' | 'indeterminate';
    attemptCount: number;
    cleanupPending?: boolean;
    deadlineAt?: number;
    readyAt?: number;
    replayAuthorized?: boolean;
    attempts: EffectAttempt[];
    currentAttempt?: EffectAttempt;
    result?: unknown;
    error?: SerializableError;
}

export interface EffectResolution {
    requestId: string;
    effectId: string;
    outcome: { type: 'completed'; result: JsonValue } | { type: 'retry' } | { type: 'failed'; error: SerializableError };
}

export interface EffectAttempt {
    id: string;
    workerId: string;
    leaseToken: string;
    leaseUntil: number;
    startedAt: number;
    finishedAt?: number;
    outcome?: 'completed' | 'failed' | 'lost' | 'cancelled' | 'indeterminate';
}

export interface TaskRecord<S = unknown> {
    retryOfTaskId?: TaskId;
    id: TaskId;
    sessionId: SessionId;
    parentTaskId?: TaskId;
    rootTaskId: TaskId;
    spawnKey?: string;
    program: ProgramRef;
    status: TaskStatus;
    input: unknown;
    state?: S;
    pendingEvents: TaskInputEvent[];
    unresolvedDeps: number;
    /** Authority for rebuilding dependency indexes; absent on legacy records. */
    dependencies?: TaskDependency[];
    priority: number;
    retry: RetryPolicy;
    attemptCount: number;
    /** Successful reducer steps and per-step attempts are independent of lease epochs. */
    stepNumber?: number;
    stepAttemptCount?: number;
    stateRevision?: number;
    initialized?: boolean;
    blockedReason?: 'program-unavailable';
    control?: TaskControl;
    sessionPaused?: boolean;
    controlHolds?: string[];
    readyAt?: number;
    lastError?: SerializableError;
    currentAttempt?: TaskAttempt;
    effects: Record<string, PersistedEffect>;
    interactions: Record<string, InteractionRecord<JsonValue>>;
    wait?: WaitSpec;
    output?: unknown;
    exit?: ExitRecord;
    labels?: Record<string, string>;
    version: number;
    createdAt: number;
    updatedAt: number;
}

export interface TaskControl {
    epoch: number;
    mode: 'run' | 'pause' | 'interrupt';
    requestId: string;
    reason?: string;
    acknowledged: boolean;
}
export interface TaskControlOptions extends LeaseGuardOptions { requestId: string; expectedEpoch?: number; reason?: string; }

export type TaskSignal = { type: string; payload?: unknown };
export interface TaskStartOptions extends LeaseGuardOptions { signal?: TaskSignal; }
export type TaskInputEvent =
    | { type: 'resource-result'; receipt: import('./resource-api').ResourceRequestSnapshot }
    | { type: 'started' }
    | { type: 'step' }
    | { type: 'message'; message: CrossSessionMessage }
    | { type: 'cache-result'; receipt: CacheReceipt }
    | { type: 'cache-managed'; receipt: CacheManagementReceipt }
    | { type: 'shared-changed'; revision: SharedStateRevision }
    | { type: 'timer-fired'; id: string; at: number }
    | { type: 'effect-completed'; effectId: EffectId; result: unknown }
    | { type: 'effect-failed'; effectId: EffectId; error: SerializableError }
    | { type: 'task-exited'; taskId: TaskId; exit: ExitRecord; spawnKey?: string }
    | { type: 'interaction-resolved'; interactionId: string; value: JsonValue }
    | { type: 'signal'; sequence: number; signal: TaskSignal };

export type WaitAtom =
    | { type: 'resource'; scope: string; requestId: string }
    | { type: 'message'; topic?: string; correlationId?: string }
    | { type: 'cache'; operationId: string }
    | { type: 'cache-management'; operationId: string }
    | { type: 'signal'; id?: string }
    | { type: 'effect'; id?: string }
    | { type: 'task'; id: TaskId }
    | { type: 'child'; spawnKey: string }
    | { type: 'interaction'; id: string }
    | { type: 'shared-version'; key: string; afterVersion: number }
    | { type: 'timer'; id: string; at: number };

export type WaitSpec = WaitAtom
    | { type: 'any'; waits: WaitSpec[] }
    | { type: 'all'; waits: WaitSpec[] }
    | { type: 'quorum'; waits: WaitSpec[]; required: number };

export interface EffectRequest<Req = unknown> {
    id?: EffectId;
    kind: string;
    version: string;
    request: Req;
    idempotencyKey: string;
    timeoutMs?: number;
    retry?: RetryPolicy;
    grants?: Array<{ handleId: HandleId; right: ResourceRight }>;
}

export type KernelAction =
    | { type: 'resource'; command: import('./resource-api').ResourceCommand }
    | CacheManagementAction
    | { type: 'send-message'; message: TaskMessageRequest }
    | { type: 'cache-read'; request: CacheRead }
    | { type: 'cache-publish'; request: CachePublish }
    | { type: 'effect'; effect: EffectRequest }
    | { type: 'spawn'; spawnKey: string; spec: TaskSpec }
    | { type: 'request-interaction'; interaction: InteractionRequest<JsonValue> }
    | { type: 'set-shared'; key: string; value: JsonValue; expectedVersion?: number | null }
    | { type: 'delete-shared'; key: string; expectedVersion?: number | null }
    | { type: 'emit'; eventType: string; payload?: unknown };

export interface Decision<S = unknown, O = unknown> {
    state: S;
    actions?: KernelAction[];
    next: { type: 'continue' }
        | { type: 'wait'; on: WaitSpec }
        | { type: 'complete'; output: O }
        | { type: 'fail'; error: SerializableError; retryable?: boolean };
}

export interface TaskProgramManifest { kind: string; version: string; }
export interface DurableTaskProgram<S = unknown, I = unknown, O = unknown> {
    readonly manifest: TaskProgramManifest;
    init(input: I): Decision<S, O> | Promise<Decision<S, O>>;
    reduce(state: Readonly<S>, event: TaskInputEvent): Decision<S, O> | Promise<Decision<S, O>>;
}

export interface EffectExecutionContext {
    sessionId: SessionId;
    taskId: TaskId;
    effectId: EffectId;
    idempotencyKey?: string;
    abortSignal: AbortSignal;
    grants: AuthorizedEffectGrant[];
    sessionState?: EffectSessionState;
    /**
     * Append an incremental event to the session event log during effect
     * execution. Events are immediately visible to TaskHandle.events()
     * consumers (e.g. streaming LLM chunks to the UI).
     */
    emit?: (event: { type: string; payload?: unknown }) => Promise<void>;
    /**
     * Charge a resource budget for work performed by this effect. Injected by
     * the kernel; effect adapters call it after a successful side effect (e.g.
     * LLM token usage). Throws when the budget is exceeded.
     *
     * Effect-driven charges are settled once per logical Effect by default
     * (`usageId` defaults to `effect:<taskId>:<effectId>:<handleId>:<dimension>`), so a retried
     * attempt after a crash cannot double-charge. Pass an explicit `usageId` to settle a
     * different logical unit of work or to reuse one settlement across effects.
     */
    chargeBudget?: (handleId: string, dimension: string, amount: number, options?: { usageId?: string }) => Promise<BudgetAccount[]>;
}

export interface EffectSessionState {
    get<T extends JsonValue = JsonValue>(key: string): Promise<SharedStateEntry<T> | undefined>;
    set<T extends JsonValue>(
        key: string,
        value: T,
        expectedVersion?: number | null,
    ): Promise<SharedStateEntry<T>>;
}

export interface AuthorizedEffectGrant {
    handleId: HandleId;
    right: ResourceRight;
    resource: ResourceRecord;
}
export interface EffectAdapter<Req = unknown, Res = unknown> {
    readonly kind: string;
    readonly version: string;
    readonly recoveryPolicy?: 'idempotent-retry' | 'manual';
    /** Decide live failure retries independently of crash reconciliation. */
    shouldRetry?(error: unknown, context: EffectExecutionContext): boolean;
    execute(request: Req, context: EffectExecutionContext): Promise<Res>;
    reconcile?(request: Req, context: EffectExecutionContext): Promise<EffectReconcileResult<Res>>;
    cancel?(request: Req, context: EffectExecutionContext): Promise<void>;
}

export type EffectReconcileResult<Res = unknown> =
    | { status: 'completed'; result: Res }
    | { status: 'retry' }
    | { status: 'indeterminate'; error: SerializableError };

export interface EventEnvelope {
    schemaVersion?: number;
    effectId?: EffectId;
    attemptId?: string;
    sequence: number;
    sessionId: SessionId;
    taskId?: TaskId;
    type: string;
    payload?: unknown;
    occurredAt: number;
}

export type ResourceRight = 'read' | 'write' | 'execute' | 'grant' | 'admin';
export interface ResourceRecord {
    id: ResourceId;
    sessionId: SessionId;
    kind: string;
    /** Adapter-owned locator. Use a durable logical URI when physical files may move. */
    uri: string;
    generation: number;
    parentResourceId?: ResourceId;
    metadata?: JsonValue;
    createdAt: number;
}

export interface ResourceHandle {
    id: HandleId;
    resourceId: string;
    holderTaskId: TaskId;
    rights: ResourceRight[];
    generation: number;
    parentHandleId?: HandleId;
    revokedAt?: number;
}

export interface ResourceSpec {
    /** Owner-task-scoped idempotency key for capability creation. */
    requestId?: string;
    kind: string;
    uri: string;
    ownerTaskId: TaskId;
    rights?: ResourceRight[];
    parentResourceId?: ResourceId;
    parentHandleId?: HandleId;
    metadata?: JsonValue;
}

export type TaskResourceSpec = Omit<ResourceSpec, 'ownerTaskId'>;

export interface BudgetAccount {
    resourceId: ResourceId;
    dimension: string;
    hardLimit: number;
    used: number;
    version: number;
    updatedAt: number;
}

/**
 * Idempotent budget settlement receipt: one logical settlement (`usageId`) charges an
 * account chain once, so replaying the same settlement after a crash or retry cannot
 * double-charge, and a different amount under the same id is a conflict.
 */
export interface BudgetUsage {
    usageId: string;
    resourceId: ResourceId;
    dimension: string;
    amount: number;
    accounts: BudgetAccount[];
    settledAt: number;
}

export interface ResourceGrant {
    resource: ResourceRecord;
    handle: ResourceHandle;
}

export interface WorkspaceSnapshot {
    id: string;
    sessionId: SessionId;
    resourceId: ResourceId;
    adapter: ProgramRef;
    parentIds: string[];
    payload: JsonValue;
    createdAt: number;
}

export interface WorkspaceDiff {
    id: string;
    sessionId: SessionId;
    resourceId: ResourceId;
    adapter: ProgramRef;
    baseSnapshotId: string;
    targetSnapshotId: string;
    payload: JsonValue;
    createdAt: number;
}

export interface WorkspaceMergeResult {
    snapshot: WorkspaceSnapshot;
    conflicts: JsonValue[];
}

export interface WorkspaceExecutionContext {
    sessionId: SessionId;
    resource: ResourceRecord;
    abortSignal: AbortSignal;
}

export interface WorkspaceAdapter {
    readonly kind: string;
    readonly version: string;
    /** Resolve logical URIs on every call; a path URI intentionally follows path semantics. */
    snapshot(uri: string, context: WorkspaceExecutionContext): Promise<JsonValue>;
    diff(base: JsonValue, target: JsonValue, context: WorkspaceExecutionContext): Promise<JsonValue>;
    merge(
        base: JsonValue,
        left: JsonValue,
        right: JsonValue,
        context: WorkspaceExecutionContext,
    ): Promise<{ payload: JsonValue; conflicts?: JsonValue[] }>;
}

export interface TaskSnapshot { task: TaskRecord; }
export interface RecoveryReport {
    recoveredTasks: number;
    recoveredEffects: number;
    expiredAttempts: number;
    rebuiltIndexes: number;
}

/** Session 的 Task 生命周期面（提交/信号/交互/事件）。 */
export interface SessionTaskApi {
    submit<I, O = unknown>(spec: TaskSpec<I>, options?: LeaseGuardOptions): Promise<TaskHandle<O>>;
    /** Attach to a durable task after a process restart or UI reconnect. */
    attachTask<O = unknown>(taskId: TaskId): Promise<TaskHandle<O>>;
    /** Inspect the complete session task tree, including terminal tasks. */
    listTasks(): Promise<TaskRecord[]>;
    signal(taskId: TaskId, signal: TaskSignal, options?: LeaseGuardOptions): Promise<void>;
    respond<T extends JsonValue>(taskId: TaskId, response: InteractionResponse<T>, options?: LeaseGuardOptions): Promise<void>;
    events(options?: { after?: number }): AsyncIterable<EventEnvelope>;
}

/** Session 内共享状态面。 */
export interface SessionSharedStateApi {
    getShared<T extends JsonValue = JsonValue>(key: string): Promise<SharedStateEntry<T> | undefined>;
    /** Read several keys from one snapshot when the host supports it. */
    getSharedMany?(keys: string[]): Promise<Record<string, SharedStateEntry | undefined>>;
    setShared<T extends JsonValue>(key: string, value: T, options?: SharedStateWriteOptions): Promise<SharedStateEntry<T>>;
    deleteShared(key: string, options?: SharedStateWriteOptions): Promise<boolean>;
    listShared(prefix?: string): Promise<SharedStateEntry[]>;
    sharedHistory<T extends JsonValue = JsonValue>(key: string): Promise<SharedStateRevision<T>[]>;
}

export interface TaskBoardItem {
    id: string;
    title: string;
    description?: string;
    status: 'open' | 'claimed' | 'completed' | 'failed';
    dependencies?: string[];
    assigneeTaskId?: TaskId;
    leaseUntil?: number;
    leaseToken?: string;
    result?: JsonValue;
    createdAt: number;
    updatedAt: number;
}

/** Durable, CAS-protected coordination board for multi-agent runs. */
export interface SessionTaskBoardApi {
    listTaskBoard(): Promise<TaskBoardItem[]>;
    createTaskBoardItem(input: Pick<TaskBoardItem, 'title' | 'description' | 'dependencies'> & { id?: string }): Promise<TaskBoardItem>;
    claimTaskBoardItem(id: string, assigneeTaskId: TaskId, options?: { leaseMs?: number }): Promise<TaskBoardItem>;
    renewTaskBoardLease(id: string, assigneeTaskId: TaskId, leaseToken: string, leaseMs?: number): Promise<TaskBoardItem>;
    completeTaskBoardItem(id: string, leaseToken: string, result?: JsonValue, failed?: boolean): Promise<TaskBoardItem>;
}

/** Session 间消息面（outbox/inbox）。 */
export interface SessionMessageApi {
    sendToSession<T extends JsonValue>(targetSessionId: SessionId, topic: string, payload: T, options?: { expiresAt?: number }): Promise<CrossSessionMessage<T>>;
    inbox(options?: { after?: number }): Promise<CrossSessionMessage[]>;
    outbox(): Promise<CrossSessionMessage[]>;
}

/** Session 的 Context 分支/提交面。 */
export interface SessionContextApi {
    commitContext<T extends JsonValue>(delta: T, options?: ContextCommitOptions): Promise<ContextCommit<T>>;
    getContextCommit<T extends JsonValue = JsonValue>(id: ContextCommitId): Promise<ContextCommit<T> | undefined>;
    getContextBranch(name?: string): Promise<ContextBranch>;
    contextHistory(head?: ContextCommitId): Promise<ContextCommit[]>;
}

/** Session 的资源/权限面。 */
export interface SessionResourceApi {
    createResource(spec: ResourceSpec): Promise<ResourceGrant>;
    grantResource(parentHandleId: HandleId, holderTaskId: TaskId, rights: ResourceRight[]): Promise<ResourceHandle>;
    revokeResource(handleId: HandleId): Promise<number>;
    authorizeResource(handleId: HandleId, right: ResourceRight, holderTaskId?: TaskId): Promise<ResourceRecord>;
}

/** Session 的预算面。 */
export interface SessionBudgetApi {
    setBudget(handleId: HandleId, dimension: string, hardLimit: number, expectedVersion?: number | null, options?: LeaseGuardOptions): Promise<BudgetAccount>;
    /** Charge a budget; `usageId` settles a logical charge at most once (replays return the receipt). */
    chargeBudget(handleId: HandleId, dimension: string, amount: number, options?: { usageId?: string }): Promise<BudgetAccount[]>;
}

/** Session 的工作区快照/合并面。 */
export interface SessionWorkspaceApi {
    snapshotWorkspace(handleId: HandleId, adapter: ProgramRef): Promise<WorkspaceSnapshot>;
    diffWorkspace(handleId: HandleId, baseSnapshotId: string, targetSnapshotId: string): Promise<WorkspaceDiff>;
    mergeWorkspace(
        handleId: HandleId,
        baseSnapshotId: string,
        leftSnapshotId: string,
        rightSnapshotId: string,
    ): Promise<WorkspaceMergeResult>;
}

/** Session 生命周期面。 */
export interface SessionLifecycleApi {
    suspend(): Promise<void>;
    resume(): Promise<void>;
    close(options?: { cancelRunning?: boolean }): Promise<void>;
}

/**
 * Session 句柄：按概念域拆分的窄接口组合（ISP）。
 * 消费者可按需依赖 SessionTaskApi / SessionBudgetApi 等窄接口，
 * 不必拿到整个 30 方法的宽句柄。
 */
export interface SessionHandle extends
    SessionTaskApi,
    SessionSharedStateApi,
    SessionTaskBoardApi,
    SessionMessageApi,
    SessionContextApi,
    SessionResourceApi,
    SessionBudgetApi,
    SessionWorkspaceApi,
    SessionLifecycleApi {
    readonly id: SessionId;
    readonly resources: import('./resource-api').ResourceApi;
    recover(options?: RecoveryOptions): Promise<RecoveryReport>;
    spawn<I, O = unknown>(spec: TaskSpec<I>): Promise<TaskHandle<O>>;
    stat(): Promise<import('./status').SessionStat>;
    watch(options?: { after?: number }): AsyncIterable<EventEnvelope>;
}

export interface TaskHandle<O = unknown> {
    readonly id: TaskId;
    readonly resources: import('./resource-api').ResourceApi;
    readonly cache: import('./cache').CacheApi;
    send(request: TaskMessageRequest): Promise<CrossSessionMessage>;
    stat(): Promise<import('./status').TaskStat>;
    stats(): Promise<import('./status').TaskStats>;
    watch(options?: { after?: number }): AsyncIterable<EventEnvelope>;
    status(): Promise<TaskSnapshot>;
    wait(options?: { timeoutMs?: number }): Promise<ExitRecord<O>>;
    poll(): Promise<ExitRecord<O> | undefined>;
    signal(signal: TaskSignal, options?: LeaseGuardOptions): Promise<void>;
    start(options?: TaskStartOptions): Promise<void>;
    pause(options: TaskControlOptions): Promise<TaskControl>;
    interrupt(options: TaskControlOptions): Promise<TaskControl>;
    resume(options: TaskControlOptions & { signal?: TaskSignal }): Promise<TaskControl>;
    respond<T extends JsonValue>(response: InteractionResponse<T>, options?: LeaseGuardOptions): Promise<void>;
    createResource(spec: TaskResourceSpec, options?: LeaseGuardOptions): Promise<ResourceGrant>;
    cancel(reason?: string, options?: LeaseGuardOptions): Promise<void>;
    events(options?: { after?: number }): AsyncIterable<EventEnvelope>;
    history(options?: { afterVersion?: number }): Promise<TaskRecord[]>;
    attempts(): Promise<TaskAttempt[]>;
    /** Create an idempotent, deferred fresh root Task; resources must be granted again. */
    retry(options: LeaseGuardOptions & { requestId: string }): Promise<TaskHandle<O>>;
    resolveEffect(request: EffectResolution): Promise<void>;
    sendMessage(request: TaskMessageRequest): Promise<CrossSessionMessage>;
    createCache(spec: CacheSpec): Promise<{ namespace: CacheNamespace; handle: ResourceHandle }>;
    listCaches(): Promise<Array<{ namespace: CacheNamespace; handleId: string }>>;
    readCache(request: CacheRead): Promise<CacheReceipt>;
    publishCache(request: CachePublish): Promise<CacheEntry>;
    invalidateCache(handleId: string, expectedGeneration: number): Promise<CacheNamespace>;
    renewCache(handleId: string, expectedGeneration: number, ttlMs: number): Promise<CacheNamespace>;
}
/** A bounded range of immutable Task versions, pinned to the first page's upper bound. */
export interface TaskHistoryQuery {
    afterVersion?: number;
    throughVersion?: number;
    limit?: number;
}
export interface TaskHistoryPage {
    items: TaskRecord[];
    throughVersion: number;
    nextAfterVersion?: number;
}

/** Index cursors are Task-local ordinals, distinct from Session event sequence numbers. */
export interface TaskEventQuery { afterIndex?: number; throughIndex?: number; limit?: number; }
export interface TaskEventPage {
    items: EventEnvelope[];
    throughIndex: number;
    nextAfterIndex?: number;
    /** Set when older events were pruned: the first index still retained. */
    firstAvailableIndex?: number;
}
export interface TaskListQuery { afterIndex?: number; throughIndex?: number; limit?: number; }
/** Membership is pinned by throughIndex; each page reads current Task status. */
export interface TaskListPage { items: TaskRecord[]; throughIndex: number; nextAfterIndex?: number; }
