import type { Kernel } from '../application/kernel';
import type { EventEnvelope } from '../domain/types';

export async function* eventStream(
    kernel: Kernel,
    sessionId: string,
    taskId: string | undefined,
    after: number,
): AsyncGenerator<EventEnvelope> {
    if (taskId) { yield* taskEventStream(kernel, sessionId, taskId, after); return; }
    let cursor = after;
    while (true) {
        const events = await kernel.eventList(sessionId, cursor);
        for (const event of events) {
            cursor = event.sequence;
            if (!taskId || event.taskId === taskId) yield event;
        }
        await waitForChange(kernel, sessionId, taskId, 250);
    }
}

/** Read only this Task's indexed tail, preserving the public Session-sequence cursor. */
async function* taskEventStream(kernel: Kernel, sessionId: string, taskId: string, after: number): AsyncGenerator<EventEnvelope> {
    let index = 0, terminalSeen = false;
    while (true) {
        const page = await kernel.taskEventPage(sessionId, taskId, { afterIndex: index, limit: 100 });
        for (const event of page.items) if (event.sequence > after) yield event;
        index = page.nextAfterIndex ?? page.throughIndex;
        if (page.nextAfterIndex !== undefined) continue;
        // Terminal state and the journal commit together. Drain once more after
        // observing terminal, including every page committed during the prior read.
        if (terminalSeen) return;
        terminalSeen = await isTerminal(kernel, sessionId, taskId);
        if (!terminalSeen) await waitForChange(kernel, sessionId, taskId, 250);
    }
}

async function isTerminal(kernel: Kernel, sessionId: string, taskId: string): Promise<boolean> {
    const status = (await kernel.task(sessionId, taskId)).status;
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function waitForChange(
    kernel: Kernel,
    sessionId: string,
    taskId: string | undefined,
    timeoutMs: number,
): Promise<void> {
    return new Promise(resolve => {
        const timeout = setTimeout(done, timeoutMs);
        const off = kernel.onChanged(event => {
            if (event.sessionId === sessionId && (!taskId || !event.taskId || event.taskId === taskId)) done();
        });
        function done(): void { clearTimeout(timeout); off(); resolve(); }
    });
}
