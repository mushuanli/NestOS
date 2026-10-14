import type { LeaseGuardOptions } from '../domain/types';
import type { Kernel } from '../application/kernel';
import type {
    EventEnvelope,
    ExitRecord,
    InteractionResponse,
    JsonValue,
    ResourceGrant,
    TaskResourceSpec,
    TaskAttempt,
    TaskHandle,
    TaskRecord,
    TaskSignal,
    TaskSnapshot,
} from '../domain/types';
import { eventStream, waitForChange } from './event-stream';
import { taskStat, taskStats } from '../domain/status';

export class DefaultTaskHandle<O> implements TaskHandle<O> {
    get resources() { return this.kernel.resourceApi(this.sessionId, this.id); }
    get cache(): import('../domain/cache').CacheApi {
        return { create: spec => this.createCache(spec), list: () => this.listCaches(), read: request => this.readCache(request),
            publish: request => this.publishCache(request), invalidate: (id, generation) => this.invalidateCache(id, generation),
            renew: (id, generation, ttl) => this.renewCache(id, generation, ttl) };
    }
    send(request: import('../domain/types').TaskMessageRequest) { return this.sendMessage(request); }
    async stat() { return taskStat(await this.kernel.task(this.sessionId, this.id)); }
    async stats() { return taskStats(await this.kernel.task(this.sessionId, this.id)); }
    watch(options?: { after?: number }) { return this.events(options); }
    constructor(
        private readonly kernel: Kernel,
        private readonly sessionId: string,
        readonly id: string,
    ) {}

    resolveEffect(request: import('../domain/types').EffectResolution) { return this.kernel.resolveEffect(this.sessionId, this.id, request); }
    sendMessage(request: import('../domain/types').TaskMessageRequest) { return this.kernel.sendTaskMessage(this.sessionId, this.id, request); }
    createCache(spec: import('../domain/cache').CacheSpec) { return this.kernel.createCache(this.sessionId, this.id, spec); }
    renewCache(handleId: string, expectedGeneration: number, ttlMs: number) { return this.kernel.renewCache(this.sessionId, this.id, handleId, expectedGeneration, ttlMs); }
    listCaches() { return this.kernel.listCaches(this.sessionId, this.id); }
    readCache(request: import('../domain/cache').CacheRead) { return this.kernel.readCache(this.sessionId, this.id, request); }
    publishCache(request: import('../domain/cache').CachePublish) { return this.kernel.publishCache(this.sessionId, this.id, request); }
    invalidateCache(handleId: string, expectedGeneration: number) { return this.kernel.invalidateCache(this.sessionId, this.id, handleId, expectedGeneration); }

    retry(options: LeaseGuardOptions & { requestId: string }): Promise<TaskHandle<O>> {
        return this.kernel.retryTask<O>(this.sessionId, this.id, options);
    }

    async status(): Promise<TaskSnapshot> {
        return { task: await this.kernel.task(this.sessionId, this.id) };
    }

    async wait(options?: { timeoutMs?: number }): Promise<ExitRecord<O>> {
        const startedAt = Date.now();
        while (true) {
            const exit = await this.poll();
            if (exit) return exit;
            if (timedOut(startedAt, options?.timeoutMs)) throw new Error(`Task wait timed out: ${this.id}`);
            await waitForChange(this.kernel, this.sessionId, this.id, 100);
        }
    }

    async poll(): Promise<ExitRecord<O> | undefined> {
        return (await this.kernel.task(this.sessionId, this.id)).exit as ExitRecord<O> | undefined;
    }

    signal(signal: TaskSignal, options?: LeaseGuardOptions): Promise<void> {
        return this.kernel.signal(this.sessionId, this.id, signal, options);
    }

    pause(options: import('../domain/types').TaskControlOptions) { return this.kernel.controlTask(this.sessionId, this.id, 'pause', options); }
    interrupt(options: import('../domain/types').TaskControlOptions) { return this.kernel.controlTask(this.sessionId, this.id, 'interrupt', options); }
    resume(options: import('../domain/types').TaskControlOptions & { signal?: TaskSignal }) { return this.kernel.controlTask(this.sessionId, this.id, 'run', options); }

    start(options?: import('../domain/types').TaskStartOptions): Promise<void> {
        return this.kernel.startTask(this.sessionId, this.id, options);
    }

    respond<T extends JsonValue>(response: InteractionResponse<T>, options?: LeaseGuardOptions): Promise<void> {
        return this.kernel.respondInteraction(this.sessionId, this.id, response, options);
    }

    createResource(spec: TaskResourceSpec, options?: LeaseGuardOptions): Promise<ResourceGrant> {
        return this.kernel.createResource(this.sessionId, { ...spec, ownerTaskId: this.id }, options);
    }

    cancel(reason?: string, options?: LeaseGuardOptions): Promise<void> {
        return this.kernel.cancel(this.sessionId, this.id, reason, options);
    }

    events(options?: { after?: number }): AsyncIterable<EventEnvelope> {
        return eventStream(this.kernel, this.sessionId, this.id, options?.after ?? 0);
    }

    history(options?: { afterVersion?: number }): Promise<TaskRecord[]> {
        return this.kernel.taskHistory(this.sessionId, this.id, options?.afterVersion ?? -1);
    }

    attempts(): Promise<TaskAttempt[]> {
        return this.kernel.taskAttempts(this.sessionId, this.id);
    }
}

function timedOut(startedAt: number, timeoutMs: number | undefined): boolean {
    return timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs;
}
