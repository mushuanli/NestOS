function constrainedConnection(): boolean {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    return !!connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '');
}

/** Run navigation preparation serially after paint, yielding to foreground loads. */
export function scheduleNavigationWarmup(tasks: Array<() => Promise<unknown>>, busy: () => boolean = () => false): () => void {
    let closed = false, running = false, index = 0, idle: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (closed || running || index >= tasks.length || document.hidden || constrainedConnection()) return;
        timer = setTimeout(() => {
            if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(run, { timeout: 3000 });
            else void run();
        }, 200);
    };
    const run = async () => {
        if (closed || document.hidden || constrainedConnection()) return;
        if (busy()) { schedule(); return; }
        running = true;
        try { await tasks[index++](); }
        catch (error) { console.warn('[Shell] Navigation warmup failed', error); }
        finally { running = false; schedule(); }
    };
    const resume = () => {
        clearTimeout(timer); if (idle !== undefined) window.cancelIdleCallback(idle);
        schedule();
    };
    document.addEventListener('visibilitychange', resume); schedule();
    return () => { closed = true; clearTimeout(timer); if (idle !== undefined) window.cancelIdleCallback(idle); document.removeEventListener('visibilitychange', resume); };
}
