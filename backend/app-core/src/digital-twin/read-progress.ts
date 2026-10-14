import { FSError } from '@itookit/vfs-core';
import { diagnosticDetail, traceAnalysis } from './diagnostics';

/** Re-read a fresh progress snapshot after conflicts; never replay a write transaction. */
export async function readProgress<T>(read: () => Promise<T>, job: { sessionId: string; connectionId: string }, taskId: string,
    stage = 'diagnostic_retry'): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await read(); }
        catch (error) {
            if (!(error instanceof FSError && error.code === 'ECONFLICT') || attempt >= 3) throw error;
            const delayMs = 50 * 2 ** attempt + Math.floor(Math.random() * 50);
            traceAnalysis(job, stage, { taskId, attempt: attempt + 1, delayMs, errorDetail: diagnosticDetail(error) });
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}
