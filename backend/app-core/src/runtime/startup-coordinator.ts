import { traceBoot } from '@itookit/common';
import { mapConcurrent } from '../utils/map-concurrent';
import type { InitializationPhase } from './startup-policy';

type Task = () => Promise<unknown>;
interface ScheduledTask { label: string; run: Task }
interface StartupPorts {
    trace<T>(label: string, run: () => Promise<T>): Promise<T>;
    report(label: string, error: unknown): void;
}
const ports: StartupPorts = { trace: traceBoot, report: (label, error) => console.warn(`[Boot] ${label} failed`, error) };

/** Own accepted tasks, share readiness, and drain them before services are released. */
export class StartupCoordinator {
    private closed = false;
    private readonly pending = new Set<Promise<unknown>>();
    private readonly deferred: ScheduledTask[] = [];
    private activation?: Promise<unknown>;
    private closing?: Promise<void>;
    constructor(private readonly hooks: StartupPorts = ports, private readonly concurrency = 2) {
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Startup concurrency must be positive');
    }
    get active(): boolean { return !this.closed; }

    task<T>(label: string, action: () => Promise<T>): () => Promise<T> {
        let ready: Promise<T> | undefined;
        return () => {
            // Draining work may still await an already accepted dependency during shutdown.
            if (ready) return ready;
            if (this.closed) return Promise.reject(new Error('Startup is closed'));
            ready = Promise.resolve().then(() => this.hooks.trace(label, action));
            this.pending.add(ready);
            void ready.finally(() => this.pending.delete(ready!)).catch(() => {});
            return ready;
        };
    }

    schedule(phase: InitializationPhase, label: string, action: () => Promise<void>): void | Promise<void> {
        const run = this.task(label, action);
        if (phase === 'before-ready') return run();
        if (phase === 'after-ready' && !this.activation) this.deferred.push({ label, run });
        else void this.observe({ label, run });
    }

    activate(): void {
        if (this.closed || this.activation) return;
        this.activation = mapConcurrent(this.deferred.splice(0), this.concurrency, task => this.observe(task));
        void this.activation.catch(error => this.hooks.report('startup activation', error));
    }

    private async observe(task: ScheduledTask): Promise<void> {
        if (!this.closed) await task.run().catch(error => this.hooks.report(task.label, error));
    }

    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true;
            this.closing = Promise.allSettled([...this.pending, ...(this.activation ? [this.activation] : [])]).then(() => {});
        }
        return this.closing;
    }
}
