import type { KanbanService } from '@itookit/app-contracts';

/** Host supplies its scheduler; disposal prevents new scans and awaits in-flight work. */
export function startKanbanMonitor(options: {
    service: Pick<KanbanService, 'scan'>;
    subscribeTick: (tick: () => void) => () => void;
    onError: (error: unknown) => void;
    initialScan?: boolean;
}): { dispose(): Promise<void> } {
    let stopped = false, pending: Promise<void> | undefined;
    const tick = () => {
        if (stopped || pending) return;
        pending = Promise.resolve().then(() => options.service.scan()).catch(error => {
            try { options.onError(error); } catch { /* Reporting must not leave an unhandled rejection. */ }
        }).finally(() => { pending = undefined; });
    };
    const unsubscribe = options.subscribeTick(tick);
    if (options.initialScan !== false) tick();
    return { async dispose() {
        if (stopped) { await pending; return; }
        stopped = true; try { unsubscribe(); } finally { await pending; }
    } };
}
