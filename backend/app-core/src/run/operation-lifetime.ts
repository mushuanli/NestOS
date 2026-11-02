import {failure} from './prompt-bundle';

/** Stop admission immediately, then drain complete operations before their filesystem closes. */
export class OperationLifetime {
    private stopped = false;
    private pending = new Set<Promise<unknown>>();
    run<T>(work: () => Promise<T>): Promise<T> {
        if (this.stopped) return Promise.reject(failure('SERVICE_STOPPING'));
        const pending = Promise.resolve().then(work).finally(() => {this.pending.delete(pending);});
        this.pending.add(pending); return pending;
    }
    async close(): Promise<void> {
        this.stopped = true;
        await Promise.allSettled([...this.pending]);
    }
}
