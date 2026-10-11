import type { Kernel } from '@itookit/durable-kernel';
import { traceAnalysis } from './diagnostics';
import { readProgress } from './read-progress';
import type { TwinAnalysisJob } from './domain';

export type TwinRequestProgress = Pick<TwinAnalysisJob, 'requestStartedAt' | 'responseReceivedAt' | 'responseCompletedAt'>;

/** Observe request boundaries without recording private prompts or model content. */
export async function observeExtraction(kernel: Kernel, job: TwinAnalysisJob, taskId: string,
    state: { stopped: boolean }, changed: (progress: TwinRequestProgress) => Promise<void>): Promise<void> {
    let index = 0;
    let drained = false;
    const progress: TwinRequestProgress = {};
    while (true) {
        const page = await readProgress(() => kernel.taskEventPage(job.sessionId, taskId, { afterIndex: index, limit: 100 }), job, taskId);
        for (const envelope of page.items) {
            const event = envelope.payload as { type?: string; delta?: string } | undefined;
            if (envelope.type !== 'agent.event') continue;
            if (event?.type === 'llm:request' && !progress.requestStartedAt) {
                progress.requestStartedAt = envelope.occurredAt;
                traceAnalysis(job, 'request_started', { taskId, stream: false });
                await changed({ ...progress });
            }
            if (['stream:content', 'stream:thinking'].includes(event?.type ?? '') && !progress.responseReceivedAt) {
                progress.responseReceivedAt = envelope.occurredAt;
                traceAnalysis(job, 'response_received', { taskId });
                await changed({ ...progress });
            }
        }
        index = page.nextAfterIndex ?? page.throughIndex;
        if (page.nextAfterIndex !== undefined) continue;
        if (state.stopped) { if (drained) return; drained = true; }
        else await new Promise(resolve => setTimeout(resolve, 250));
    }
}
