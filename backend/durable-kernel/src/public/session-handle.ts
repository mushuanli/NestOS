import type { Kernel } from '../application/kernel';
import type {
    BudgetAccount,
    LeaseGuardOptions,
    ContextBranch,
    ContextCommit,
    ContextCommitOptions,
    CrossSessionMessage,
    EventEnvelope,
    InteractionResponse,
    JsonValue,
    ProgramRef,
    ResourceGrant,
    ResourceHandle,
    ResourceRecord,
    ResourceRight,
    ResourceSpec,
    SessionHandle,
    SharedStateEntry,
    SharedStateRevision,
    SharedStateWriteOptions,
    TaskBoardItem,
    TaskHandle,
    TaskSignal,
    TaskSpec,
    WorkspaceDiff,
    WorkspaceMergeResult,
    WorkspaceSnapshot,
} from '../domain/types';
import { eventStream } from './event-stream';

export class DefaultSessionHandle implements SessionHandle {
    get resources() { return this.kernel.resourceApi(this.id); }
    recover(options?: import('../domain/types').RecoveryOptions) { return this.kernel.recoverSession(this.id, options); }
    spawn<I, O = unknown>(spec: TaskSpec<I>) { return this.submit<I, O>(spec); }
    stat() { return this.kernel.sessionStat(this.id); }
    watch(options?: { after?: number }) { return this.events(options); }
    constructor(private readonly kernel: Kernel, readonly id: string) {}

    submit<I, O = unknown>(spec: TaskSpec<I>, options?: import('../domain/types').LeaseGuardOptions): Promise<TaskHandle<O>> {
        return this.kernel.submit<I, O>(this.id, spec, options);
    }

    attachTask<O = unknown>(taskId: string): Promise<TaskHandle<O>> {
        return this.kernel.attachTask<O>(this.id, taskId);
    }

    listTasks(): Promise<import('../domain/types').TaskRecord[]> {
        return this.kernel.listSessionTasks(this.id);
    }

    signal(taskId: string, signal: TaskSignal, options?: import('../domain/types').LeaseGuardOptions): Promise<void> {
        return this.kernel.signal(this.id, taskId, signal, options);
    }

    respond<T extends JsonValue>(taskId: string, response: InteractionResponse<T>, options?: LeaseGuardOptions): Promise<void> {
        return this.kernel.respondInteraction(this.id, taskId, response, options);
    }

    events(options?: { after?: number }): AsyncIterable<EventEnvelope> {
        return eventStream(this.kernel, this.id, undefined, options?.after ?? 0);
    }

    getShared<T extends JsonValue>(key: string): Promise<SharedStateEntry<T> | undefined> {
        return this.kernel.getShared<T>(this.id, key);
    }

    getSharedMany(keys: string[]): Promise<Record<string, SharedStateEntry | undefined>> {
        return this.kernel.getSharedMany(this.id, keys);
    }

    setShared<T extends JsonValue>(
        key: string, value: T, options?: SharedStateWriteOptions,
    ): Promise<SharedStateEntry<T>> {
        return this.kernel.setShared(this.id, key, value, options);
    }

    deleteShared(key: string, options?: SharedStateWriteOptions): Promise<boolean> {
        return this.kernel.deleteShared(this.id, key, options);
    }

    listShared(prefix?: string): Promise<SharedStateEntry[]> {
        return this.kernel.listShared(this.id, prefix);
    }

    sharedHistory<T extends JsonValue>(key: string): Promise<SharedStateRevision<T>[]> {
        return this.kernel.sharedHistory(this.id, key);
    }

    async listTaskBoard(): Promise<TaskBoardItem[]> {
        const entries = await this.listShared('task-board/');
        return entries.map(entry => entry.value as unknown as TaskBoardItem)
            .sort((left, right) => left.createdAt - right.createdAt);
    }

    async createTaskBoardItem(
        input: Pick<TaskBoardItem, 'title' | 'description' | 'dependencies'> & { id?: string },
    ): Promise<TaskBoardItem> {
        const now = Date.now();
        const id = input.id ?? `${now}-${Math.random().toString(36).slice(2, 10)}`;
        const item: TaskBoardItem = {
            id, title: input.title, status: 'open', createdAt: now, updatedAt: now,
            ...(input.description ? { description: input.description } : {}),
            ...(input.dependencies?.length ? { dependencies: [...input.dependencies] } : {}),
        };
        await this.setShared(`task-board/${id}`, item as unknown as JsonValue, { expectedVersion: null });
        return item;
    }

    async claimTaskBoardItem(id: string, assigneeTaskId: string, options?: { leaseMs?: number }): Promise<TaskBoardItem> {
        const assignee = await this.kernel.task(this.id, assigneeTaskId);
        if (assignee.exit) throw new Error('Task board assignee is terminal');
        const key = `task-board/${id}`;
        const entry = await this.getShared(key);
        if (!entry) throw new Error(`Task board item not found: ${id}`);
        const current = entry.value as unknown as TaskBoardItem;
        const expired = current.status === 'claimed' && current.leaseUntil !== undefined && current.leaseUntil <= Date.now();
        if (current.status !== 'open' && !expired) throw new Error(`Task board item ${id} is already ${current.status}`);
        const dependencies = new Set(current.dependencies ?? []);
        const items = await this.listTaskBoard();
        if ([...dependencies].some(dependency => items.find(item => item.id === dependency)?.status !== 'completed')) {
            throw new Error(`Task board item ${id} has incomplete dependencies`);
        }
        const now = Date.now();
        const leaseMs = positiveLease(options?.leaseMs);
        const leaseToken = globalThis.crypto?.randomUUID?.()
            ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const next = { ...current, status: 'claimed' as const, assigneeTaskId, leaseToken, leaseUntil: now + leaseMs, updatedAt: now };
        await this.setShared(key, next as unknown as JsonValue, { expectedVersion: entry.version, taskId: assigneeTaskId });
        return next;
    }

    async renewTaskBoardLease(id: string, assigneeTaskId: string, leaseToken: string, leaseMs?: number): Promise<TaskBoardItem> {
        const key = `task-board/${id}`;
        const entry = await this.getShared(key);
        if (!entry) throw new Error(`Task board item not found: ${id}`);
        const current = entry.value as unknown as TaskBoardItem;
        if (current.status !== 'claimed' || current.assigneeTaskId !== assigneeTaskId || current.leaseToken !== leaseToken || (current.leaseUntil ?? 0) <= Date.now()) {
            throw new Error(`Task board item ${id} is not claimed by ${assigneeTaskId}`);
        }
        const next = { ...current, leaseUntil: Date.now() + positiveLease(leaseMs), updatedAt: Date.now() };
        await this.setShared(key, next as unknown as JsonValue, { expectedVersion: entry.version, taskId: assigneeTaskId });
        return next;
    }

    async completeTaskBoardItem(id: string, leaseToken: string, result?: JsonValue, failed = false): Promise<TaskBoardItem> {
        const key = `task-board/${id}`;
        const entry = await this.getShared(key);
        if (!entry) throw new Error(`Task board item not found: ${id}`);
        const current = entry.value as unknown as TaskBoardItem;
        if (current.status !== 'claimed' || !leaseToken || current.leaseToken !== leaseToken) throw new Error(`Task board item ${id} is not claimed`);
        if (current.leaseUntil !== undefined && current.leaseUntil <= Date.now()) {
            throw new Error(`Task board item ${id} claim lease expired`);
        }
        const next: TaskBoardItem = {
            ...current, status: failed ? 'failed' : 'completed', updatedAt: Date.now(),
            ...(result !== undefined ? { result } : {}),
        };
        await this.setShared(key, next as unknown as JsonValue, { expectedVersion: entry.version, taskId: current.assigneeTaskId });
        return next;
    }

    sendToSession<T extends JsonValue>(target: string, topic: string, payload: T, options?: { expiresAt?: number }): Promise<CrossSessionMessage<T>> {
        return this.kernel.sendCrossSession(this.id, target, topic, payload, options);
    }

    outbox(): Promise<CrossSessionMessage[]> { return this.kernel.outbox(this.id); }

    inbox(options?: { after?: number }): Promise<CrossSessionMessage[]> {
        return this.kernel.inbox(this.id, options?.after ?? 0);
    }

    commitContext<T extends JsonValue>(delta: T, options?: ContextCommitOptions): Promise<ContextCommit<T>> {
        return this.kernel.commitContext(this.id, delta, options);
    }

    getContextCommit<T extends JsonValue>(id: string): Promise<ContextCommit<T> | undefined> {
        return this.kernel.getContextCommit<T>(this.id, id);
    }

    getContextBranch(name?: string): Promise<ContextBranch> {
        return this.kernel.getContextBranch(this.id, name);
    }

    contextHistory(head?: string): Promise<ContextCommit[]> {
        return this.kernel.contextHistory(this.id, head);
    }

    createResource(spec: ResourceSpec): Promise<ResourceGrant> {
        return this.kernel.createResource(this.id, spec);
    }

    grantResource(parent: string, holder: string, rights: ResourceRight[]): Promise<ResourceHandle> {
        return this.kernel.grantResource(this.id, parent, holder, rights);
    }

    revokeResource(handleId: string): Promise<number> {
        return this.kernel.revokeResource(this.id, handleId);
    }

    authorizeResource(handleId: string, right: ResourceRight, holder?: string): Promise<ResourceRecord> {
        return this.kernel.authorizeResource(this.id, handleId, right, holder);
    }

    setBudget(
        handleId: string, dimension: string, limit: number, version?: number | null, options?: import('../domain/types').LeaseGuardOptions,
    ): Promise<BudgetAccount> {
        return this.kernel.setBudget(this.id, handleId, dimension, limit, version, options);
    }

    chargeBudget(handleId: string, dimension: string, amount: number, options?: { usageId?: string }): Promise<BudgetAccount[]> {
        return this.kernel.chargeBudget(this.id, handleId, dimension, amount, options);
    }

    snapshotWorkspace(handleId: string, adapter: ProgramRef): Promise<WorkspaceSnapshot> {
        return this.kernel.snapshotWorkspace(this.id, handleId, adapter);
    }

    diffWorkspace(handleId: string, base: string, target: string): Promise<WorkspaceDiff> {
        return this.kernel.diffWorkspace(this.id, handleId, base, target);
    }

    mergeWorkspace(handleId: string, base: string, left: string, right: string): Promise<WorkspaceMergeResult> {
        return this.kernel.mergeWorkspace(this.id, handleId, base, left, right);
    }

    suspend(): Promise<void> { return this.kernel.setSessionStatus(this.id, 'suspended'); }
    resume(): Promise<void> { return this.kernel.setSessionStatus(this.id, 'open'); }
    close(options?: { cancelRunning?: boolean }): Promise<void> {
        return this.kernel.closeSession(this.id, options?.cancelRunning ?? false);
    }
}

function positiveLease(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 300_000;
}
