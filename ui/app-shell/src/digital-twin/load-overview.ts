import type { TwinWorkbenchOptions } from './index';

/** Trace names and timings only; never include source contents or model credentials. */
export function loadOverview(options: TwinWorkbenchOptions, signal: AbortSignal) {
    const started = Date.now(), pending = new Map<string, { stage: string; since: number }>();
    const durations: Array<{ stage: string; milliseconds: number }> = [];
    const stage = (key: string, name: string) => {
        const previous = pending.get(key);
        if (previous) durations.push({ stage: previous.stage, milliseconds: Date.now() - previous.since });
        pending.set(key, { stage: name, since: Date.now() });
    };
    const read = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
        stage(key, key);
        const result = await action();
        stage(key, 'completed'); pending.delete(key); return result;
    };
    const diagnostic = () => ({ elapsedMs: Date.now() - started, ...options.service.diagnostics(),
        pending: [...pending.values()].map(item => ({ stage: item.stage, milliseconds: Date.now() - item.since })), completed: [...durations] });
    return bounded(() => Promise.all([
        read('snapshot', () => options.service.snapshot(name => stage('snapshot', name))),
        read('connections.list', () => options.connections()),
    ]), signal, diagnostic);
}

/** A view timeout does not cancel background scans or durable writes. */
function bounded<T>(read: () => Promise<T>, signal: AbortSignal, diagnostic: () => unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); clearTimeout(slow); signal.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(new Error('TWIN_LOAD_CANCELLED')); };
        const slow = setTimeout(() => console.warn('[DigitalTwin] Slow overview load', diagnostic()), 5_000);
        const timer = setTimeout(() => {
            console.error('[DigitalTwin] Overview load timed out', diagnostic());
            finish(); reject(new Error('TWIN_LOAD_TIMEOUT'));
        }, 30_000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        Promise.resolve().then(read).then(resolve, error => {
            console.error('[DigitalTwin] Overview load failed', diagnostic()); reject(error);
        }).finally(finish);
    });
}
