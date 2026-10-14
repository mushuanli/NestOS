/** Cancellation applies to view reads, never to writes or durable execution. */
export class ViewLoadCancelled extends Error {}

export class ViewLoad {
    private readonly pending = new Set<Promise<unknown>>();
    constructor(readonly signal: AbortSignal) {}
    check(): void { if (this.signal.aborted) throw new ViewLoadCancelled(); }
    read<T>(read: () => Promise<T>): Promise<T> {
        this.check();
        const pending = Promise.resolve().then(() => { this.check(); return read(); });
        this.pending.add(pending);
        void pending.finally(() => this.pending.delete(pending)).catch(() => {});
        return new Promise<T>((resolve, reject) => {
            const abort = () => reject(new ViewLoadCancelled());
            this.signal.addEventListener('abort', abort, { once: true });
            pending.then(value => {
                if (this.signal.aborted) abort(); else resolve(value);
            }, reject).finally(() => this.signal.removeEventListener('abort', abort));
            if (this.signal.aborted) abort();
        });
    }
    async drain(): Promise<void> { await Promise.allSettled(this.pending); }
}

/** A replaceable view operation; independent directory reads use separate owners. */
export class LatestViewLoad {
    private controller = new AbortController();
    begin(): ViewLoad {
        this.cancel();
        this.controller = new AbortController();
        return new ViewLoad(this.controller.signal);
    }
    /** A completed editor owns its signal until its tab closes. */
    detach(load: ViewLoad): () => void {
        if (!this.isCurrent(load)) throw new ViewLoadCancelled();
        const owner = this.controller; this.controller = new AbortController();
        return () => owner.abort();
    }
    cancel(): void { this.controller.abort(); }
    isCurrent(load: ViewLoad): boolean {
        return load.signal === this.controller.signal && !load.signal.aborted;
    }
}
