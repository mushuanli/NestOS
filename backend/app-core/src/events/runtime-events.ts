import {randomUUID} from '@itookit/common';
import type {IFileSystem, FSEvent} from '@itookit/vfs-core';
import type {ApplicationRuntime} from '../runtime/create-application-runtime';
import {UserEventService} from './service';
import {projectKernelEvents} from './kernel-source';

type Sources = Pick<ApplicationRuntime, 'kernel' | 'sessionRepository' | 'digitalTwin'>;

/** Durable sources are replayed; ephemeral hints are repaired by a restart snapshot reset. */
class RuntimeEventProjection {
    private pending = Promise.resolve();
    private closed = false;
    private kernelQueued = false;
    private dirty = new Set<string>();
    private releases: Array<() => void> = [];
    private timer?: ReturnType<typeof setInterval>;
    constructor(private readonly service: UserEventService, private readonly sources: Sources) {}
    attach(files: IFileSystem): void {
        this.releases.push(this.sources.kernel.kernel.onChanged(event => {
            if (!this.closed && event.reason !== 'content') {this.dirty.add(event.sessionId); this.scheduleKernel();}
        }));
        this.releases.push(this.sources.sessionRepository.subscribe?.(change => {
            if (!this.closed) this.enqueue('repository', () => this.service.journal.append(randomUUID(),
                {type: 'repository.changed', resourceId: change?.sessionId}));
        }) ?? (() => {}));
        this.releases.push(files.onAny?.(event => {
            if (!this.closed && event.type.startsWith('node:')) this.enqueue('files', () => projectFile(this.service, event));
        }) ?? (() => {}));
        if (this.sources.digitalTwin) this.releases.push(this.sources.digitalTwin.onChange(() => {
            if (!this.closed) this.enqueue('scanner', () => this.service.journal.append(randomUUID(), {type: 'scanner.changed'}));
        }));
    }
    async start(): Promise<void> {
        const started = Date.now(), operationId = randomUUID();
        try {
            for await (const session of this.sources.kernel.kernel.listSessions()) this.dirty.add(session.id);
            await this.pending; await this.drain();
            await this.service.journal.append(randomUUID(), {type: 'runtime.reset'});
            console.info('[ApplicationEvents]', {operation: 'events.recover', operationId, stage: 'ready', result: 'success', durationMs: Date.now() - started});
            this.timer = setInterval(() => this.scheduleKernel(), 5000);
        } catch (error) {
            await this.dispose();
            console.warn('[ApplicationEvents]', {operation: 'events.recover', operationId, stage: 'replay', result: 'failure', code: safeCode(error), durationMs: Date.now() - started});
            throw error;
        }
    }
    async flush(): Promise<void> {await this.pending; await this.drain();}
    async dispose(): Promise<void> {
        this.closed = true; clearInterval(this.timer);
        this.releases.splice(0).reverse().forEach(stop => stop());
        await this.pending; this.service.journal.close();
    }
    private scheduleKernel(): void {
        if (this.closed || this.kernelQueued || !this.dirty.size) return;
        this.kernelQueued = true;
        this.enqueue('kernel', async () => {
            let success = false;
            try {await this.drain(); success = true;}
            finally {this.kernelQueued = false; if (success) this.scheduleKernel();}
        });
    }
    private enqueue(stage: string, run: () => Promise<unknown>): void {
        this.pending = this.pending.then(async () => {
            const started = Date.now(), operationId = randomUUID();
            try {await run();}
            catch (error) {console.warn('[ApplicationEvents]', {operation: 'events.project', operationId, stage, result: 'failure',
                code: safeCode(error), durationMs: Date.now() - started});}
        });
    }
    private async drain(): Promise<void> {
        for (const id of [...this.dirty]) {
            this.dirty.delete(id);
            try {await projectKernelEvents(this.service, this.sources.kernel.kernel, id);}
            catch (error) {if (!['SESSION_NOT_FOUND', 'ENOENT'].includes(safeCode(error))) {this.dirty.add(id); throw error;}}
        }
    }
}
export async function attachRuntimeEvents(service: UserEventService, sources: Sources, files: IFileSystem) {
    const projection = new RuntimeEventProjection(service, sources);
    try {projection.attach(files); await projection.start(); return projection;}
    catch (error) {await projection.dispose(); throw error;}
}
async function projectFile(service: UserEventService, event: FSEvent) {
    const data = event.payload;
    const paths = 'nodes' in data ? data.nodes.map(node => 'path' in node ? node.path : node.newPath)
        : 'requestedPaths' in data ? data.requestedPaths : 'copies' in data ? data.copies.map(copy => copy.targetPath) : [];
    await service.journal.transaction(async tx => {
        for (const resourceId of paths) await tx.append(randomUUID(), {type: event.type, resourceId});
    });
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'EVENT_PROJECTION_FAILED';
}
