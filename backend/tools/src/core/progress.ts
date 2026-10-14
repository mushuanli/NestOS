import type { ToolProgress } from '../contracts';

/** Coalesce fast producers into one pending replacement snapshot and one in-flight write. */
export function createToolProgressReporter(emit?: (progress: ToolProgress) => Promise<void>, intervalMs = 250) {
    let latest: ToolProgress | undefined, pending: Promise<void> | undefined;
    let failure: unknown, failed = false, last = 0;
    async function drain() {
        while (latest && !failed) {
            const delay = Math.max(0, last + intervalMs - Date.now());
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            const value = latest; latest = undefined; last = Date.now();
            await emit?.(value);
        }
    }
    function start() {
        pending = drain().catch(error => { failure = error; failed = true; }).finally(() => {
            pending = undefined; if (latest && !failed) start();
        });
    }
    return {
        update(progress: ToolProgress): void {
            if (!emit || failed) return;
            latest = { message: progress.message.slice(0, 2048), output: progress.output?.slice(0, 8192) };
            if (!pending) start();
        },
        async finish(): Promise<void> { while (pending) await pending; if (failed) throw failure; },
    };
}
