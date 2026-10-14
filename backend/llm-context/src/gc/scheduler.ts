export interface ContextGcScheduleOptions {
    initialDelayMs?: number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
}

export function validateContextGcSchedule(options: ContextGcScheduleOptions): void {
    const delay = options.initialDelayMs ?? 60_000;
    const interval = options.intervalMs ?? 3_600_000;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 2_147_483_647
        || !Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483_647) {
        throw new Error('Invalid context GC schedule');
    }
}

/** One pass at a time; shutdown waits for the current transaction to finish. */
export function scheduleContextGc(run: () => Promise<void>, options: ContextGcScheduleOptions = {}) {
    validateContextGcSchedule(options);
    const delay = options.initialDelayMs ?? 60_000;
    const interval = options.intervalMs ?? 3_600_000;
    let stopped = false, active: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Diagnostics cannot break maintenance. */ } };
    const collect = () => {
        if (stopped) return Promise.resolve();
        return active ??= Promise.resolve().then(run).catch(report).finally(() => { active = undefined; });
    };
    const arm = (ms: number) => {
        timer = setTimeout(() => { void collect().finally(() => { if (!stopped) arm(interval); }); }, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
    };
    arm(delay);
    return { collect, async dispose() { stopped = true; clearTimeout(timer); await active; } };
}
