/** Bounds cleanup waits without starting overlapping calls for the same Effect. */
export class EffectCleanupRunner {
    private readonly pending = new Map<string, Promise<void>>();

    constructor(private readonly timeoutMs: number) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
            throw new Error('Kernel effectCleanupTimeoutMs must be an integer between 1 and 2147483647');
        }
    }

    async run(key: string, cleanup: () => Promise<void>): Promise<void> {
        let operation = this.pending.get(key);
        if (!operation) {
            operation = Promise.resolve().then(cleanup);
            this.pending.set(key, operation);
            void operation.finally(() => this.pending.delete(key)).catch(() => {});
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Effect cleanup timed out: ${key}`)), this.timeoutMs);
        });
        try { await Promise.race([operation, deadline]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
    }
}
