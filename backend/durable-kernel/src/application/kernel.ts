import type { LeaseGuardOptions } from '../domain/types';
import { EventBus, FSError, pathUtils, type IFileSystem } from '@itookit/vfs-core';
import { EffectRegistry, ProgramRegistry, StorageResolverRegistry, WorkspaceRegistry } from '../ports/registry';
import type { KernelPlugin, KernelRegistration } from '../ports/plugin';
import { DurablePoller } from '../runtime/durable-poller';
import { LeaseHeartbeat } from '../runtime/lease-heartbeat';
import { EffectCleanupRunner } from '../runtime/effect-cleanup';
import { DefaultSessionHandle } from '../public/session-handle';
import { DefaultTaskHandle } from '../public/task-handle';
import { resourceApi } from '../public/resources';
import { closedSessionStat, sessionStat } from '../domain/status';
import { ManagedResourceStore } from '../infrastructure/seqfile/managed-resources';
import { catalogPath, eventsPath, resourcesPath } from '../infrastructure/seqfile/seqfile-core';
import {
    createId,
    SeqFileKernelStore,
    type EffectClaim,
    type TaskClaim,
} from '../infrastructure/seqfile/store';
import type {
    BudgetAccount,
    ContextBranch,
    ContextCommit,
    ContextCommitOptions,
    CrossSessionMessage,
    Decision,
    DurableTaskProgram,
    EffectAdapter,
    EffectRequest,
    EventEnvelope,
    InteractionResponse,
    RecoveryReport,
    ResolvedStorageBinding,
    ResourceGrant,
    ResourceHandle,
    ResourceRecord,
    ResourceRight,
    ResourceSpec,
    SessionHandle,
    SessionId,
    SessionRecord,
    SharedStateEntry,
    SharedStateRevision,
    SharedStateWriteOptions,
    SessionStorageResolver,
    StorageBindingRef,
    TaskHandle,
    TaskId,
    TaskRecord,
    TaskSignal,
    TaskSnapshot,
    WorkspaceAdapter,
    WorkspaceDiff,
    WorkspaceMergeResult,
    WorkspaceSnapshot,
} from '../domain/types';
import { assertDurableValue } from './durability';
import { KernelError, KernelErrorCode, kernelError } from '../domain/errors';
import { failureDecision, isTerminalStatus, mergeReport, nextDecision, shouldRetry, transition, validateDecision } from './decision';
import { activeEffectIds, addEffect, addInteraction, effectControllerKey, effectFailure, executeEffectWithDeadline, isMissingPath, normalizeEffect, type RequiredEffect } from './effect-utils';
import { assertWorkspace, assertWorkspaceSnapshots, readWorkspaceSnapshots, workspaceContext, workspaceSnapshot } from './workspace-utils';
import { decisionSideEffects, prepareSpawns } from './actions';

/**
 * Why a `changed` notification fired.
 *
 * - `structure`: a Task/Session was created, removed, or changed status — views
 *   that list them (sidebars, task trees) must re-read.
 * - `content`: a Task's content moved (stream deltas, logs, shared state, context
 *   commits) without changing what those listings show. Fires many times per
 *   second while a run streams, so consumers must not re-render on it.
 */
export type { KernelChangeReason } from '../ports/kernel-view';
import type { KernelChangeReason, KernelInspectionPort, KernelViewPort } from '../ports/kernel-view';

interface KernelEvents { changed: { sessionId: string; taskId?: string; reason: KernelChangeReason }; }

export interface KernelOptions {
    catalog: { fs: IFileSystem; rootPath?: string };
    workerId?: string;
    maxConcurrent?: number;
    maxConcurrentEffects?: number;
    leaseMs?: number;
    /** Maximum wait for Effect cleanup confirmation; default 30 seconds. */
    effectCleanupTimeoutMs?: number;
    /** Optional compatibility polling; default 0 uses commits and deadline timers. */
    pollMs?: number;
}

export class Kernel implements KernelRegistration, KernelViewPort, KernelInspectionPort {
    private readonly resourcePoller: DurablePoller<string>;
    private readonly managedResources: ManagedResourceStore;
    get resources() { return resourceApi(this.managedResources, {}); }
    resourceApi(sessionId: string, taskId?: string) { return resourceApi(this.managedResources, { sessionId, taskId }); }
    async sessionStat(sessionId: string) {
        try {
            const binding = await this.binding(sessionId);
            const session = await this.store.sessionRecord(binding);
            // An interrupted removal leaves records without storage; the Session
            // cannot be open, so report it closed instead of blocking cleanup.
            if (session.status !== 'closed' && !await binding.fs.driver.exists(binding.rootPath)) return closedSessionStat(sessionId);
            return sessionStat(session, session.status === 'closing' && !await this.managedResources.canClose(sessionId));
        } catch (error) {
            if (isMissingStorage(error)) return closedSessionStat(sessionId);
            throw error;
        }
    }
    readonly programs = new ProgramRegistry();
    readonly effects = new EffectRegistry();
    readonly storageResolvers = new StorageResolverRegistry();
    readonly workspaces = new WorkspaceRegistry();
    private readonly eventsBus = new EventBus<KernelEvents>();
    private readonly sessions = new Map<SessionId, ResolvedStorageBinding>();
    private readonly catalogFs: IFileSystem;
    private readonly catalogRoot: string;
    private catalogListener?: () => void;
    private readonly storageListeners = new Map<SessionId, () => void>();
    private readonly requestedDrains = new Set<SessionId>();
    private readonly draining = new Set<SessionId>();
    private readonly store: SeqFileKernelStore;
    /** Task list read during the current poll tick, shared until nextWakeDelay consumes it. */
    private readonly tickTasks = new Map<SessionId, TaskRecord[]>();
    /** Resource deadlines already computed by this tick's sweeps, reused instead of re-reading. */
    private readonly tickManaged = new Map<SessionId, { kernel: number | undefined; session: number | undefined }>();
    private readonly workerId: string;
    private readonly maxConcurrent: number;
    private readonly maxConcurrentEffects: number;
    private readonly leaseMs: number;
    private readonly effectCleanup: EffectCleanupRunner;
    private readonly poller: DurablePoller<SessionId>;
    private readonly heartbeats = new Set<LeaseHeartbeat>();
    private readonly effectControllers = new Map<string, AbortController>();
    private readonly plugins = new Map<string, KernelPlugin>();
    private disposed = false;
    private initialized = false;
    private active = 0;
    private activeEffects = 0;
    private readonly reducerControllers = new Map<string, { sessionId: string; taskId: string; controller: AbortController }>();

    constructor(options: KernelOptions) {
        this.workerId = options.workerId ?? createId('worker');
        this.maxConcurrent = options.maxConcurrent ?? 4;
        this.maxConcurrentEffects = options.maxConcurrentEffects ?? 4;
        this.leaseMs = options.leaseMs ?? 30_000;
        this.effectCleanup = new EffectCleanupRunner(options.effectCleanupTimeoutMs ?? 30_000);
        const pollMs = options.pollMs ?? 0;
        if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 0) throw new Error('Kernel maxConcurrent must be a non-negative safe integer');
        if (!Number.isSafeInteger(this.maxConcurrentEffects) || this.maxConcurrentEffects < 0) throw new Error('Kernel maxConcurrentEffects must be a non-negative safe integer');
        if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > Number.MAX_SAFE_INTEGER - Date.now()) throw new Error('Kernel leaseMs must be a positive safe duration');
        if (!Number.isSafeInteger(pollMs) || pollMs < 0) throw new Error('Kernel pollMs must be a non-negative safe integer');
        const catalog = { fs: options.catalog.fs, rootPath: options.catalog.rootPath ?? '/.config/kernel' };
        this.catalogFs = catalog.fs;
        this.catalogRoot = catalog.rootPath;
        this.store = new SeqFileKernelStore(catalog, reference => this.resolveStorage(reference));
        this.managedResources = new ManagedResourceStore(catalog, id => this.binding(id),
            async () => (await this.store.listSessions()).map(session => session.id),
            id => this.store.inspectSessionBinding(id));
        this.resourcePoller = new DurablePoller({
            intervalMs: 0,
            poll: async scope => {
                const at = await this.managedResources.sweep(scope);
                return { nextDelay: at === undefined ? undefined : Math.max(0, at - Date.now()) };
            },
            onError: (_scope, error) => this.handlePollError(error),
        });
        this.poller = new DurablePoller({
            intervalMs: pollMs,
            poll: sessionId => this.poll(sessionId),
            nextDelay: sessionId => this.nextWakeDelay(sessionId),
            onError: (_sessionId, error) => this.handlePollError(error),
        });
    }

    async resolveEffect(sessionId: string, taskId: string, request: import('../domain/types').EffectResolution): Promise<void> {
        await this.store.resolveEffect(await this.binding(sessionId), taskId, request);
        this.notify(sessionId, taskId); this.queueDrain(sessionId);
    }

    async sendTaskMessage(sessionId: string, taskId: string, request: import('../domain/types').TaskMessageRequest) {
        const message = await this.store.sendTaskMessage(await this.binding(sessionId), taskId, request);
        this.notify(sessionId, undefined, 'content'); this.queueDrain(sessionId);
        return message;
    }

    async createCache(sessionId: string, taskId: string, spec: import('../domain/cache').CacheSpec) { return this.store.createCache(await this.binding(sessionId), taskId, spec); }
    async readCache(sessionId: string, taskId: string, request: import('../domain/cache').CacheRead) { return this.store.readCache(await this.binding(sessionId), taskId, request); }
    async publishCache(sessionId: string, taskId: string, request: import('../domain/cache').CachePublish) { return this.store.publishCache(await this.binding(sessionId), taskId, request); }
    async invalidateCache(sessionId: string, taskId: string, handleId: string, expectedGeneration: number) { return this.store.invalidateCache(await this.binding(sessionId), taskId, handleId, expectedGeneration); }
    async renewCache(sessionId: string, taskId: string, handleId: string, expectedGeneration: number, ttlMs: number) { return this.store.renewCache(await this.binding(sessionId), taskId, handleId, expectedGeneration, ttlMs); }
    async listCaches(sessionId: string, taskId: string) { return this.store.listCaches(await this.binding(sessionId), taskId); }

    async initialize(): Promise<void> {
        await this.store.initialize(); await this.managedResources.initialize();
        this.initialized = true;
        this.catalogListener?.();
        this.catalogListener = this.catalogFs.on('seq:committed', event => {
            const paths = event.payload.paths.map(path => pathUtils.normalize(path));
            const catalogChanged = paths.includes(pathUtils.normalize(catalogPath(this.catalogRoot)));
            const resourcesChanged = paths.includes(pathUtils.normalize(resourcesPath(this.catalogRoot)));
            // Resource-only writes wake cleanup without rescanning every Session.
            if (catalogChanged || resourcesChanged) this.resourcePoller.start('kernel');
            if (!catalogChanged) return;
            for (const id of this.sessions.keys()) this.schedulePoll(id);
        });
        this.resourcePoller.start('kernel');
    }
    get isDisposed(): boolean { return this.disposed; }

    dispose(): void {
        this.disposed = true;
        this.tickTasks.clear();
        this.tickManaged.clear();
        this.poller.dispose();
        this.resourcePoller.dispose();
        this.managedResources.dispose();
        this.catalogListener?.();
        for (const off of this.storageListeners.values()) off();
        this.storageListeners.clear();
        for (const heartbeat of this.heartbeats) heartbeat.stop();
        this.heartbeats.clear();
        for (const { controller } of this.reducerControllers.values()) controller.abort(new Error('Worker disposed'));
        for (const controller of this.effectControllers.values()) controller.abort();
        this.effectControllers.clear();
    }

    /** 等待所有 in-flight 的 drain/execute 完成（dispose 后调用，避免上层过早关闭存储后端）。 */
    async waitIdle(timeoutMs = 5000): Promise<void> {
        const startedAt = Date.now();
        while (this.active > 0 || this.activeEffects > 0 || this.draining.size > 0 || !this.poller.isIdle || !this.resourcePoller.isIdle || !this.managedResources.isIdle) {
            if (Date.now() - startedAt >= timeoutMs) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    registerProgram(program: DurableTaskProgram): void { this.programs.register(program); for (const id of this.sessions.keys()) this.schedulePoll(id); }
    registerResourceAdapter(adapter: import('../domain/resource-api').ManagedResourceAdapter): void {
        this.managedResources.registerAdapter(adapter);
        if (!this.initialized) return;
        this.resourcePoller.start('kernel');
        for (const id of this.sessions.keys()) this.resourcePoller.start(`session:${id}`);
    }
    registerEffect(adapter: EffectAdapter): void { this.effects.register(adapter); for (const id of this.sessions.keys()) this.schedulePoll(id); }
    registerStorageResolver(resolver: SessionStorageResolver): void { this.storageResolvers.register(resolver); }
    registerWorkspace(adapter: WorkspaceAdapter): void { this.workspaces.register(adapter); }

    async use(plugin: KernelPlugin): Promise<void> {
        const key = `${plugin.id}@${plugin.version}`;
        if (this.plugins.has(key)) throw new Error(`Kernel plugin already installed: ${key}`);
        await plugin.install(this);
        this.plugins.set(key, plugin);
    }

    async createSession(spec: { id?: string; storage: StorageBindingRef }): Promise<SessionHandle> {
        const id = spec.id ?? createId('session');
        await this.store.createSession(id, spec.storage);
        const binding = await this.resolveStorage(spec.storage);
        this.rememberBinding(id, binding);
        this.schedulePoll(id);
        return new DefaultSessionHandle(this, id);
    }

    async openSession(id: SessionId, expectedStorage?: StorageBindingRef): Promise<SessionHandle> {
        const opened = await this.store.openSession(id, { expectedStorage, previousBinding: this.sessions.get(id) });
        this.rememberBinding(id, opened.binding);
        this.queueDrain(id);
        this.schedulePoll(id);
        return new DefaultSessionHandle(this, id);
    }

    private readonly sessionReopens = new Map<string, Promise<SessionHandle>>();

    /** Admit new Tasks after an explicit user rerun, without reviving any previous Task. */
    async reopenSession(id: SessionId): Promise<SessionHandle> {
        const pending = this.sessionReopens.get(id);
        if (pending) return pending;
        const work = this.reopenClosedSession(id);
        this.sessionReopens.set(id, work);
        try { return await work; }
        finally { if (this.sessionReopens.get(id) === work) this.sessionReopens.delete(id); }
    }

    private async reopenClosedSession(id: SessionId): Promise<SessionHandle> {
        const binding = await this.binding(id);
        const session = await this.store.sessionRecord(binding);
        if (session.status === 'open') return new DefaultSessionHandle(this, id);
        if (session.status !== 'closed') throw new Error(`Cannot reopen session: ${session.status}`);
        await this.sessionClosures.get(id);
        await Promise.all([...this.plugins.values()].map(plugin => plugin.onSessionClosed?.(id)));
        await this.store.reopenSession(binding);
        this.rememberBinding(id, binding);
        this.notify(id); this.queueDrain(id); this.schedulePoll(id);
        return new DefaultSessionHandle(this, id);
    }

    async *listSessions(): AsyncIterable<SessionRecord> {
        for (const session of await this.store.listSessions()) yield session;
    }

    /** Inspect persisted records without registering listeners or starting execution. */
    async inspectSession(id: SessionId) {
        const { record, binding } = await this.store.inspectSessionStorage(id);
        // The catalog binding reference is returned alongside the resolved binding so a caller can
        // observe one Session without enumerating every other Session record.
        return { id, storage: record.storage, listTasks: () => this.store.listTasks(binding),
            listPendingInteractionTasks: () => this.store.listPendingInteractionTasks(binding),
            getShared: <T extends import('../domain/types').JsonValue>(key: string) => this.store.getShared<T>(binding, key),
            attachTask: async <O = unknown>(taskId: string): Promise<TaskHandle<O>> => {
                await this.store.readTask(binding, taskId);
                return new DefaultTaskHandle<O>(this, id, taskId);
            } };
    }

    async openTask<O = unknown>(id: TaskId): Promise<TaskHandle<O>> {
        const sessionId = await this.store.locateTask(id);
        if (!this.sessions.has(sessionId)) await this.openSession(sessionId);
        return new DefaultTaskHandle<O>(this, sessionId, id);
    }

    async inspectTask(id: TaskId): Promise<TaskSnapshot> {
        const handle = await this.openTask(id);
        return handle.status();
    }

    async attachTask<O = unknown>(sessionId: SessionId, taskId: TaskId): Promise<TaskHandle<O>> {
        const task = await this.store.readTask(await this.store.inspectSessionBinding(sessionId), taskId);
        if (task.sessionId !== sessionId) throw new Error(`Task ${taskId} does not belong to session ${sessionId}`);
        return new DefaultTaskHandle<O>(this, sessionId, taskId);
    }

    async listSessionTasks(sessionId: SessionId): Promise<TaskRecord[]> {
        return this.store.listTasks(await this.binding(sessionId));
    }

    /** Read pending interactions without enumerating completed Task directories. */
    async listSessionPendingInteractionTasks(sessionId: SessionId): Promise<TaskRecord[]> {
        return this.store.listPendingInteractionTasks(await this.binding(sessionId));
    }

    /** Restore durable state without clearing explicit Task/Session pause controls. */
    async recoverSession(sessionId: SessionId, options: import('../domain/types').RecoveryOptions = {}): Promise<RecoveryReport> {
        if (options.takeover && (this.active || this.activeEffects || this.draining.size || !this.poller.isIdle))
            throw new Error('Takeover recovery requires an idle Kernel before opening sessions');
        const opened = await this.store.openSession(sessionId);
        // `openSession` already read the record; pass it so recovery does not read it again.
        const report = await this.store.recover(opened.binding, options, opened.record);
        await this.managedResources.recover('kernel', options.takeover);
        await this.managedResources.recover(`session:${sessionId}`, options.takeover);
        this.rememberBinding(sessionId, opened.binding);
        await this.poll(sessionId);
        this.schedulePoll(sessionId);
        return report;
    }

    async recover(options: import('../domain/types').RecoveryOptions = {}): Promise<RecoveryReport> {
        const report = await this.recoverSessions((await this.store.listSessions()).map(session => session.id), options);
        await this.relayPendingMessages();
        return report;
    }

    /** Restore all leased Sessions before starting any of their workers. */
    async recoverSessions(sessionIds: SessionId[], options: import('../domain/types').RecoveryOptions = {}): Promise<RecoveryReport> {
        const total: RecoveryReport = {
            recoveredTasks: 0, recoveredEffects: 0, expiredAttempts: 0, rebuiltIndexes: 0,
        };
        if (options.takeover && (this.active || this.activeEffects || this.draining.size || !this.poller.isIdle))
            throw new Error('Takeover recovery requires an idle Kernel before opening sessions');
        const restored: Array<{ id: string; binding: ResolvedStorageBinding; stateMs: number }> = [];
        for (const id of new Set(sessionIds)) {
            const started = performance.now();
            const opened = await this.store.openSession(id);
            mergeReport(total, await this.store.recover(opened.binding, options, opened.record));
            restored.push({ id, binding: opened.binding, stateMs: performance.now() - started });
        }
        await this.managedResources.recover('kernel', options.takeover);
        for (const { id, stateMs } of restored) {
            const started = performance.now();
            await this.managedResources.recover(`session:${id}`, options.takeover);
            options.onSessionRecovered?.(id, { state: stateMs, resources: performance.now() - started });
        }
        for (const { id, binding } of restored) {
            this.rememberBinding(id, binding);
            this.schedulePoll(id);
        }
        return total;
    }

    async submit<I, O>(sessionId: string, spec: import('../domain/types').TaskSpec<I>, options?: import('../domain/types').LeaseGuardOptions): Promise<TaskHandle<O>> {
        const binding = await this.binding(sessionId);
        const task = await this.store.createTask(binding, sessionId, spec, options);
        this.notify(sessionId, task.id);
        this.queueDrain(sessionId);
        return new DefaultTaskHandle<O>(this, sessionId, task.id);
    }

    async retryTask<O = unknown>(sessionId: string, taskId: string, options: LeaseGuardOptions & { requestId: string }): Promise<TaskHandle<O>> {
        if (typeof options.requestId !== 'string' || !options.requestId.trim()) throw new Error('Manual retry requires requestId');
        const original = await this.task(sessionId, taskId);
        return this.submit(sessionId, {
            requestId: `retry:${JSON.stringify([taskId, options.requestId])}`,
            retryOfTaskId: taskId, program: original.program, input: original.input,
            dependsOn: original.dependencies, retry: original.retry, priority: original.priority,
            labels: original.labels, deferStart: true,
        }, options);
    }

    async task(sessionId: string, taskId: string): Promise<TaskRecord> {
        return this.store.readTask(await this.store.inspectSessionBinding(sessionId), taskId);
    }

    /** Retention/GC for Task version history; see `SeqFileKernelStore.compactTaskHistory`. */
    async compactTaskHistory(
        sessionId: string,
        taskId: string,
        options: { keepVersions?: number; beforeVersion?: number } = {},
    ): Promise<{ removed: number; keptFrom: number }> {
        return this.store.compactTaskHistory(await this.binding(sessionId), taskId, options);
    }

    async taskHistory(sessionId: string, taskId: string, afterVersion = -1): Promise<TaskRecord[]> {
        return this.store.taskHistory(await this.binding(sessionId), taskId, afterVersion);
    }

    async taskHistoryPage(sessionId: string, taskId: string, query: import('../domain/types').TaskHistoryQuery = {}): Promise<import('../domain/types').TaskHistoryPage> {
        return this.store.taskHistoryPage(await this.store.inspectSessionBinding(sessionId), taskId, query);
    }

    async taskAttempts(sessionId: string, taskId: string): Promise<import('../domain/types').TaskAttempt[]> {
        return this.store.taskAttempts(await this.binding(sessionId), taskId);
    }

    async signal(sessionId: string, taskId: string, signal: TaskSignal, options?: import('../domain/types').LeaseGuardOptions): Promise<void> {
        await this.store.signalTask(await this.binding(sessionId), taskId, signal, options);
        this.notify(sessionId, taskId);
        this.queueDrain(sessionId);
    }

    async controlTask(sessionId: string, taskId: string, mode: import('../domain/types').TaskControl['mode'],
        options: import('../domain/types').TaskControlOptions & { signal?: TaskSignal }): Promise<import('../domain/types').TaskControl> {
        const control = await this.store.controlTask(await this.binding(sessionId), taskId, mode, options);
        await this.abortFencedReducers(sessionId);
        this.notify(sessionId, taskId); this.queueDrain(sessionId);
        return control;
    }

    async startTask(sessionId: string, taskId: string, options?: import('../domain/types').TaskStartOptions): Promise<void> {
        await this.store.startTask(await this.binding(sessionId), taskId, options);
        this.notify(sessionId, taskId);
        this.queueDrain(sessionId);
    }

    async respondInteraction<T extends import('../domain/types').JsonValue>(
        sessionId: string,
        taskId: string,
        response: InteractionResponse<T>,
        options?: LeaseGuardOptions,
    ): Promise<void> {
        await this.store.resolveInteraction(await this.binding(sessionId), taskId, response, options);
        this.notify(sessionId, taskId);
        this.queueDrain(sessionId);
    }

    async cancel(sessionId: string, taskId: string, reason?: string, options?: LeaseGuardOptions): Promise<void> {
        const binding = await this.binding(sessionId);
        const current = await this.store.readTask(binding, taskId);
        const activeEffects = activeEffectIds(current);
        const task = await this.store.cancelTask(binding, taskId, reason, options);
        await this.abortFencedReducers(sessionId);
        this.notify(sessionId, taskId);
        this.queueDrain(sessionId);
        await this.cancelTaskEffects(task, activeEffects);
        const children = (await this.store.listTasks(binding))
            .filter(candidate => candidate.parentTaskId === taskId && !isTerminalStatus(candidate.status));
        for (const child of children) {
            await this.cancel(sessionId, child.id, reason ?? `Parent task ${taskId} cancelled`, options);
        }
    }

    async eventList(sessionId: string, after: number): Promise<EventEnvelope[]> {
        return this.store.events(await this.binding(sessionId), after);
    }

    /** Retention/GC for a Task's event log; see `SeqFileKernelStore.pruneTaskEvents`. */
    async pruneTaskEvents(
        sessionId: string,
        taskId: string,
        options: { keepEvents?: number } = {},
    ): Promise<{ removed: number; firstAvailableIndex: number }> {
        return this.store.pruneTaskEvents(await this.binding(sessionId), taskId, options);
    }

    async taskEventPage(sessionId: string, taskId: string, query: import('../domain/types').TaskEventQuery = {}): Promise<import('../domain/types').TaskEventPage> {
        return this.store.taskEventPage(await this.binding(sessionId), taskId, query);
    }

    async listSessionTaskPage(sessionId: string, query: import('../domain/types').TaskListQuery = {}): Promise<import('../domain/types').TaskListPage> {
        return this.store.listTaskPage(await this.binding(sessionId), query);
    }

    async getShared<T extends import('../domain/types').JsonValue>(sessionId: string, key: string): Promise<SharedStateEntry<T> | undefined> {
        return this.store.getShared<T>(await this.binding(sessionId), key);
    }

    async getSharedMany(
        sessionId: string, keys: string[],
    ): Promise<Record<string, SharedStateEntry<import('../domain/types').JsonValue> | undefined>> {
        return this.store.getSharedMany(await this.binding(sessionId), keys);
    }

    async setShared<T extends import('../domain/types').JsonValue>(
        sessionId: string, key: string, value: T, options?: SharedStateWriteOptions,
    ): Promise<SharedStateEntry<T>> {
        const entry = await this.store.setShared(await this.binding(sessionId), key, value, options);
        this.notify(sessionId, options?.taskId, 'content');
        return entry;
    }

    async deleteShared(sessionId: string, key: string, options?: SharedStateWriteOptions): Promise<boolean> {
        const deleted = await this.store.deleteShared(await this.binding(sessionId), key, options);
        if (deleted) this.notify(sessionId, options?.taskId, 'content');
        return deleted;
    }

    async listShared(sessionId: string, prefix?: string): Promise<SharedStateEntry[]> {
        return this.store.listShared(await this.binding(sessionId), prefix);
    }

    async sharedHistory<T extends import('../domain/types').JsonValue>(
        sessionId: string, key: string,
    ): Promise<SharedStateRevision<T>[]> {
        return this.store.sharedHistory<T>(await this.binding(sessionId), key);
    }

    async sendCrossSession<T extends import('../domain/types').JsonValue>(
        sourceSessionId: string,
        targetSessionId: string,
        topic: string,
        payload: T,
        options?: { expiresAt?: number },
    ): Promise<CrossSessionMessage<T>> {
        if (!topic) throw new Error('Cross-session message topic is required');
        if (options?.expiresAt !== undefined && !Number.isFinite(options.expiresAt)) throw new Error('Invalid message deadline');
        const message: CrossSessionMessage<T> = {
            id: createId('message'), sourceSessionId, targetSessionId, topic, payload,
            status: 'pending', createdAt: Date.now(), expiresAt: options?.expiresAt,
        };
        const source = await this.binding(sourceSessionId);
        await this.store.createOutboxMessage(source, message);
        try { return await this.relayMessage(source, message) as CrossSessionMessage<T>; }
        catch { return message; }
    }

    async outbox(sessionId: string): Promise<CrossSessionMessage[]> {
        return this.store.outbox(await this.binding(sessionId));
    }

    async inbox(sessionId: string, after = 0): Promise<CrossSessionMessage[]> {
        return this.store.inbox(await this.binding(sessionId), after);
    }

    async commitContext<T extends import('../domain/types').JsonValue>(
        sessionId: string, delta: T, options: ContextCommitOptions = {},
    ): Promise<ContextCommit<T>> {
        const commit: ContextCommit<T> = {
            id: createId('context'), sessionId, parentIds: [], delta,
            authorTaskId: options.taskId, createdAt: Date.now(),
        };
        const result = await this.store.commitContext(await this.binding(sessionId), commit, options);
        this.notify(sessionId, options.taskId, 'content');
        return result;
    }

    async getContextCommit<T extends import('../domain/types').JsonValue>(sessionId: string, id: string): Promise<ContextCommit<T> | undefined> {
        return this.store.getContextCommit<T>(await this.binding(sessionId), id);
    }

    async getContextBranch(sessionId: string, name = 'main'): Promise<ContextBranch> {
        return this.store.getContextBranch(await this.binding(sessionId), name);
    }

    async contextHistory(sessionId: string, head?: string): Promise<ContextCommit[]> {
        return this.store.contextHistory(await this.binding(sessionId), head);
    }

    async createResource(sessionId: string, spec: ResourceSpec, options?: LeaseGuardOptions): Promise<ResourceGrant> {
        if (spec.requestId !== undefined && (typeof spec.requestId !== 'string' || !spec.requestId.trim())) throw new Error('Invalid resource requestId');
        const resource: ResourceRecord = {
            id: createId('resource'), sessionId, kind: spec.kind, uri: spec.uri,
            generation: 1, parentResourceId: spec.parentResourceId,
            metadata: spec.metadata, createdAt: Date.now(),
        };
        const handle: ResourceHandle = {
            id: createId('handle'), resourceId: resource.id, holderTaskId: spec.ownerTaskId,
            rights: spec.rights ?? ['read', 'write', 'execute', 'grant', 'admin'], generation: 1,
        };
        return this.store.createResource(await this.binding(sessionId), resource, handle, spec.parentHandleId,
            spec.requestId === undefined ? undefined : { id: spec.requestId, fingerprint: JSON.stringify({
                kind: spec.kind, uri: spec.uri, rights: handle.rights, parentResourceId: spec.parentResourceId,
                parentHandleId: spec.parentHandleId, metadata: spec.metadata,
            }) }, options);
    }

    async grantResource(
        sessionId: string, parentHandleId: string, holderTaskId: string, rights: ResourceRight[],
    ): Promise<ResourceHandle> {
        return this.store.grantResource(
            await this.binding(sessionId), createId('handle'), parentHandleId, holderTaskId, rights,
        );
    }

    async revokeResource(sessionId: string, handleId: string): Promise<number> {
        return this.store.revokeResource(await this.binding(sessionId), handleId);
    }

    async authorizeResource(
        sessionId: string, handleId: string, right: ResourceRight, holderTaskId?: string,
    ): Promise<ResourceRecord> {
        return this.store.authorizeResource(await this.binding(sessionId), handleId, right, holderTaskId);
    }

    async setBudget(
        sessionId: string, handleId: string, dimension: string, hardLimit: number,
        expectedVersion?: number | null, options?: LeaseGuardOptions,
    ): Promise<BudgetAccount> {
        return this.store.setBudget(
            await this.binding(sessionId), handleId, dimension, hardLimit, expectedVersion, options,
        );
    }

    async chargeBudget(
        sessionId: string, handleId: string, dimension: string, amount: number,
        options: { usageId?: string } = {},
    ): Promise<BudgetAccount[]> {
        return this.store.chargeBudget(await this.binding(sessionId), handleId, dimension, amount, undefined, options);
    }

    async snapshotWorkspace(
        sessionId: string,
        handleId: string,
        adapterRef: import('../domain/types').ProgramRef,
    ): Promise<WorkspaceSnapshot> {
        const binding = await this.binding(sessionId);
        const resource = await this.store.authorizeResource(binding, handleId, 'read');
        assertWorkspace(resource);
        const adapter = this.workspaces.resolve(adapterRef.kind, adapterRef.version);
        const payload = await adapter.snapshot(resource.uri, workspaceContext(sessionId, resource));
        const snapshot = workspaceSnapshot(sessionId, resource.id, adapterRef, payload);
        return this.store.saveWorkspaceSnapshot(binding, snapshot);
    }

    async diffWorkspace(
        sessionId: string,
        handleId: string,
        baseId: string,
        targetId: string,
    ): Promise<WorkspaceDiff> {
        const binding = await this.binding(sessionId);
        const resource = await this.store.authorizeResource(binding, handleId, 'read');
        const [base, target] = await readWorkspaceSnapshots(this.store, binding, [baseId, targetId]);
        assertWorkspaceSnapshots(resource, base, target);
        const adapter = this.workspaces.resolve(base.adapter.kind, base.adapter.version);
        const payload = await adapter.diff(base.payload, target.payload, workspaceContext(sessionId, resource));
        const diff: WorkspaceDiff = {
            id: createId('workspace-diff'), sessionId, resourceId: resource.id,
            adapter: base.adapter, baseSnapshotId: base.id, targetSnapshotId: target.id,
            payload, createdAt: Date.now(),
        };
        return this.store.saveWorkspaceDiff(binding, diff);
    }

    async mergeWorkspace(
        sessionId: string,
        handleId: string,
        baseId: string,
        leftId: string,
        rightId: string,
    ): Promise<WorkspaceMergeResult> {
        const binding = await this.binding(sessionId);
        const resource = await this.store.authorizeResource(binding, handleId, 'write');
        const [base, left, right] = await readWorkspaceSnapshots(this.store, binding, [baseId, leftId, rightId]);
        assertWorkspaceSnapshots(resource, base, left, right);
        const adapter = this.workspaces.resolve(base.adapter.kind, base.adapter.version);
        const result = await adapter.merge(base.payload, left.payload, right.payload,
            workspaceContext(sessionId, resource));
        const snapshot = workspaceSnapshot(sessionId, resource.id, base.adapter, result.payload, [left.id, right.id]);
        return { snapshot: await this.store.saveWorkspaceSnapshot(binding, snapshot), conflicts: result.conflicts ?? [] };
    }

    /**
     * Retention/GC entry point for settled Session messages. `before` is a wall-clock
     * watermark owned by the host; it must stay older than the deployment's replay window.
     */
    async pruneSessionMessages(sessionId: string, before: number, limit?: number): Promise<{ outbox: number; inbox: number }> {
        return this.store.pruneMessages(await this.binding(sessionId), before, limit);
    }

    async relayPendingMessages(): Promise<number> {
        let delivered = 0;
        for (const session of await this.store.listSessions()) {
            const source = await this.binding(session.id);
            for (const message of await this.store.pendingOutbox(source)) {
                try { if ((await this.relayMessage(source, message)).status === 'delivered') delivered++; } catch { /* Retry on recovery. */ }
            }
        }
        return delivered;
    }

    /** Retry settlement acknowledgement without ever re-delivering a terminal outbox record. */
    private async acknowledgeMessage(source: ResolvedStorageBinding, message: CrossSessionMessage): Promise<CrossSessionMessage> {
        if (message.settlementAcknowledgedAt !== undefined || message.sourceSessionId === message.targetSessionId) return message;
        try {
            const target = await this.binding(message.targetSessionId);
            await this.store.acknowledgeMessageSettlement(target, message, 'inbox');
            return (await this.store.acknowledgeMessageSettlement(source, message, 'outbox'))!;
        } catch (error) {
            await this.store.recordMessageRetry(source, message.id, error);
            throw error;
        }
    }

    private async relayMessage(
        source: ResolvedStorageBinding,
        message: CrossSessionMessage,
    ): Promise<CrossSessionMessage> {
        if (message.status !== 'pending') return this.acknowledgeMessage(source, message);
        let receipt: CrossSessionMessage;
        try {
            const target = await this.binding(message.targetSessionId);
            await this.store.deliverMessage(target, message);
            receipt = await this.store.messageReceipt(target, message.id);
        } catch (error) {
            // A missing target may still be created later. The caller can bound retries.
            if (message.expiresAt !== undefined && message.expiresAt <= Date.now()
                && error instanceof Error && 'code' in error && error.code === 'SESSION_NOT_FOUND') {
                receipt = { ...message, status: 'rejected', rejectedAt: Date.now(), settlementAcknowledgedAt: Date.now(),
                    rejection: { code: 'expired', message: 'Message delivery deadline expired' } };
            } else {
                await this.store.recordMessageRetry(source, message.id, error);
                throw error;
            }
        }
        const delivered = await this.store.markMessageDelivered(source, message.id, receipt);
        this.notify(message.targetSessionId);
        this.notify(message.sourceSessionId);
        return this.acknowledgeMessage(source, delivered);
    }

    async setSessionStatus(sessionId: string, status: SessionRecord['status']): Promise<void> {
        await this.store.setSessionStatus(await this.binding(sessionId), status);
        await this.abortFencedReducers(sessionId);
        this.notify(sessionId);
        if (status === 'open') { this.queueDrain(sessionId); this.schedulePoll(sessionId); }
    }

    async closeSession(sessionId: string, cancelRunning: boolean): Promise<void> {
        let binding: ResolvedStorageBinding;
        try {
            binding = await this.binding(sessionId);
        } catch (error) {
            if (isMissingStorage(error)) return;
            throw error;
        }
        // Closing is idempotent: a Session whose storage an interrupted removal
        // already deleted has nothing to close, and its stale record must not
        // block the cleanup that follows.
        if (!await binding.fs.driver.exists(binding.rootPath)) return;
        const closing = await this.store.setSessionStatus(binding, 'closing', cancelRunning ? 'cancel' : 'drain');
        if (closing.status === 'closed' || closing.status === 'archived') return;
        if (cancelRunning) {
            const tasks = await this.store.listTasks(binding);
            for (const task of tasks) {
                if (!isTerminalStatus(task.status)) await this.cancel(sessionId, task.id, 'Session closed');
            }
        }
        await this.finishSessionClose(sessionId, binding);
        this.queueDrain(sessionId); this.schedulePoll(sessionId);
    }

    /**
     * Delete a Session's Kernel storage and catalog record. Refuses while Tasks are
     * live or resource cleanup is pending, so a failed close never destroys state;
     * the host must close the Session first and keep its own records until this
     * resolves.
     */
    async removeSession(sessionId: SessionId, options: { force?: boolean } = {}): Promise<boolean> {
        let binding: ResolvedStorageBinding;
        try {
            // Resolve straight from the catalog: openSession() requires the main
            // record file, which an interrupted removal may already have deleted.
            binding = await this.store.inspectSessionBinding(sessionId);
        } catch (error) {
            if (isMissingStorage(error)) return false;
            throw error;
        }
        const tasks = await this.store.listTasks(binding);
        const busy = tasks.some(task => !isTerminalStatus(task.status)
            || Object.values(task.effects).some(effect => effect.cleanupPending));
        if (busy && !options.force) {
            throw kernelError(KernelErrorCode.CONFLICT, `Session ${sessionId} still has running Tasks or pending resource cleanup`);
        }
        this.stopPoll(sessionId);
        this.resourcePoller.stop(`session:${sessionId}`);
        await this.abortFencedReducers(sessionId);
        await Promise.all([...this.plugins.values()].map(plugin => plugin.onSessionClosed?.(sessionId)));
        await this.store.removeSession(sessionId, binding);
        this.storageListeners.get(sessionId)?.();
        this.storageListeners.delete(sessionId);
        this.sessions.delete(sessionId);
        this.notify(sessionId);
        return true;
    }

    private readonly sessionClosures = new Map<string, Promise<void>>();

    private async finishSessionClose(sessionId: string, binding: ResolvedStorageBinding): Promise<void> {
        const pending = this.sessionClosures.get(sessionId);
        if (pending) return pending;
        const work = this.completeSessionClose(sessionId, binding);
        this.sessionClosures.set(sessionId, work);
        try { await work; }
        finally { if (this.sessionClosures.get(sessionId) === work) this.sessionClosures.delete(sessionId); }
    }

    private async completeSessionClose(sessionId: string, binding: ResolvedStorageBinding): Promise<void> {
        if ((await this.store.sessionRecord(binding)).status !== 'closing') return;
        const tasks = await this.store.listTasks(binding);
        if (tasks.some(t => !isTerminalStatus(t.status) || Object.values(t.effects).some(e => e.cleanupPending))) return;
        if (!await this.managedResources.canClose(sessionId)) return;
        if ((await this.store.pendingOutbox(binding)).length) return;
        await this.store.setSessionStatus(binding, 'closed');
        this.stopPoll(sessionId);
        await Promise.all([...this.plugins.values()].map(plugin => plugin.onSessionClosed?.(sessionId)));
        this.notify(sessionId);
    }

    onChanged(listener: (event: KernelEvents['changed']) => void): () => void {
        return this.eventsBus.on('changed', listener);
    }

    private async resolveStorage(reference: StorageBindingRef): Promise<ResolvedStorageBinding> {
        return this.storageResolvers.resolve(reference.kind).resolve(reference);
    }

    private rememberBinding(sessionId: string, binding: ResolvedStorageBinding): void {
        const previous = this.sessions.get(sessionId);
        if (previous?.fs === binding.fs && previous.rootPath === binding.rootPath) return;
        this.storageListeners.get(sessionId)?.();
        this.sessions.set(sessionId, binding);
        this.resourcePoller.start(`session:${sessionId}`);
        const root = pathUtils.normalize(binding.rootPath);
        // Session-scope managed resources live in one seq file. Restarting the resource sweep on
        // *any* Session commit made every Task/Effect record write re-read that file (and open a
        // transaction) although nothing about resources had changed.
        const resources = pathUtils.normalize(resourcesPath(root));
        const log = pathUtils.normalize(eventsPath(root));
        this.storageListeners.set(sessionId, binding.fs.on('seq:committed', event => {
            const changed = event.payload.paths.filter(path => pathUtils.isUnder(path, root));
            if (this.disposed || !changed.length) return;
            // Event appends wake observers without invalidating task and Session listings.
            const reason = changed.every(path => pathUtils.normalize(path) === log) ? 'content' : 'structure';
            this.notify(sessionId, undefined, reason);
            this.queueDrain(sessionId);
            if (event.payload.paths.some(path => pathUtils.normalize(path) === resources)) this.resourcePoller.start(`session:${sessionId}`);
            for (const id of this.sessions.keys()) this.schedulePoll(id);
        }));
    }

    private async binding(sessionId: string): Promise<ResolvedStorageBinding> {
        const cached = this.sessions.get(sessionId);
        if (cached) return cached;
        const opened = await this.store.openSession(sessionId);
        this.rememberBinding(sessionId, opened.binding);
        return opened.binding;
    }

    private queueDrain(sessionId: string): void {
        if (this.disposed) return;
        if (this.draining.has(sessionId)) { this.requestedDrains.add(sessionId); return; }
        this.draining.add(sessionId);
        queueMicrotask(() => void this.drain(sessionId).catch(error => { if (!this.disposed) this.handlePollError(error); }));
    }

    private schedulePoll(sessionId: string): void {
        this.tickTasks.delete(sessionId);
        this.poller.start(sessionId);
    }

    private stopPoll(sessionId: string): void { this.tickTasks.delete(sessionId); this.poller.stop(sessionId); }

    private async poll(sessionId: string): Promise<boolean> {
        // After recovery, share one task scan with effect dispatch and wake calculation.
        // Recovery retains its own fresh transactional reads and ownership checks.
        this.tickTasks.delete(sessionId);
        // Both sweeps already compute their next deadline; keep them for nextWakeDelay so an
        // idle tick does not open two more transactions to read the same rows again.
        this.tickManaged.set(sessionId, {
            kernel: await this.managedResources.sweep('kernel'),
            session: await this.managedResources.sweep(`session:${sessionId}`),
        });
        const binding = await this.binding(sessionId);
        const session = await this.store.sessionRecord(binding);
        const status = session.status;
        const sweepMarker: TaskRecord[] = [];
        this.tickTasks.set(sessionId, sweepMarker);
        const sweptTasks = await this.store.sweep(binding);
        await this.abortFencedReducers(sessionId);
        const dueMessages = await this.store.pendingOutbox(binding, Date.now());
        for (const message of dueMessages) {
            try { await this.relayMessage(binding, message); } catch { /* Persisted outbox is retried by polling. */ }
        }
        const reuseSweep = sweptTasks && !dueMessages.length && this.tickTasks.get(sessionId) === sweepMarker;
        // Install before a fallback read so concurrent commits invalidate that snapshot too.
        const snapshot = reuseSweep ? sweepMarker : [];
        if (!reuseSweep) this.tickTasks.set(sessionId, snapshot);
        const tasks = reuseSweep ? sweptTasks : await this.store.listTasks(binding);
        if (this.tickTasks.get(sessionId) === snapshot) this.tickTasks.set(sessionId, tasks);
        // Any write below makes the snapshot stale for nextWakeDelay(); the common idle
        // tick mutates nothing and reuses it, a mutating tick re-reads instead.
        let mutated = false;
        for (const task of tasks) {
            if (task.blockedReason === 'program-unavailable' && this.programs.has(task.program.kind, task.program.version)) {
                await this.store.unblockProgram(binding, task.id);
                mutated = true;
            }
            if (session.status === 'closing' && session.closeMode === 'cancel' && !isTerminalStatus(task.status)) {
                await this.store.cancelTask(binding, task.id, 'Session closed');
                mutated = true;
            }
            const pending = new Set(Object.entries(task.effects).filter(([, e]) => e.cleanupPending).map(([id]) => id));
            if (pending.size) {
                mutated = true;
                try { await this.cancelTaskEffects(task, pending); } catch { /* Cleanup intent remains durable. */ }
            }
        }
        if (status === 'open' || (status === 'closing' && session.closeMode === 'drain')) {
            this.queueDrain(sessionId);
            if (await this.dispatchPendingEffects(binding, tasks)) mutated = true;
        }
        if (status === 'suspending' && !tasks.some(task => Object.values(task.effects).some(e => e.status === 'leased' || e.status === 'indeterminate'))) {
            await this.store.setSessionStatus(binding, 'suspended'); this.notify(sessionId);
        }
        if (status === 'closing') await this.finishSessionClose(sessionId, binding);
        const latest = (await this.store.sessionRecord(binding)).status;
        const again = latest !== 'closed' && latest !== 'archived';
        // The poller only asks for a delay while it will keep polling; do not keep a
        // snapshot alive for a Session that just stopped, and drop a stale one.
        if (!again || mutated) this.tickTasks.delete(sessionId);
        return again;
    }

    private async nextWakeDelay(sessionId: string): Promise<number | undefined> {
        const binding = await this.binding(sessionId), now = Date.now();
        // Reuse the list poll() just read for this Session; it is the same tick.
        const cached = this.tickTasks.get(sessionId);
        this.tickTasks.delete(sessionId);
        let at = Infinity;
        const future = (value?: number) => { if (value !== undefined && value > now) at = Math.min(at, value); };
        const visit = (wait: import('../domain/types').WaitSpec, task: TaskRecord) => {
            if (wait.type === 'timer') {
                if (!task.pendingEvents.some(e => e.type === 'timer-fired' && e.id === wait.id)) at = Math.min(at, wait.at);
            } else if ('waits' in wait) for (const child of wait.waits) visit(child, task);
        };
        for (const task of cached ?? await this.store.listTasks(binding)) {
            if (task.status === 'waiting' && task.wait) visit(task.wait, task);
            if (task.status === 'ready') future(task.readyAt);
            if (task.status === 'running' && task.currentAttempt) at = Math.min(at, task.currentAttempt.leaseUntil);
            for (const effect of Object.values(task.effects)) {
                if (effect.status === 'leased' && effect.currentAttempt) at = Math.min(at, effect.currentAttempt.leaseUntil);
                if (effect.status === 'pending') future(effect.readyAt);
                if (effect.cleanupPending) at = Math.min(at, now + 1000);
            }
        }
        for (const message of await this.store.pendingOutbox(binding)) {
            at = Math.min(at, message.nextAttemptAt ?? now);
            if (message.expiresAt !== undefined) at = Math.min(at, message.expiresAt);
        }
        const swept = this.tickManaged.get(sessionId);
        this.tickManaged.delete(sessionId);
        if (swept) {
            if (swept.kernel !== undefined) at = Math.min(at, swept.kernel);
            if (swept.session !== undefined) at = Math.min(at, swept.session);
        } else for (const scope of ['kernel', `session:${sessionId}`]) {
            const deadline = await this.managedResources.nextDeadline(scope);
            if (deadline !== undefined) at = Math.min(at, deadline);
        }
        return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
    }

    private handlePollError(error: unknown): boolean {
        // A removed Session can still have an in-flight poll tick; that is not an error.
        if (isMissingPath(error) || isMissingStorage(error)) return false;
        console.error('Kernel poll failed', error);
        return true;
    }

    private async drain(sessionId: string): Promise<void> {
        try {
            const binding = await this.binding(sessionId);
            const session = await this.store.sessionRecord(binding);
            if (session.status !== 'open' && !(session.status === 'closing' && session.closeMode === 'drain')) return;
            while (this.active < this.maxConcurrent) {
                const claim = await this.store.claimReady(binding, this.workerId, this.leaseMs);
                if (!claim) break;
                this.active++;
                void this.execute(binding, claim).finally(() => {
                    this.active--;
                    for (const id of this.sessions.keys()) this.queueDrain(id);
                });
            }
        } finally {
            this.draining.delete(sessionId);
            if (this.requestedDrains.delete(sessionId)) this.queueDrain(sessionId);
        }
    }

    private async abortFencedReducers(sessionId: string): Promise<void> {
        for (const [token, active] of this.reducerControllers) {
            if (active.sessionId !== sessionId) continue;
            const task = await this.store.readTask(await this.binding(sessionId), active.taskId);
            if (task.currentAttempt?.leaseToken !== token) active.controller.abort(new Error('Reducer claim invalidated'));
        }
    }

    private async execute(binding: ResolvedStorageBinding, claim: TaskClaim): Promise<void> {
        const controller = new AbortController();
        this.reducerControllers.set(claim.attempt.leaseToken, { sessionId: claim.task.sessionId, taskId: claim.task.id, controller });
        const stopHeartbeat = this.startLeaseHeartbeat(binding, claim, controller);
        try {
            if (!this.programs.has(claim.task.program.kind, claim.task.program.version)) {
                await this.store.blockUnavailableProgram(binding, claim); return;
            }
            const program = this.programs.resolve(claim.task.program.kind, claim.task.program.version);
            const interrupted = new Promise<never>((_, reject) => {
                controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
            });
            const decision = await Promise.race([nextDecision(program, claim.task), interrupted]);
            if (this.disposed) return;
            const next = await this.applyDecision(binding, claim, decision);
            this.notify(next.sessionId, next.id);
            if (next.status === 'ready') this.queueDrain(next.sessionId);
        } catch (error) {
            if (this.disposed || controller.signal.aborted) return;
            const failed = failureDecision(claim.task.state, error);
            try {
                const next = await this.applyDecision(binding, claim, failed);
                if (next.status === 'ready') this.queueDrain(next.sessionId);
            } catch { /* A newer lease owns the task. */ }
            this.notify(claim.task.sessionId, claim.task.id);
        } finally {
            stopHeartbeat();
            this.reducerControllers.delete(claim.attempt.leaseToken);
        }
    }

    private startLeaseHeartbeat(binding: ResolvedStorageBinding, claim: TaskClaim, controller: AbortController): () => void {
        const heartbeat = new LeaseHeartbeat({
            intervalMs: Math.min(2147483647, Math.max(1, Math.floor(this.leaseMs / 3))),
            renew: async () => {
                const valid = !this.disposed && await this.store.renewLease(binding, claim, this.leaseMs);
                if (!valid) controller.abort(new Error('Reducer lease lost'));
                return valid;
            },
            onError: error => console.error('Kernel lease heartbeat failed', error),
        });
        const stop = (): void => {
            heartbeat.stop();
            this.heartbeats.delete(heartbeat);
        };
        this.heartbeats.add(heartbeat);
        heartbeat.start();
        return stop;
    }

    private async applyDecision(
        binding: ResolvedStorageBinding,
        claim: TaskClaim,
        decision: Decision,
    ): Promise<TaskRecord> {
        validateDecision(decision);
        const retrying = shouldRetry(claim.task, decision);
        const pendingEvents = !(claim.task.initialized ?? claim.task.state !== undefined) || retrying
            ? claim.task.pendingEvents
            : claim.task.pendingEvents.slice(1);
        const state = retrying ? claim.task.state : decision.state;
        let next: TaskRecord = { ...claim.task, state, pendingEvents,
            initialized: retrying ? claim.task.initialized : true };
        const actions = decision.next.type === 'fail' ? [] : decision.actions ?? [];
        for (const action of actions) {
            if (action.type === 'request-interaction') next = addInteraction(next, action.interaction);
        }
        const spawns = prepareSpawns(actions);
        await Promise.all(spawns.map(spawn => this.store.prepareTaskDirectory(binding, spawn.id)));
        const effects = actions.filter(action => action.type === 'effect')
            .map(action => normalizeEffect(action.effect));
        for (const effect of effects) next = addEffect(next, effect);
        next = transition(next, decision);
        const sideEffects = decisionSideEffects(actions, spawns);
        sideEffects.resources = await Promise.all(actions.filter(action => action.type === 'resource')
            .map(action => this.managedResources.prepare({ sessionId: claim.task.sessionId, taskId: claim.task.id }, action.command)));
        if (retrying) sideEffects.attemptOutcome = 'failed';
        const eventType = retrying ? 'task.retry.scheduled' : `task.${next.status}`;
        const payload = retrying ? { error: next.lastError, readyAt: next.readyAt } : undefined;
        const committed = await this.store.commitTask(binding, claim, next, eventType, payload, sideEffects);
        for (const effect of effects) void this.dispatchEffect(binding, committed, effect.id).catch(error => this.handlePollError(error));
        if (decision.next.type === 'continue' || spawns.length > 0) this.queueDrain(next.sessionId);
        return committed;
    }

    /** Candidates may start asynchronously; invalidate the snapshot whenever dispatch is attempted. */
    private async dispatchPendingEffects(binding: ResolvedStorageBinding, tasks?: TaskRecord[]): Promise<boolean> {
        const pending = await this.store.pendingEffects(binding, tasks);
        for (const item of pending) {
            void this.dispatchEffect(binding, item.task, item.effectId).catch(error => this.handlePollError(error));
        }
        return pending.length > 0;
    }

    private async dispatchEffect(
        binding: ResolvedStorageBinding,
        task: TaskRecord,
        effectId: string,
    ): Promise<void> {
        const requested = task.effects[effectId]?.request;
        if (!requested || !this.effects.has(requested.kind, requested.version)) return;
        if (this.disposed || this.activeEffects >= this.maxConcurrentEffects) return;
        this.activeEffects++;
        try {
            const claim = await this.store.claimEffect(binding, task.id, effectId, this.workerId, this.leaseMs);
            if (claim) await this.executeEffect(binding, task, claim);
        } finally { this.activeEffects--; for (const id of this.sessions.keys()) this.schedulePoll(id); }
    }

    private async executeEffect(
        binding: ResolvedStorageBinding,
        task: TaskRecord,
        claim: EffectClaim,
    ): Promise<void> {
        const effect = claim.effect.request as RequiredEffect;
        const controller = new AbortController();
        const controllerKey = effectControllerKey(task.sessionId, task.id, effect.id);
        this.effectControllers.set(controllerKey, controller);
        const stopHeartbeat = this.startEffectHeartbeat(binding, claim, controller);
        try {
            const grants: import('../domain/types').AuthorizedEffectGrant[] = [];
            for (const grant of effect.grants ?? []) {
                const resource = await this.store.authorizeResource(
                    binding, grant.handleId, grant.right, task.id,
                );
                grants.push({ ...grant, resource });
            }
            const adapter = this.effects.resolve(effect.kind, effect.version);
            const context = {
                sessionId: task.sessionId, taskId: task.id, effectId: effect.id, idempotencyKey: effect.idempotencyKey,
                abortSignal: controller.signal, grants,
                sessionState: {
                    get: <T extends import('../domain/types').JsonValue>(key: string) =>
                        this.store.getShared<T>(binding, key),
                    set: <T extends import('../domain/types').JsonValue>(
                        key: string, value: T, expectedVersion?: number | null,
                    ) => this.store.setShared(binding, key, value, {
                        taskId: task.id, expectedVersion,
                    }, claim),
                },
                emit: async (event: { type: string; payload?: unknown }): Promise<void> => {
                    if (this.disposed) return;
                    await this.store.appendEvent(binding, task.sessionId, task.id, event.type, event.payload, claim);
                    this.notify(task.sessionId, task.id, 'content');
                },
                // Effect-driven charges default to one settlement per logical Effect, so a
                // retried attempt after a crash cannot charge the same tokens twice.
                chargeBudget: (handleId: string, dimension: string, amount: number, options?: { usageId?: string }) =>
                    this.store.chargeBudget(binding, handleId, dimension, amount, claim,
                        { usageId: options?.usageId ?? `effect:${[task.id, effect.id, handleId, dimension].map(encodeURIComponent).join(':')}` }),
            };
            const result = await executeEffectWithDeadline(adapter, effect, claim, context, controller);
            if ('result' in result) assertDurableValue(result.result, 'Effect result');
            await this.store.completeEffect(
                binding, task.id, effect.id, claim.effect.currentAttempt!.leaseToken, result,
            );
        } catch (error) {
            if (this.disposed) return;
            try {
                await this.store.completeEffect(binding, task.id, effect.id,
                    claim.effect.currentAttempt!.leaseToken, { ...effectFailure(error),
                        retryable: !controller.signal.aborted && (this.effects.resolve(effect.kind, effect.version).shouldRetry?.(error,
                            { sessionId: task.sessionId, taskId: task.id, effectId: effect.id, idempotencyKey: effect.idempotencyKey, abortSignal: controller.signal, grants: [] })
                            ?? this.effects.resolve(effect.kind, effect.version).recoveryPolicy === 'idempotent-retry') });
            } catch { /* Effect lease was recovered by another worker. */ }
        } finally {
            stopHeartbeat();
            this.effectControllers.delete(controllerKey);
            this.notify(task.sessionId, task.id);
            this.queueDrain(task.sessionId);
        }
    }

    private async cancelTaskEffects(task: TaskRecord, active: Set<string>): Promise<void> {
        const effects = Object.entries(task.effects)
            .filter(([id, effect]) => active.has(id) && effect.status === 'cancelled')
            .map(([, effect]) => effect);
        const results = await Promise.allSettled(effects.map(async effect => {
            await this.effectCleanup.run(effectControllerKey(task.sessionId, task.id, effect.request.id!),
                () => this.cancelEffect(task, effect.request));
            await this.store.confirmEffectCleanup(await this.binding(task.sessionId), task.id, effect.request.id!);
        }));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length > 0) throw new AggregateError(errors, `Failed to cancel effects for task ${task.id}`);
    }

    private async cancelEffect(task: TaskRecord, effect: EffectRequest): Promise<void> {
        if (!effect.id) return;
        const key = effectControllerKey(task.sessionId, task.id, effect.id);
        const controller = this.effectControllers.get(key);
        controller?.abort();
        const adapter = this.effects.resolve(effect.kind, effect.version);
        if (!adapter.cancel) {
            if ((task.effects[effect.id]?.attemptCount ?? 0) > 0) throw new Error(`Effect cleanup requires adapter confirmation: ${effect.id}`);
            return;
        }
        await adapter.cancel(effect.request, {
            sessionId: task.sessionId, taskId: task.id, effectId: effect.id,
            abortSignal: controller?.signal ?? AbortSignal.abort(),
            grants: [],
            // Cancel path has no storage binding; effect adapters must not emit.
            emit: async () => {},
        });
    }

    private startEffectHeartbeat(binding: ResolvedStorageBinding, claim: EffectClaim, controller: AbortController): () => void {
        const heartbeat = new LeaseHeartbeat({
            intervalMs: Math.min(2147483647, Math.max(1, Math.floor(this.leaseMs / 3))),
            renew: async () => {
                const valid = !this.disposed && await this.store.renewEffectLease(binding, claim, this.leaseMs);
                if (!valid) controller.abort(new Error('Effect lease lost'));
                return valid;
            },
            onError: error => console.error('Kernel effect heartbeat failed', error),
        });
        const stop = (): void => { heartbeat.stop(); this.heartbeats.delete(heartbeat); };
        this.heartbeats.add(heartbeat);
        heartbeat.start();
        return stop;
    }

    private notify(sessionId: string, taskId?: string, reason: KernelChangeReason = 'structure'): void {
        this.tickTasks.delete(sessionId);
        this.eventsBus.emit('changed', { sessionId, taskId, reason });
    }
}

/**
 * True when a Session has no Kernel storage left: the catalog entry is gone or
 * the storage root was deleted by an interrupted removal. Callers must stay
 * usable in that state so cleanup can be resumed after a restart.
 */
function isMissingStorage(error: unknown): boolean {
    return (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND)
        || (error instanceof FSError && error.code === 'ENOENT');
}
