/** Probe only after a disconnect; never replay application calls. */
export class ConnectionRecovery {
    private readonly abort = new AbortController();
    private running = false;
    private completed = false;
    private wake?: () => void;
    constructor(private readonly check: (signal: AbortSignal) => Promise<boolean>, private readonly ready: () => void) {}
    start(): void {
        if (this.running || this.completed || this.abort.signal.aborted) return;
        this.running = true;
        void this.run().finally(() => { this.running = false; }).catch(() => {});
    }
    retry(): void { if (this.running) this.wake?.(); }
    stop(): void { this.abort.abort(); this.wake?.(); }
    private async run(): Promise<void> {
        for (let delay = 1000; !this.abort.signal.aborted; delay = Math.min(delay * 2, 15000)) {
            let ready = false;
            try { ready = await this.check(this.abort.signal); } catch { /* Retry readiness, never the failed command. */ }
            if (this.abort.signal.aborted) return;
            if (ready) { this.completed = true; this.ready(); return; }
            await this.pause(delay);
        }
    }
    private pause(delay: number): Promise<void> {
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); this.wake = undefined; resolve();
            };
            const timer = setTimeout(done, delay); this.wake = done;
            this.abort.signal.addEventListener('abort', done, { once: true });
        });
    }
}
