import type { KernelAdaptersRuntimeOptions } from '@itookit/kernel-adapters';
import type { SessionFilesService } from '@itookit/app-contracts/services';

type ToolFiles = Awaited<ReturnType<SessionFilesService['acquire']>>;
type RuntimeFiles = Awaited<ReturnType<NonNullable<KernelAdaptersRuntimeOptions['fileContextForSession']>>>;

/** The platform owns process grants and stops processes before releasing files. */
export interface SessionProcessMount { sourceId: string; directory: string; at: string; access: 'ro' | 'rw'; }
export type SessionProcessFactory = (sessionId: string, files: ToolFiles, mounts: SessionProcessMount[]) => Promise<{
    nativeShell: NonNullable<RuntimeFiles['nativeShell']>;
    ttyDriver?: RuntimeFiles['ttyDriver'];
    release(): Promise<void>;
}>;

export async function acquireSessionProcessContext(
    files: Pick<SessionFilesService, 'acquire'>, sessionId: string, factory?: SessionProcessFactory,
    mounts: () => Promise<SessionProcessMount[]> = async () => [],
): Promise<RuntimeFiles> {
    const context = await files.acquire(sessionId);
    if (!factory) return context;
    let processes: Awaited<ReturnType<SessionProcessFactory>>;
    try { processes = await factory(sessionId, context, await mounts()); }
    catch (error) {
        try { await context.release(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Session process initialization and file cleanup failed'); }
        throw error;
    }
    return { ...context, nativeShell: processes.nativeShell, ttyDriver: processes.ttyDriver,
        release: orderedRelease([() => processes.release(), () => context.release()]) };
}

/** Stop must succeed before files can be released; retry only the unfinished steps. */
function orderedRelease(steps: Array<() => Promise<void>>): () => Promise<void> {
    let pending: Promise<void> | undefined;
    return () => {
        if (pending) return pending;
        const run = async () => {
            while (steps.length) { await steps[0](); steps.shift(); }
        };
        const attempt = run();
        pending = attempt;
        void attempt.catch(() => { if (pending === attempt) pending = undefined; });
        return attempt;
    };
}
