import type { JsonValue, ResourceRight } from './types';

/** Managed resources share one transactional module. Scope is an identity, not a path. */
export interface ManagedResourceRef { id: string; scope: string; }
export interface ManagedResource {
    ref: ManagedResourceRef;
    kind: 'pool' | 'shared';
    name: string;
    version: number;
    /** Immutable authority identity; mutations must present its current owner epoch. */
    authorityId?: string;
    capacity?: number;
    value?: JsonValue;
    state?: 'active' | 'closing' | 'tombstoned';
    physical?: PhysicalResourceBinding;
}
export interface ManagedHandle {
    id: string;
    ref: ManagedResourceRef;
    sessionId: string;
    taskId: string;
    rights: ResourceRight[];
    name: string;
    closed: boolean;
    grantEpochs?: Partial<Record<ResourceRight, number>>;
}
export interface ResourceClaim {
    id: string;
    ref: ManagedResourceRef;
    handleId: string;
    sessionId: string;
    taskId: string;
    quantity: number;
    token: string;
    released: boolean;
    state?: 'held' | 'cleanup-pending' | 'released';
    epoch?: number;
    cleanupId?: string;
}
/**
 * Ownership of one resource authority (`resources.seq.managed/authority/<id>`).
 *
 * `ownerEpoch` is the fencing token of the authority *service*, not of a resource
 * incarnation or a cache generation: a new leader takes over by CAS-incrementing the epoch,
 * and every command it issues presents the epoch it observed. A superseded leader therefore
 * keeps a stale epoch and its writes are refused.
 */
export interface ManagedAuthority {
    authorityId: string;
    ownerEpoch: number;
    ownerId?: string;
    /** Immutable local storage binding marker; cross-store exclusivity requires a broker. */
    binding?: string;
    serviceEndpoint?: string;
    status: 'active' | 'stopped';
    updatedAt: number;
}

/** The epoch a caller observed; presented on a resource command to fence superseded leaders. */
export interface ResourceAuthority { authorityId: string; epoch: number; }
export type ResourceResult = ManagedResource | ManagedHandle | ResourceClaim | ManagedGrant | ManagedAuthority | { ok: true };
export interface ResourceRequestSnapshot<T = ResourceResult> {
    id: string;
    scope: string;
    status: 'pending' | 'succeeded' | 'cancelled' | 'failed';
    result?: T;
    error?: string;
}
export interface DurableResourceRequest<T = ResourceResult> {
    readonly id: string;
    poll(): Promise<ResourceRequestSnapshot<T>>;
    wait(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
    cancel(): Promise<ResourceRequestSnapshot<T>>;
}
/** Bound resources require their authority epoch on mutations; legacy unbound resources do not. */
export type ResourceCommand = { requestId: string; authority?: ResourceAuthority } & (
    | { type: 'create'; kind: 'pool' | 'shared'; name: string; capacity?: number; value?: JsonValue; physical?: PhysicalResourceBinding }
    | { type: 'share'; ref: ManagedResourceRef; toSessionId: string; rights: ResourceRight[] }
    | { type: 'revoke'; ref: ManagedResourceRef; toSessionId: string; rights?: ResourceRight[]; expectedRevision: number }
    | { type: 'destroy'; ref: ManagedResourceRef; expectedVersion: number }
    | { type: 'open'; ref: ManagedResourceRef; taskId?: string; rights: ResourceRight[]; name: string }
    | { type: 'acquire'; handle: ManagedHandle; quantity: number; deadlineAt?: number }
    | { type: 'release'; claim: ResourceClaim }
    | { type: 'close'; handle: ManagedHandle }
    | { type: 'read'; handle: ManagedHandle }
    | { type: 'write'; handle: ManagedHandle; expectedVersion: number; value: JsonValue }
);
export interface ManagedResourceStat { resource: ManagedResource; held: number; waiting: number; }
/** Optional authority epoch presented by a caller that writes an authority's records. */
export interface Fenced { authority?: ResourceAuthority; }
export interface AuthorityClaim {
    /** New leader identity; absent keeps the recorded owner. */
    ownerId?: string;
    /** The epoch the caller observed; absent is only valid for the first claim. */
    expectedEpoch?: number;
    binding?: string;
    serviceEndpoint?: string;
    /** Defaults to the actor's own scope (`session:<id>` or `kernel`). */
    scope?: string;
}
export interface ResourceApi {
    create(spec: Omit<Extract<ResourceCommand, { type: 'create' }>, 'type'>): Promise<DurableResourceRequest<ManagedResource>>;
    share(ref: ManagedResourceRef, options: { requestId: string; toSessionId: string; rights: ResourceRight[] } & Fenced): Promise<DurableResourceRequest<{ ok: true }>>;
    revoke(ref: ManagedResourceRef, options: { requestId: string; toSessionId: string; rights?: ResourceRight[]; expectedRevision: number } & Fenced): Promise<DurableResourceRequest<ManagedGrant>>;
    destroy(ref: ManagedResourceRef, options: { requestId: string; expectedVersion: number } & Fenced): Promise<DurableResourceRequest<ManagedResource>>;
    query(options: ResourceQuery): Promise<ResourcePage>;
    open(ref: ManagedResourceRef, options: { requestId: string; taskId?: string; rights: ResourceRight[]; name: string } & Fenced): Promise<DurableResourceRequest<ManagedHandle>>;
    acquire(handle: ManagedHandle, options: { requestId: string; quantity: number; deadlineAt?: number } & Fenced): Promise<DurableResourceRequest<ResourceClaim>>;
    release(claim: ResourceClaim, options: { requestId: string } & Fenced): Promise<DurableResourceRequest<ResourceClaim>>;
    close(handle: ManagedHandle, options: { requestId: string } & Fenced): Promise<DurableResourceRequest<ManagedHandle>>;
    read(handle: ManagedHandle, options: { requestId: string }): Promise<DurableResourceRequest<ManagedResource>>;
    write(handle: ManagedHandle, options: { requestId: string; expectedVersion: number; value: JsonValue } & Fenced): Promise<DurableResourceRequest<ManagedResource>>;
    /** Take ownership of an authority by CAS-incrementing its `ownerEpoch`. */
    claimAuthority(authorityId: string, options: AuthorityClaim): Promise<ManagedAuthority>;
    /** Read an authority record; `undefined` when the authority was never claimed. */
    authority(authorityId: string, scope?: string): Promise<ManagedAuthority | undefined>;
    request(scope: string, requestId: string): DurableResourceRequest;
    stat(ref: ManagedResourceRef): Promise<ManagedResourceStat>;
    validate(claim: ResourceClaim): Promise<ResourceClaim>;
    list(): Promise<ManagedHandle[]>;
}


export interface PhysicalResourceBinding { kind: string; version: string; externalId: string; }
export interface ManagedGrant {
    id: string;
    resourceId: string;
    sessionId: string;
    revision: number;
    rights: ResourceRight[];
    epochs: Partial<Record<ResourceRight, number>>;
    state: 'active' | 'revoked';
}
export interface ResourceCleanup {
    id: string;
    ref: ManagedResourceRef;
    claimId?: string;
    epoch: number;
    physical: PhysicalResourceBinding;
    status: 'pending' | 'unknown' | 'succeeded';
    attempts: number;
    nextAttemptAt: number;
    error?: string;
    receipt?: ResourceCleanupReceipt;
}
export interface ResourceCleanupReceipt {
    operationId: string;
    epoch: number;
    /** stopped means the capacity is physically reusable (or the resource was deleted). */
    status: 'stopped' | 'pending' | 'unknown';
    error?: string;
    retryAfterMs?: number;
}
export interface ResourceCleanupContext {
    operationId: string;
    epoch: number;
    resource: ManagedResourceRef;
    physical: PhysicalResourceBinding;
    claim?: ResourceClaim;
    signal: AbortSignal;
}
/** Calls must reconcile/retry the same operation idempotently after restart or timeout. */
export interface ManagedResourceAdapter {
    readonly kind: string;
    readonly version: string;
    readonly timeoutMs?: number;
    cleanup(context: ResourceCleanupContext): Promise<ResourceCleanupReceipt>;
    destroy(context: ResourceCleanupContext): Promise<ResourceCleanupReceipt>;
}
export interface ResourceQuery {
    kind: 'resources' | 'claims' | 'requests' | 'grants' | 'cleanups';
    scope?: string;
    sessionId?: string;
    taskId?: string;
    state?: string;
    limit?: number;
    cursor?: string;
}
export interface ResourceRequestInfo {
    id: string;
    scope: string;
    sessionId?: string;
    taskId?: string;
    operation?: ResourceCommand['type'];
    status: ResourceRequestSnapshot['status'];
    error?: string;
}
export interface ResourcePage {
    items: Array<ManagedResource | ResourceClaim | ManagedGrant | ResourceCleanup | ResourceRequestInfo>;
    /** Live keyset pagination; each page rechecks access, not a historical snapshot. */
    nextCursor?: string;
}
