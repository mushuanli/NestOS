// @file: durable-kernel/src/infrastructure/seqfile/store-helpers.ts
// SeqFileKernelStore 的领域辅助函数（任务、租约、索引、资源、预算、上下文、等待）。
// 底层 SeqFile 原语（路径/键名/编码/事务/事件追加）在 seqfile-core.ts，此处 re-export。
import type { ISeqFileTransaction } from '@itookit/vfs-core';
import type {
    BudgetAccount,
    ContextBranch,
    ContextCommit,
    CrossSessionMessage,
    EffectAttempt,
    PersistedEffect,
    ResourceHandle,
    ResourceRecord,
    ResourceRight,
    ResolvedStorageBinding,
    SessionRecord,
    SharedStateEntry,
    SharedStateRevision,
    TaskAttempt,
    TaskId,
    TaskRecord,
    TaskSpec,
} from '../../domain/types';
import type { EffectClaim, EffectCompletion, PreparedSpawn, TaskClaim, TaskCommitSideEffects } from './store';
import { KernelErrorCode, kernelError } from '../../domain/errors';
import { assertSessionLayout } from './session-layout';

export * from './seqfile-core';
import {
    appendEventTx,
    attemptKey,
    budgetKey,
    budgetUsageKey,
    contextBranchKey,
    contextCommitKey,
    contextPath,
    createId,
    decode,
    encode,
    graphPath,
    handleKey,
    indexPath,
    messagesPath,
    resourceKey,
    resourcesPath,
    seq,
    sessionPath,
    sharedHeadKey,
    sharedHistoryPrefix,
    sharedKey,
    sharedPath,
    snapshotKey,
    spawnMappingKey,
    taskPath,
    taskWaitKey,
} from './seqfile-core';

const SESSION_KEY = 'record';
const TASK_KEY = 'record';


export async function readyCandidates(tx: ISeqFileTransaction, root: string): Promise<string[]> {
    const rows: Array<{ id: string; priority: number; createdAt: number }> = [];
    await tx.walkEntries(indexPath(root), entry => {
        const value = decode<{ priority: number; createdAt: number }>(entry.value);
        rows.push({ id: entry.key.slice(6), ...value });
        return true;
    }, { keyPrefix: 'ready/' });
    rows.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return rows.map(row => row.id);
}

export async function claimTask(
    tx: ISeqFileTransaction,
    root: string,
    task: TaskRecord,
    workerId: string,
    leaseMs: number,
): Promise<TaskClaim> {
    const attempt: TaskAttempt = {
        id: createId('attempt'), workerId, leaseToken: createId('lease'),
        leaseEpoch: task.attemptCount + 1, leaseUntil: Date.now() + leaseMs, startedAt: Date.now(),
    };
    const next = { ...task, status: 'running' as const, currentAttempt: attempt, readyAt: undefined,
        attemptCount: task.attemptCount + 1, stepAttemptCount: (task.stepAttemptCount ?? 0) + 1, version: task.version + 1, updatedAt: Date.now() };
    await writeTaskTx(tx, root, next);
    await tx.setEntry(taskPath(root, task.id), attemptKey(attempt.id), encode(attempt));
    await indexTask(tx, root, next);
    await appendEventTx(tx, root, task.sessionId, task.id, 'task.leased', attempt);
    return { task: next, attempt };
}

export function assertClaim(current: TaskRecord, claim: TaskClaim): void {
    if (!claimMatches(current, claim) || current.currentAttempt!.leaseUntil <= Date.now()) {
        throw new Error(`Stale task claim: ${current.id}`);
    }
}

export function claimMatches(current: TaskRecord, claim: TaskClaim): boolean {
    const attempt = current.currentAttempt;
    return current.status === 'running' && !!attempt
        && attempt.leaseToken === claim.attempt.leaseToken
        && attempt.leaseEpoch === claim.attempt.leaseEpoch
        && (current.control?.epoch ?? 0) === (claim.task.control?.epoch ?? 0)
        && (current.stateRevision ?? 0) === (claim.task.stateRevision ?? 0);
}

export async function indexTask(tx: ISeqFileTransaction, root: string, task: TaskRecord): Promise<void> {
    if (!await tx.getEntry(indexPath(root), `task-ordinal/${task.id}`)) {
        const ordinal = await tx.increment(indexPath(root), 'task-count');
        if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('Task list index exhausted');
        await tx.setEntry(indexPath(root), `task-ordinal/${task.id}`, String(ordinal));
        await tx.setEntry(indexPath(root), `task-order/${String(ordinal).padStart(16, '0')}`, task.id);
    }
    await tx.setEntry(indexPath(root), `task/${task.id}`, encode({ status: task.status, updatedAt: task.updatedAt }));
    const readyKey = `ready/${task.id}`;
    if (task.status === 'ready') {
        await tx.setEntry(indexPath(root), readyKey, encode({
            priority: task.priority, createdAt: task.createdAt, readyAt: task.readyAt,
        }));
    } else {
        await tx.deleteEntry(indexPath(root), readyKey);
    }
}

export async function readTaskTx(tx: ISeqFileTransaction, root: string, taskId: string): Promise<TaskRecord | null> {
    const value = await tx.getEntry(taskPath(root, taskId), TASK_KEY);
    return value ? decode(value) : null;
}

export async function requireTaskTx(tx: ISeqFileTransaction, root: string, taskId: string): Promise<TaskRecord> {
    const task = await readTaskTx(tx, root, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
}

export async function writeTaskTx(tx: ISeqFileTransaction, root: string, task: TaskRecord): Promise<void> {
    const value = encode(task);
    await tx.setEntry(taskPath(root, task.id), TASK_KEY, value);
    await tx.setEntry(taskPath(root, task.id), snapshotKey(task.version), value);
}

export async function finishAttemptTx(
    tx: ISeqFileTransaction,
    root: string,
    task: TaskRecord,
    status: TaskRecord['status'],
    outcome?: TaskAttempt['outcome'],
): Promise<void> {
    if (!task.currentAttempt) return;
    const attempt = { ...task.currentAttempt, outcome: outcome ?? attemptOutcome(status), finishedAt: Date.now() };
    await tx.setEntry(taskPath(root, task.id), attemptKey(attempt.id), encode(attempt));
}

export function attemptOutcome(status: TaskRecord['status']): NonNullable<TaskAttempt['outcome']> {
    if (status === 'succeeded') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    return 'yielded';
}

export function effectAttempt(workerId: string, leaseMs: number): EffectAttempt {
    return {
        id: createId('effect-attempt'), workerId, leaseToken: createId('effect-lease'),
        leaseUntil: Date.now() + leaseMs, startedAt: Date.now(),
    };
}

export function effectClaimMatches(effect: PersistedEffect | undefined, claim: EffectClaim): boolean {
    return effect?.status === 'leased'
        && effect.currentAttempt?.leaseToken === claim.effect.currentAttempt?.leaseToken;
}

export function replaceEffectAttempt(effect: PersistedEffect, attempt: EffectAttempt): PersistedEffect {
    const attempts = (effect.attempts ?? []).map(current => current.id === attempt.id ? attempt : current);
    return { ...effect, currentAttempt: attempt, attempts };
}

export function finishEffect(
    effect: PersistedEffect,
    outcome: EffectCompletion,
): PersistedEffect {
    const status = outcome.indeterminate ? 'indeterminate' as const
        : outcome.error ? 'failed' as const : 'succeeded' as const;
    const attemptOutcome = outcome.indeterminate ? 'indeterminate' as const
        : outcome.error ? 'failed' as const : 'completed' as const;
    const attempt = { ...effect.currentAttempt!, outcome: attemptOutcome,
        finishedAt: Date.now() };
    return { ...replaceEffectAttempt(effect, attempt), status, currentAttempt: undefined, error: outcome.error, result: outcome.result, ...outcome };
}

export function recoverEffect(
    effects: Record<string, PersistedEffect>,
    effectId: string,
): Record<string, PersistedEffect> {
    const effect = effects[effectId];
    if (effect?.status !== 'leased' || !effect.currentAttempt
        || effect.currentAttempt.leaseUntil > Date.now()) return effects;
    const lost = { ...effect.currentAttempt, outcome: 'lost' as const, finishedAt: Date.now() };
    const next = { ...replaceEffectAttempt(effect, lost), status: 'pending' as const, replayAuthorized: false, currentAttempt: undefined };
    return { ...effects, [effectId]: next };
}

export async function applySpawnsTx(
    tx: ISeqFileTransaction,
    root: string,
    parent: TaskRecord,
    spawns: PreparedSpawn[],
): Promise<TaskRecord[]> {
    const created: TaskRecord[] = [];
    for (const spawn of spawns) {
        if (!spawn.spawnKey) throw new Error('Spawn key is required');
        const key = spawnMappingKey(parent.id, spawn.spawnKey);
        if (await tx.getEntry(graphPath(root), key)) continue;
        const spec = { ...spawn.spec, parent: parent.id, spawnKey: spawn.spawnKey };
        const task = await createSpawnTaskTx(tx, root, spawn.id, parent, spec);
        await tx.setEntry(graphPath(root), key, task.id);
        created.push(task);
    }
    return created;
}

export async function createSpawnTaskTx(
    tx: ISeqFileTransaction,
    root: string,
    id: TaskId,
    parent: TaskRecord,
    spec: TaskSpec,
): Promise<TaskRecord> {
    await validateRetrySourceTx(tx, root, spec.retryOfTaskId);
    let task = taskFromSpec(id, parent.sessionId, spec, Date.now());
    task = { ...task, rootTaskId: parent.rootTaskId };
    task = await resolveInitialDependencies(tx, root, task, spec.dependsOn ?? []);
    await writeTaskTx(tx, root, task);
    await writeDependencyEdges(tx, root, task.id, spec.dependsOn ?? []);
    await indexTask(tx, root, task);
    await appendEventTx(tx, root, parent.sessionId, task.id, 'task.spawned', {
        parentTaskId: parent.id, spawnKey: spec.spawnKey,
    });
    return task;
}

export async function resolveInitialDependencies(
    tx: ISeqFileTransaction,
    root: string,
    task: TaskRecord,
    dependencies: import('../../domain/types').TaskDependency[],
): Promise<TaskRecord> {
    let unresolvedDeps = task.unresolvedDeps;
    const pendingEvents = [...task.pendingEvents];
    for (const dependency of dependencies) {
        const source = await readTaskTx(tx, root, dependency.task);
        if (!source) throw new Error(`Dependency not found: ${dependency.task}`);
        if (!isTerminal(source.status)) continue;
        if (!dependencySatisfied(source, dependency.condition) && dependency.onFailure !== 'continue') {
            const status = dependency.onFailure === 'skip' ? 'cancelled' : 'failed';
            return terminalDependency(task, status, source.id);
        }
        unresolvedDeps--;
        if (source.exit) pendingEvents.push({ type: 'task-exited', taskId: source.id, exit: source.exit });
    }
    const status = task.status === 'created'
        ? 'created' as const
        : unresolvedDeps === 0 ? 'ready' as const : task.status;
    return { ...task, pendingEvents, unresolvedDeps, status };
}

export async function writeDependencyEdges(
    tx: ISeqFileTransaction,
    root: string,
    taskId: TaskId,
    dependencies: import('../../domain/types').TaskDependency[],
): Promise<void> {
    for (const dependency of dependencies) {
        await tx.setEntry(graphPath(root), `edge/${dependency.task}/${taskId}`, encode(dependency));
    }
}

export function taskFromSpec(id: string, sessionId: string, spec: TaskSpec, now: number): TaskRecord {
    const retry = normalizeRetry(spec.retry);
    const dependencies = spec.dependsOn ?? [];
    if (new Set(dependencies.map(dep => dep.task)).size !== dependencies.length) throw new Error('Duplicate task dependency');
    return {
        id, sessionId, retryOfTaskId: spec.retryOfTaskId, parentTaskId: spec.parent, rootTaskId: spec.parent ?? id,
        spawnKey: spec.spawnKey, program: spec.program,
        status: spec.deferStart ? 'created' : spec.dependsOn?.length ? 'blocked' : 'ready',
        input: spec.input, pendingEvents: [], dependencies, unresolvedDeps: spec.dependsOn?.length ?? 0,
        priority: spec.priority ?? 0, retry, attemptCount: 0, stepNumber: 0, stepAttemptCount: 0, stateRevision: 0, initialized: false,
        effects: {}, interactions: {}, labels: spec.labels, version: 0, createdAt: now, updatedAt: now,
    };
}

export function normalizeRetry(retry: import('../../domain/types').RetryPolicy | undefined): import('../../domain/types').RetryPolicy {
    const value = retry ?? { maxAttempts: 1 };
    if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1) {
        throw new Error('Retry maxAttempts must be a positive integer');
    }
    if (value.backoffMs !== undefined && (!Number.isFinite(value.backoffMs) || value.backoffMs < 0)) {
        throw new Error('Retry backoffMs must be non-negative');
    }
    return value;
}

export function isTerminal(status: TaskRecord['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function cancelActiveEffects(
    effects: TaskRecord['effects'],
    finishedAt: number,
): TaskRecord['effects'] {
    return Object.fromEntries(Object.entries(effects).map(([id, effect]) => {
        if (effect.status !== 'pending' && effect.status !== 'leased') return [id, effect];
        const current = effect.currentAttempt
            ? { ...effect.currentAttempt, finishedAt, outcome: 'cancelled' as const }
            : undefined;
        const attempts = current ? replaceAttempt(effect.attempts ?? [], current) : effect.attempts;
        return [id, { ...effect, status: 'cancelled' as const, cleanupPending: true, attempts, currentAttempt: undefined }];
    }));
}

export function replaceAttempt(attempts: EffectAttempt[], current: EffectAttempt): EffectAttempt[] {
    return attempts.map(attempt => attempt.id === current.id ? current : attempt);
}

export async function requireSessionTx(tx: ISeqFileTransaction, root: string): Promise<SessionRecord> {
    const value = await tx.getEntry(sessionPath(root), SESSION_KEY);
    if (!value) throw new Error(`Session record missing at ${root}`);
    const record = decode<SessionRecord>(value);
    // Every transactional Session operation refuses a layout this host cannot interpret.
    assertSessionLayout(record);
    return record;
}

export function validateSharedKey(key: string): void {
    if (!key || key.length > 256) throw new Error('Shared state key must contain 1-256 characters');
}

export async function readContextBranchTx(
    tx: ISeqFileTransaction,
    root: string,
    name: string,
): Promise<ContextBranch> {
    const value = await tx.getEntry(contextPath(root), contextBranchKey(name));
    return value ? decode(value) : { name, version: 0, updatedAt: 0 };
}

export function assertContextHead(name: string, actual: string | undefined, expected: string | null | undefined): void {
    if (expected === undefined) return;
    const matches = expected === null ? actual === undefined : actual === expected;
    if (!matches) throw new Error(`Context branch conflict for ${name}: expected ${expected}, got ${actual ?? 'missing'}`);
}

export async function requireContextParents(
    tx: ISeqFileTransaction,
    root: string,
    parentIds: string[],
): Promise<void> {
    for (const id of parentIds) {
        if (!await tx.getEntry(contextPath(root), contextCommitKey(id))) {
            throw new Error(`Context parent not found: ${id}`);
        }
    }
}

export async function writeContextBranchTx(
    tx: ISeqFileTransaction,
    root: string,
    name: string,
    head: string,
    version: number,
): Promise<void> {
    const branch: ContextBranch = { name, head, version: version + 1, updatedAt: Date.now() };
    await tx.setEntry(contextPath(root), contextBranchKey(name), encode(branch));
}

export async function collectContextHistory(
    binding: ResolvedStorageBinding,
    head: string,
): Promise<ContextCommit[]> {
    const commits = new Map<string, ContextCommit>();
    const pending = [head];
    while (pending.length > 0) {
        const id = pending.pop()!;
        if (commits.has(id)) continue;
        const value = await seq(binding.fs).getEntry(contextPath(binding.rootPath), contextCommitKey(id));
        if (!value) throw new Error(`Context commit not found: ${id}`);
        const commit = decode<ContextCommit>(value);
        commits.set(id, commit);
        pending.push(...commit.parentIds);
    }
    return [...commits.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function requireResourceTx(
    tx: ISeqFileTransaction,
    root: string,
    id: string,
): Promise<ResourceRecord> {
    const value = await tx.getEntry(resourcesPath(root), resourceKey(id));
    if (!value) throw new Error(`Resource not found: ${id}`);
    return decode(value);
}

export async function requireHandleTx(
    tx: ISeqFileTransaction,
    root: string,
    id: string,
): Promise<ResourceHandle> {
    const value = await tx.getEntry(resourcesPath(root), handleKey(id));
    if (!value) throw new Error(`Resource handle not found: ${id}`);
    return decode(value);
}

export async function authorizeHandleTx(
    tx: ISeqFileTransaction,
    root: string,
    handle: ResourceHandle,
    right: ResourceRight,
): Promise<ResourceRecord> {
    const resource = await requireResourceTx(tx, root, handle.resourceId);
    await assertHandleChainActive(tx, root, handle, resource.generation);
    if (!handle.rights.includes('admin') && !handle.rights.includes(right)) {
        throw kernelError(KernelErrorCode.HANDLE_LACKS_RIGHT, `Handle ${handle.id} lacks ${right} right`);
    }
    return resource;
}

export async function assertHandleChainActive(
    tx: ISeqFileTransaction,
    root: string,
    handle: ResourceHandle,
    generation: number,
): Promise<void> {
    let current: ResourceHandle | undefined = handle;
    const visited = new Set<string>();
    while (current) {
        if (visited.has(current.id)) throw new Error(`Resource handle cycle: ${current.id}`);
        if (current.revokedAt || current.generation !== generation) throw new Error(`Resource handle revoked: ${current.id}`);
        visited.add(current.id);
        current = current.parentHandleId ? await requireHandleTx(tx, root, current.parentHandleId) : undefined;
    }
}

export function assertRightsSubset(parent: ResourceHandle, rights: ResourceRight[]): void {
    if (parent.rights.includes('admin')) return;
    for (const right of rights) {
        if (!parent.rights.includes(right)) throw new Error(`Grant would elevate ${right} right`);
    }
}

export function uniqueRights(rights: ResourceRight[]): ResourceRight[] {
    return [...new Set(rights)];
}

export async function allHandlesTx(
    tx: ISeqFileTransaction,
    root: string,
): Promise<Map<string, ResourceHandle>> {
    const handles = new Map<string, ResourceHandle>();
    await tx.walkEntries(resourcesPath(root), entry => {
        const handle = decode<ResourceHandle>(entry.value);
        handles.set(handle.id, handle);
        return true;
    }, { keyPrefix: 'handle/' });
    return handles;
}

export function descendantHandleIds(handles: Map<string, ResourceHandle>, rootId: string): Set<string> {
    const result = new Set([rootId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const handle of handles.values()) {
            if (handle.parentHandleId && result.has(handle.parentHandleId) && !result.has(handle.id)) {
                result.add(handle.id);
                changed = true;
            }
        }
    }
    return result;
}

export async function readBudgetTx(
    tx: ISeqFileTransaction,
    root: string,
    resourceId: string,
    dimension: string,
): Promise<BudgetAccount | undefined> {
    const value = await tx.getEntry(resourcesPath(root), budgetKey(resourceId, dimension));
    return value ? decode(value) : undefined;
}

export async function readBudgetUsageTx(
    tx: ISeqFileTransaction,
    root: string,
    usageId: string,
): Promise<import('../../domain/types').BudgetUsage | undefined> {
    const value = await tx.getEntry(resourcesPath(root), budgetUsageKey(usageId));
    return value ? decode(value) : undefined;
}

export function assertBudgetVersion(
    resourceId: string,
    dimension: string,
    actual: number | undefined,
    expected: number | null | undefined,
): void {
    if (expected === undefined) return;
    const matches = expected === null ? actual === undefined : actual === expected;
    if (!matches) throw new Error(`Budget conflict for ${resourceId}/${dimension}`);
}

export function budgetAccount(
    resourceId: string,
    dimension: string,
    hardLimit: number,
    current?: BudgetAccount,
): BudgetAccount {
    if (!Number.isFinite(hardLimit) || hardLimit < (current?.used ?? 0)) throw new Error('Invalid budget hard limit');
    return {
        resourceId, dimension, hardLimit, used: current?.used ?? 0,
        version: (current?.version ?? 0) + 1, updatedAt: Date.now(),
    };
}

export async function resourceBudgetsTx(
    tx: ISeqFileTransaction,
    root: string,
    resource: ResourceRecord,
    dimension: string,
): Promise<BudgetAccount[]> {
    const budgets: BudgetAccount[] = [];
    let current: ResourceRecord | undefined = resource;
    while (current) {
        const budget = await readBudgetTx(tx, root, current.id, dimension);
        if (budget) budgets.push(budget);
        current = current.parentResourceId ? await requireResourceTx(tx, root, current.parentResourceId) : undefined;
    }
    return budgets;
}

export function assertBudgetCapacity(budget: BudgetAccount, amount: number): void {
    if (budget.used + amount > budget.hardLimit) {
        throw kernelError(KernelErrorCode.BUDGET_EXCEEDED, `Budget exceeded for ${budget.resourceId}/${budget.dimension}`);
    }
}

export async function readSharedTx<T extends import('../../domain/types').JsonValue>(
    tx: ISeqFileTransaction,
    root: string,
    key: string,
): Promise<SharedStateEntry<T> | undefined> {
    const value = await tx.getEntry(sharedPath(root), sharedKey(key));
    return value ? decode(value) : undefined;
}

export function assertSharedVersion(key: string, actual: number | undefined, expected: number | null | undefined): void {
    if (expected === undefined) return;
    const matches = expected === null ? actual === undefined : actual === expected;
    if (!matches) throw kernelError(KernelErrorCode.CONFLICT, `Shared state conflict for ${key}: expected ${expected}, got ${actual ?? 'missing'}`);
}

export function sharedEntry<T extends import('../../domain/types').JsonValue>(
    key: string,
    value: T,
    version: number,
    taskId?: TaskId,
): SharedStateEntry<T> {
    return { key, value, version, updatedAt: Date.now(), updatedByTaskId: taskId };
}

export async function nextSharedVersion(tx: ISeqFileTransaction, root: string, key: string): Promise<number> {
    const value = await tx.getEntry(sharedPath(root), sharedHeadKey(key));
    return (value ? Number(value) : 0) + 1;
}

export async function writeSharedRevision<T extends import('../../domain/types').JsonValue>(
    tx: ISeqFileTransaction,
    root: string,
    entry: SharedStateEntry<T>,
): Promise<void> {
    await tx.setEntry(sharedPath(root), sharedKey(entry.key), encode(entry));
    await writeSharedHistory(tx, root, { ...entry, deleted: false });
}

export async function writeSharedHistory(
    tx: ISeqFileTransaction,
    root: string,
    revision: SharedStateRevision,
): Promise<void> {
    const version = String(revision.version).padStart(16, '0');
    await tx.setEntry(sharedPath(root), sharedHeadKey(revision.key), String(revision.version));
    await tx.setEntry(sharedPath(root), `${sharedHistoryPrefix(revision.key)}${version}`, encode(revision));
    await refreshWaiters(tx, root, revision.key);
}

export function deletedRevision(key: string, version: number, taskId?: TaskId): SharedStateRevision {
    return { key, version, deleted: true, updatedAt: Date.now(), updatedByTaskId: taskId };
}

export async function applySharedMutations(
    tx: ISeqFileTransaction,
    root: string,
    task: TaskRecord,
    mutations: NonNullable<TaskCommitSideEffects['shared']>,
): Promise<void> {
    for (const mutation of mutations) {
        validateSharedKey(mutation.key);
        const current = await readSharedTx(tx, root, mutation.key);
        assertSharedVersion(mutation.key, current?.version, mutation.expectedVersion);
        if (mutation.type === 'delete') {
            if (current) {
                await tx.deleteEntry(sharedPath(root), sharedKey(mutation.key));
                await writeSharedHistory(tx, root, deletedRevision(mutation.key, current.version + 1, task.id));
                await appendEventTx(tx, root, task.sessionId, task.id,
                    'session.shared.deleted', { key: mutation.key, version: current.version + 1 });
            }
            continue;
        }
        const version = await nextSharedVersion(tx, root, mutation.key);
        const entry = sharedEntry(mutation.key, mutation.value, version, task.id);
        await writeSharedRevision(tx, root, entry);
        await appendEventTx(tx, root, task.sessionId, task.id,
            'session.shared.set', { key: mutation.key, version });
    }
}

export async function readMessages(
    binding: ResolvedStorageBinding,
    prefix: 'outbox/' | 'inbox/',
): Promise<CrossSessionMessage[]> {
    const messages: CrossSessionMessage[] = [];
    await seq(binding.fs).walkEntries(messagesPath(binding.rootPath), entry => {
        messages.push(decode(entry.value));
        return true;
    }, { keyPrefix: prefix });
    return messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function dependencySatisfied(
    task: TaskRecord,
    condition: import('../../domain/types').TaskDependency['condition'],
): boolean {
    return condition === 'terminal' ? isTerminal(task.status) : task.status === 'succeeded';
}

export async function registerTaskWaitTx(
    tx: ISeqFileTransaction,
    root: string,
    task: TaskRecord,
): Promise<TaskRecord> {
    if (task.status !== 'waiting' || !task.wait) return task;
    const wait = await normalizeWaitSpecTx(tx, root, task.id, task.wait);
    validateWaitSpec(wait);
    validateInteractionWaits(task, wait);
    task = await hydrateTaskWaitEventsTx(tx, root, { ...task, wait });
    task = await hydrateVersionWaits(tx, root, task);
    if (pendingSatisfiesWait(task)) {
        await unregisterTaskWaitTx(tx, root, task);
        return { ...task, status: 'ready', wait: undefined };
    }
    await registerTaskTargetsTx(tx, root, task);
    for (const key of sharedWaitKeys(task)) await tx.setEntry(graphPath(root), key, task.id);
    return task;
}

export async function normalizeWaitSpecTx(
    tx: ISeqFileTransaction,
    root: string,
    taskId: string,
    wait: import('../../domain/types').WaitSpec,
): Promise<import('../../domain/types').WaitSpec> {
    if (wait.type === 'child') {
        const value = await tx.getEntry(graphPath(root), spawnMappingKey(taskId, wait.spawnKey));
        if (!value) throw new Error(`Spawned child not found: ${wait.spawnKey}`);
        return { type: 'task', id: value };
    }
    if (wait.type !== 'any' && wait.type !== 'all' && wait.type !== 'quorum') return wait;
    const waits = await Promise.all(wait.waits.map(item => normalizeWaitSpecTx(tx, root, taskId, item)));
    return { ...wait, waits };
}

export function pendingSatisfiesWait(task: TaskRecord): boolean {
    return task.wait ? waitSatisfied(task.wait, task.pendingEvents) : false;
}

export async function unregisterTaskWaitTx(tx: ISeqFileTransaction, root: string, task: TaskRecord): Promise<void> {
    if (!task.wait) return;
    for (const targetId of waitTaskIds(task.wait)) {
        await tx.deleteEntry(graphPath(root), taskWaitKey(targetId, task.id));
    }
    for (const key of sharedWaitKeys(task)) await tx.deleteEntry(graphPath(root), key);
}

export async function wakeTaskWaiters(
    tx: ISeqFileTransaction,
    root: string,
    completed: TaskRecord,
): Promise<void> {
    if (!completed.exit) return;
    const keys: string[] = [];
    await tx.walkEntries(graphPath(root), entry => {
        keys.push(entry.key);
        return true;
    }, { keyPrefix: `wait/task/${completed.id}/` });
    for (const key of keys) await wakeTaskWaiter(tx, root, completed, key);
}

export async function wakeTaskWaiter(
    tx: ISeqFileTransaction,
    root: string,
    completed: TaskRecord,
    key: string,
): Promise<void> {
    const waiterId = key.split('/')[3];
    const waiter = await readTaskTx(tx, root, waiterId);
    await tx.deleteEntry(graphPath(root), key);
    if (!waiter || waiter.status !== 'waiting' || !waiter.wait) return;
    const event = childExitEvent(completed, waiter.id);
    const pendingEvents = hasTaskExit(waiter, completed.id)
        ? waiter.pendingEvents : [...waiter.pendingEvents, event];
    let next: TaskRecord = { ...waiter, pendingEvents, version: waiter.version + 1, updatedAt: Date.now() };
    next = wakeFromPendingEvents(next);
    if (next.status === 'ready') await unregisterTaskWaitTx(tx, root, waiter);
    await writeTaskTx(tx, root, next);
    await indexTask(tx, root, next);
    await appendEventTx(tx, root, waiter.sessionId, waiter.id,
        next.status === 'ready' ? 'task.wait.satisfied' : 'task.wait.progress', event);
}

export function wakeFromPendingEvents(task: TaskRecord): TaskRecord {
    if (task.status !== 'waiting' || !pendingSatisfiesWait(task)) return task;
    return { ...task, status: 'ready', wait: undefined };
}

export function waitSatisfied(
    wait: import('../../domain/types').WaitSpec,
    events: import('../../domain/types').TaskInputEvent[],
): boolean {
    if (wait.type === 'resource') return events.some(event => event.type === 'resource-result' && event.receipt.id === wait.requestId && event.receipt.scope === wait.scope);
    if (wait.type === 'message') return events.some(event => event.type === 'message' && (!wait.topic || event.message.topic === wait.topic) && (!wait.correlationId || event.message.correlationId === wait.correlationId));
    if (wait.type === 'cache-management') return events.some(event => event.type === 'cache-managed' && event.receipt.operationId === wait.operationId);
    if (wait.type === 'cache') return events.some(event => event.type === 'cache-result' && event.receipt.operationId === wait.operationId);
    if (wait.type === 'shared-version') return events.some(event => event.type === 'shared-changed' && event.revision.key === wait.key && event.revision.version > wait.afterVersion);
    if (wait.type === 'timer') return events.some(event => event.type === 'timer-fired' && event.id === wait.id && event.at === wait.at);
    if (wait.type === 'signal') return events.some(event => event.type === 'signal' && (!wait.id || event.signal.type === wait.id));
    if (wait.type === 'effect') return events.some(event => (event.type === 'effect-completed' || event.type === 'effect-failed') && (!wait.id || event.effectId === wait.id));
    if (wait.type === 'task') return events.some(event => event.type === 'task-exited' && event.taskId === wait.id);
    if (wait.type === 'interaction') {
        return events.some(event => event.type === 'interaction-resolved' && event.interactionId === wait.id);
    }
    if (wait.type === 'child') return false;
    const satisfied = wait.waits.filter(item => waitSatisfied(item, events)).length;
    if (wait.type === 'any') return satisfied >= 1;
    if (wait.type === 'all') return satisfied === wait.waits.length;
    return satisfied >= wait.required;
}

export function validateWaitSpec(wait: import('../../domain/types').WaitSpec): void {
    if (wait.type === 'resource' && (!wait.scope || !wait.requestId)) throw new Error('Invalid resource wait');
    if (wait.type === 'shared-version' && (!wait.key || !Number.isInteger(wait.afterVersion) || wait.afterVersion < 0)) throw new Error('Invalid shared version wait');
    if (wait.type === 'timer' && (!wait.id || !Number.isFinite(wait.at))) throw new Error('Invalid timer wait');
    if (wait.type !== 'any' && wait.type !== 'all' && wait.type !== 'quorum') return;
    if (wait.waits.length === 0) throw new Error(`${wait.type} wait requires at least one condition`);
    if (wait.type === 'quorum' && (!Number.isInteger(wait.required) || wait.required < 1 || wait.required > wait.waits.length)) {
        throw new Error('Quorum wait has invalid required count');
    }
    for (const item of wait.waits) validateWaitSpec(item);
}

export function validateInteractionWaits(task: TaskRecord, wait: import('../../domain/types').WaitSpec): void {
    if (wait.type === 'interaction' && !task.interactions?.[wait.id]) {
        throw new Error(`Interaction wait target not found: ${wait.id}`);
    }
    if (wait.type !== 'any' && wait.type !== 'all' && wait.type !== 'quorum') return;
    for (const item of wait.waits) validateInteractionWaits(task, item);
}

export function waitTaskIds(wait: import('../../domain/types').WaitSpec): string[] {
    if (wait.type === 'task') return [wait.id];
    if (wait.type !== 'any' && wait.type !== 'all' && wait.type !== 'quorum') return [];
    return [...new Set(wait.waits.flatMap(waitTaskIds))];
}

export async function hydrateTaskWaitEventsTx(
    tx: ISeqFileTransaction,
    root: string,
    task: TaskRecord,
): Promise<TaskRecord> {
    if (!task.wait) return task;
    let pendingEvents = task.pendingEvents;
    for (const targetId of waitTaskIds(task.wait)) {
        if (targetId === task.id) throw new Error(`Task cannot wait for itself: ${task.id}`);
        const target = await readTaskTx(tx, root, targetId);
        if (!target) throw new Error(`Wait target not found: ${targetId}`);
        if (isTerminal(target.status) && target.exit && !hasTaskExit(task, targetId)) {
            pendingEvents = [...pendingEvents, childExitEvent(target, task.id)];
        }
    }
    return { ...task, pendingEvents };
}

export async function registerTaskTargetsTx(
    tx: ISeqFileTransaction,
    root: string,
    task: TaskRecord,
): Promise<void> {
    if (!task.wait) return;
    for (const targetId of waitTaskIds(task.wait)) {
        const target = await requireTaskTx(tx, root, targetId);
        if (!isTerminal(target.status)) {
            await tx.setEntry(graphPath(root), taskWaitKey(targetId, task.id), encode(task.wait));
        }
    }
}

export function hasTaskExit(task: TaskRecord, targetId: string): boolean {
    return task.pendingEvents.some(event => event.type === 'task-exited' && event.taskId === targetId);
}

/** Only the actual parent receives the persisted spawn correlation key. */
function childExitEvent(child: TaskRecord, waiterId: string): import('../../domain/types').TaskInputEvent {
    return { type: 'task-exited', taskId: child.id, exit: child.exit!,
        ...(child.parentTaskId === waiterId && child.spawnKey ? { spawnKey: child.spawnKey } : {}) };
}

export async function advanceDependants(
    tx: ISeqFileTransaction,
    root: string,
    completed: TaskRecord,
): Promise<void> {
    const edges: Array<{ dependentId: string; dependency: import('../../domain/types').TaskDependency }> = [];
    await tx.walkEntries(graphPath(root), entry => {
        edges.push({ dependentId: entry.key.split('/')[2], dependency: decode(entry.value) });
        return true;
    }, { keyPrefix: `edge/${completed.id}/` });
    for (const edge of edges) await advanceDependant(tx, root, completed, edge);
}

export async function advanceDependant(
    tx: ISeqFileTransaction,
    root: string,
    completed: TaskRecord,
    edge: { dependentId: string; dependency: import('../../domain/types').TaskDependency },
): Promise<void> {
    const task = await readTaskTx(tx, root, edge.dependentId);
    if (!task) {
        await tx.deleteEntry(graphPath(root), `edge/${completed.id}/${edge.dependentId}`);
        return;
    }
    if (task.status !== 'blocked' && task.status !== 'created') return;
    if (hasTaskExit(task, completed.id)) return;
    const failed = completed.status !== 'succeeded' && edge.dependency.condition !== 'terminal';
    if (failed && edge.dependency.onFailure !== 'continue') {
        const status = edge.dependency.onFailure === 'skip' ? 'cancelled' as const : 'failed' as const;
        const next = terminalDependency(task, status, completed.id);
        await writeTaskTx(tx, root, next);
        await indexTask(tx, root, next);
        await appendEventTx(tx, root, next.sessionId, next.id, `task.${status}`, next.exit);
        await advanceDependants(tx, root, next);
        await wakeTaskWaiters(tx, root, next);
        return;
    }
    const unresolvedDeps = Math.max(0, task.unresolvedDeps - 1);
    const pendingEvents = [...task.pendingEvents, {
        type: 'task-exited' as const, taskId: completed.id, exit: completed.exit!,
    }];
    const next = { ...task, unresolvedDeps, pendingEvents,
        status: task.status === 'created'
            ? 'created' as const
            : unresolvedDeps === 0 ? 'ready' as const : 'blocked' as const,
        version: task.version + 1, updatedAt: Date.now() };
    await writeTaskTx(tx, root, next);
    await indexTask(tx, root, next);
}

export function terminalDependency(
    task: TaskRecord,
    status: 'failed' | 'cancelled',
    dependencyId: string,
): TaskRecord {
    const completedAt = Date.now();
    const error = { message: `Dependency ${dependencyId} did not succeed` };
    return { ...task, status, exit: { taskId: task.id, status, error, completedAt },
        version: task.version + 1, updatedAt: completedAt };
}

export function waitLeaves(wait: import('../../domain/types').WaitSpec): import('../../domain/types').WaitAtom[] {
    return wait.type === 'any' || wait.type === 'all' || wait.type === 'quorum'
        ? wait.waits.flatMap(waitLeaves) : [wait];
}

/** Capture immutable revisions inside the writer/register transaction. */
export async function hydrateVersionWaits(tx: ISeqFileTransaction, root: string, task: TaskRecord): Promise<TaskRecord> {
    if (!task.wait) return task;
    const pendingEvents = [...task.pendingEvents];
    for (const leaf of waitLeaves(task.wait)) {
        if (waitSatisfied(leaf, pendingEvents)) continue;
        if (leaf.type === 'timer' && leaf.at <= Date.now()) {
            pendingEvents.push({ type: 'timer-fired', id: leaf.id, at: leaf.at });
        }
        if (leaf.type === 'shared-version') {
            const head = await tx.getEntry(sharedPath(root), sharedHeadKey(leaf.key));
            if (Number(head ?? 0) <= leaf.afterVersion) continue;
            const revision = await tx.getEntry(sharedPath(root), `${sharedHistoryPrefix(leaf.key)}${String(head).padStart(16, '0')}`);
            if (revision) pendingEvents.push({ type: 'shared-changed', revision: decode(revision) });
        }
    }
    return { ...task, pendingEvents };
}

function sharedWaitKeys(task: TaskRecord): string[] {
    if (!task.wait) return [];
    return [...new Set(waitLeaves(task.wait).flatMap(leaf => leaf.type === 'shared-version'
        ? [`wait/shared/${encodeURIComponent(leaf.key)}/${task.id}`] : []))];
}

/** Writer path visits only subscribers; sweep also reconciles task exits and timers. */
export async function refreshWaiters(tx: ISeqFileTransaction, root: string, sharedKey?: string): Promise<void> {
    const ids: string[] = [];
    if (sharedKey !== undefined) {
        await tx.walkEntries(graphPath(root), row => { ids.push(row.value); return true; },
            { keyPrefix: `wait/shared/${encodeURIComponent(sharedKey)}/` });
    } else {
        await tx.walkEntries(indexPath(root), row => {
            if (decode<{ status: string }>(row.value).status === 'waiting') ids.push(row.key.slice(5));
            return true;
        }, { keyPrefix: 'task/' });
    }
    for (const id of ids) {
        const task = await readTaskTx(tx, root, id);
        if (!task || task.status !== 'waiting' || !task.wait) continue;
        const hydrated = await hydrateVersionWaits(tx, root, sharedKey === undefined ? await hydrateTaskWaitEventsTx(tx, root, task) : task);
        if (hydrated.pendingEvents.length === task.pendingEvents.length) continue;
        const next = wakeFromPendingEvents({ ...hydrated, version: task.version + 1, updatedAt: Date.now() });
        if (next.status === 'ready') await unregisterTaskWaitTx(tx, root, task);
        await writeTaskTx(tx, root, next);
        await indexTask(tx, root, next);
        await appendEventTx(tx, root, task.sessionId, id, next.status === 'ready' ? 'task.wait.satisfied' : 'task.wait.progress');
    }
}

/** Cancellation of any ancestor is a persistent dispatch barrier. */
export async function hasCancelledAncestorTx(tx: ISeqFileTransaction, root: string, task: TaskRecord): Promise<boolean> {
    const seen = new Set([task.id]);
    let parentId = task.parentTaskId;
    while (parentId) {
        if (seen.has(parentId)) throw new Error('Task parent cycle');
        seen.add(parentId);
        const parent = await requireTaskTx(tx, root, parentId);
        if (parent.status === 'cancelled') return true;
        parentId = parent.parentTaskId;
    }
    return false;
}

/**
 * Rebuild projections from task records without discarding legacy dependency edges.
 *
 * `records` carries the Task records the caller already read while the Session was
 * idle and leased; entries are reused instead of re-read, and any Task this pass
 * rewrites is written back into the map so the later passes see the new version.
 * Ids discovered through the index (Tasks created after the caller's scan) are
 * still read inside the transaction.
 */
export async function recoverWaitGraphTx(tx: ISeqFileTransaction, root: string, ids: string[],
    records?: Map<string, TaskRecord>): Promise<void> {
    // Include tasks created after the caller enumerated directories/indexes.
    const allIds = new Set(ids);
    await tx.walkEntries(indexPath(root), row => { allIds.add(row.key.slice(5)); return true; }, { keyPrefix: 'task/' });
    const keys: string[] = [];
    await tx.walkEntries(graphPath(root), row => { keys.push(row.key); return true; }, { keyPrefix: 'wait/' });
    for (const key of keys) await tx.deleteEntry(graphPath(root), key);
    const read = async (id: string): Promise<TaskRecord | null> => records?.get(id) ?? await readTaskTx(tx, root, id);
    const completed: TaskRecord[] = [];
    for (const id of allIds) {
        const task = await read(id);
        if (!task) continue;
        if (isTerminal(task.status)) completed.push(task);
        if (task.dependencies) await writeDependencyEdges(tx, root, id, task.dependencies);
        if (task.status === 'waiting') {
            const next = await registerTaskWaitTx(tx, root, task);
            if (encode(next) !== encode(task)) {
                next.version = task.version + 1; next.updatedAt = Date.now();
                await writeTaskTx(tx, root, next);
                await indexTask(tx, root, next);
                records?.set(id, next);
                await appendEventTx(tx, root, task.sessionId, id,
                    next.status === 'ready' ? 'task.wait.satisfied' : 'task.wait.progress');
            }
        }
    }
    if (!completed.length) return;
    const edgeSources = new Set<string>(), waitTargets = new Set<string>();
    await tx.walkEntries(graphPath(root), row => { edgeSources.add(row.key.split('/')[1]); return true; }, { keyPrefix: 'edge/' });
    await tx.walkEntries(graphPath(root), row => { waitTargets.add(row.key.split('/')[2]); return true; }, { keyPrefix: 'wait/task/' });
    for (const task of completed) {
        if (edgeSources.has(task.id)) await advanceDependants(tx, root, task);
        if (waitTargets.has(task.id)) await wakeTaskWaiters(tx, root, task);
    }
}

export async function validateRetrySourceTx(tx: ISeqFileTransaction, root: string, taskId: TaskId | undefined): Promise<void> {
    if (taskId === undefined) return;
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid retry source Task');
    const original = await requireTaskTx(tx, root, taskId);
    if (!isTerminal(original.status)) throw new Error('Manual retry requires a terminal Task');
}
