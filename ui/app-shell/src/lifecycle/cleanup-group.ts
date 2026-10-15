export type Cleanup = () => void | Promise<void>;

/** A partially constructed workspace owns its cleanup even when another one loads concurrently. */
export function cleanupGroup() {
    const callbacks: Cleanup[] = [];
    return {
        own(cleanup: Cleanup): void { callbacks.push(cleanup); },
        async close(): Promise<void> {
            for (const cleanup of callbacks.splice(0).reverse()) {
                try { await cleanup(); } catch (error) { console.error('[Shell] Workspace cleanup failed', error); }
            }
        },
    };
}
