interface ViewRefreshOptions {
    visible(): boolean;
    run(sources: readonly string[]): Promise<void>;
    report(error: unknown): void;
    delay?: number;
}

/** Coalesce view invalidations without owning data, editors or backend execution. */
export class ViewRefresh {
    private readonly sources = new Set<string>();
    private timer?: ReturnType<typeof setTimeout>;
    private tail = Promise.resolve();
    private queued = false;
    private running = false;
    private closed = false;
    private retryDelay = 1000;
    constructor(private readonly options: ViewRefreshOptions) {}
    get dirty(): boolean { return this.sources.size > 0; }
    mark(source: string, schedule = true): void {
        if (this.closed) return;
        this.sources.add(source);
        if (!schedule || !this.options.visible() || this.timer) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.options.delay ?? 120);
    }
    flush(): Promise<void> {
        this.clearTimer();
        if (this.closed || !this.options.visible() || this.queued) return this.tail;
        this.queued = true;
        this.tail = this.tail.then(async () => {
            this.queued = false;
            if (this.closed || !this.options.visible()) return;
            const sources = [...this.sources]; this.sources.clear(); this.running = true;
            try { await this.options.run(sources); this.retryDelay = 1000; }
            catch (error) { this.sources.add('refresh-failed'); this.options.report(error); this.retry(error); }
            finally { this.running = false; }
        });
        return this.tail;
    }
    pause(): void {
        this.clearTimer();
        if (this.running || this.queued) this.sources.add('visibility-interrupted');
    }
    close(): Promise<void> { this.closed = true; this.pause(); return this.tail; }
    private retry(error: unknown): void {
        if (this.closed || !this.options.visible() || this.timer) return;
        if (['EACCES', 'EINVAL', 'ECONFLICT', 'ENOENT', 'ECAPABILITY', 'ENOTDIR'].includes(String((error as {code?: string})?.code))) return;
        this.timer = setTimeout(() => {this.timer = undefined; void this.flush();}, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    }
    private clearTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
}
