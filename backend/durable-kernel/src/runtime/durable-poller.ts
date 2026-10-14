export interface DurablePollerOptions<K> {
    intervalMs: number;
    poll(key: K): Promise<boolean | { nextDelay: number | undefined }>;
    nextDelay?(key: K): Promise<number | undefined>;
    onError(key: K, error: unknown): boolean;
}

export class DurablePoller<K> {
    private readonly timers = new Map<K, ReturnType<typeof setTimeout>>();
    private disposed = false;
    private readonly running = new Set<K>();
    private readonly requested = new Set<K>();
    private readonly enabled = new Set<K>();
    get isIdle(): boolean { return this.running.size === 0; }

    constructor(private readonly options: DurablePollerOptions<K>) {}

    start(key: K): void {
        if (this.disposed) return;
        this.enabled.add(key);
        if (this.running.has(key)) { this.requested.add(key); return; }
        this.arm(key, 0);
    }

    private arm(key: K, delay: number): void {
        const previous = this.timers.get(key);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => void this.tick(key), Math.min(2147483647, Math.max(0, delay)));
        unrefTimer(timer);
        this.timers.set(key, timer);
    }

    stop(key: K): void {
        this.enabled.delete(key);
        this.requested.delete(key);
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
    }

    dispose(): void {
        this.disposed = true;
        this.enabled.clear();
        for (const key of this.timers.keys()) this.stop(key);
    }

    private async tick(key: K): Promise<void> {
        this.timers.delete(key);
        if (this.disposed || !this.enabled.has(key)) return;
        this.running.add(key);
        let again = false;
        let delay: number | undefined;
        try {
            const result = await this.options.poll(key);
            again = result !== false;
            if (typeof result === 'object') delay = result.nextDelay;
            else if (again) delay = await this.options.nextDelay?.(key);
        } catch (error) {
            again = this.options.onError(key, error);
            if (again) delay = Math.max(this.options.intervalMs, 1000);
        } finally {
            this.running.delete(key);
            if (!this.disposed && this.enabled.has(key)) {
                if (this.requested.delete(key)) this.arm(key, 0);
                else if (again) {
                    if (this.options.intervalMs > 0) delay = Math.min(delay ?? Infinity, this.options.intervalMs);
                    if (delay !== undefined && Number.isFinite(delay)) this.arm(key, delay);
                }
            }
        }
    }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}
