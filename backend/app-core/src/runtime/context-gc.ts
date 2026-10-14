import { createContextGc, scheduleContextGc, validateContextGcSchedule, type ContextGcOptions, type ContextGcPolicy,
    type ContextGcResult, type ContextGcScheduleOptions } from '@itookit/llm-context';
import { createTaskContextStorage } from '@itookit/kernel-adapters';
import { KernelError, KernelErrorCode } from '@itookit/durable-kernel';
import type { Kernel, ResolvedStorageBinding, StorageBindingRef, TaskListQuery } from '@itookit/durable-kernel';

export interface RuntimeContextGcOptions extends ContextGcScheduleOptions {
    policy?: ContextGcPolicy;
    maxTasksPerPass?: number;
    canCollectSession?: (sessionId: string) => boolean | Promise<boolean>;
    onResult?: (result: RuntimeContextGcResult) => void;
}
export type RuntimeContextGcResult = ContextGcResult & { sessionId: string; taskId: string };
interface Scope { binding: ResolvedStorageBinding; cursor: TaskListQuery }
export type RuntimeContextGc = ReturnType<typeof createRuntimeContextGc>;

export function createRuntimeContextGc(kernel: () => Kernel, options: RuntimeContextGcOptions = {}) {
    return new ContextMaintenance(kernel, options);
}

class ContextMaintenance {
    private readonly sessions = new Map<string, Scope>();
    private readonly maxTasks: number;
    private offset = 0;
    private stopped = false;
    private active?: Promise<RuntimeContextGcResult[]>;
    private scheduler?: ReturnType<typeof scheduleContextGc>;
    private results: RuntimeContextGcResult[] = [];
    get lastResults(): readonly RuntimeContextGcResult[] { return this.results; }

    constructor(private kernel: () => Kernel, private options: RuntimeContextGcOptions) {
        this.maxTasks = options.maxTasksPerPass ?? 32;
        if (!Number.isSafeInteger(this.maxTasks) || this.maxTasks < 1 || this.maxTasks > 500) throw new Error('Invalid context GC task budget');
        createContextGc({ exclusive: async () => null }, options.policy);
        validateContextGcSchedule(options);
    }

    observe = (sessionId: string, binding: ResolvedStorageBinding): void => {
        if (this.stopped) return;
        if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { binding, cursor: {} });
        this.scheduler ??= scheduleContextGc(async () => { await this.collect(); }, this.options);
    };

    /**
     * Called only after the host acquires write ownership or authorizes recovery.
     *
     * `storage` is the catalog binding reference when the caller already holds the Session
     * record (recovery scans do); otherwise exactly that one Session is inspected, so
     * observing N Sessions never enumerates the catalog N times.
     */
    async observeSession(sessionId: string, storage?: StorageBindingRef): Promise<void> {
        const reference = storage ?? await this.bindingReference(sessionId);
        if (!reference) return;
        this.observe(sessionId, await this.kernel().storageResolvers.resolve(reference.kind).resolve(reference));
    }

    /** A Session without a catalog record cannot be observed; removal may have interrupted it. */
    private async bindingReference(sessionId: string): Promise<StorageBindingRef | undefined> {
        try { return (await this.kernel().inspectSession(sessionId)).storage; }
        catch (error) {
            if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return undefined;
            throw error;
        }
    }

    collect = (settings: ContextGcOptions = {}): Promise<RuntimeContextGcResult[]> => {
        if (this.stopped) return Promise.resolve([]);
        return this.active ??= this.pass(settings).then(results => this.results = results)
            .finally(() => { this.active = undefined; });
    };

    private async pass(settings: ContextGcOptions): Promise<RuntimeContextGcResult[]> {
        const scopes = [...this.sessions];
        const results: RuntimeContextGcResult[] = [];
        let visited = 0;
        while (visited < Math.min(scopes.length, 8) && results.length < this.maxTasks && !this.stopped) {
            const [id, scope] = scopes[(this.offset + visited++) % scopes.length];
            try {
                if (!await this.allowed(id, scope)) continue;
                const page = await this.kernel().listSessionTaskPage(id, { ...scope.cursor, limit: this.maxTasks - results.length });
                for (const task of page.items) {
                    if (!await this.allowed(id, scope)) break;
                    results.push(await this.collectTask(id, task.id, scope.binding, settings));
                }
                scope.cursor = page.nextAfterIndex === undefined ? {} : { afterIndex: page.nextAfterIndex, throughIndex: page.throughIndex };
            } catch (error) { this.reportError(error); }
        }
        this.offset = scopes.length ? (this.offset + visited) % scopes.length : 0;
        return results;
    }

    private async allowed(id: string, scope: Scope): Promise<boolean> {
        return !this.stopped && this.sessions.get(id) === scope
            && (!this.options.canCollectSession || await this.options.canCollectSession(id));
    }

    private async collectTask(sessionId: string, taskId: string, binding: ResolvedStorageBinding, settings: ContextGcOptions) {
        const store = createTaskContextStorage(binding.fs, binding.rootPath, taskId);
        const result = { ...await createContextGc(store.gc, this.options.policy).collect(settings), sessionId, taskId };
        if (result.status === 'failed') this.reportError(new Error(result.error));
        try { this.options.onResult?.(result); } catch { /* Diagnostics cannot interrupt collection. */ }
        return result;
    }

    private reportError(error: unknown): void {
        try { (this.options.onError ?? (failure => console.warn('[Context GC]', failure)))(error); }
        catch { /* Diagnostics cannot interrupt collection. */ }
    }

    async forget(id: string): Promise<void> { this.sessions.delete(id); await this.active; }
    async dispose(): Promise<void> {
        this.stopped = true;
        await this.scheduler?.dispose();
        await this.active;
        this.sessions.clear();
    }
}
