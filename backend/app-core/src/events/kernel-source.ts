import type {ApplicationRuntime} from '../runtime/create-application-runtime';
import type {UserEventService} from './service';
import {randomUUID} from '@itookit/common';

type Kernel = ApplicationRuntime['kernel']['kernel'];
type Source = Awaited<ReturnType<Kernel['inspectSession']>>;
type Page = Awaited<ReturnType<Source['readEvents']>>;
const retained = new Set(['session.created', 'session.closed', 'session.archived', 'task.succeeded', 'task.failed', 'task.cancelled']);

/** Consume persisted Kernel facts. Source checkpoint and projection append commit together. */
export async function projectKernelEvents(service: UserEventService, kernel: Kernel, sessionId: string): Promise<void> {
    const source = await kernel.inspectSession(sessionId), key = 'kernel/' + sessionId;
    let more = true;
    while (more) {
        const raw = await service.journal.transaction(tx => tx.getState(key));
        const after = raw === null ? 0 : Number(raw);
        if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(after) || after < 0)) {
            await resetSource(service, source, sessionId, raw, 'EVENT_CHECKPOINT_INVALID'); return;
        }
        let page: Page;
        try {page = await source.readEvents({afterSequence: after, limit: 200});}
        catch (error) {
            const code = (error as {code?: string}).code;
            if (code === 'CURSOR_EXPIRED') await resetSource(service, source, sessionId, raw, code);
            else if (code === 'INVALID_SPEC') await resetSource(service, source, sessionId, raw, 'EVENT_CHECKPOINT_AHEAD', error);
            else throw error;
            return;
        }
        const next = page.nextAfterSequence ?? page.throughSequence;
        if (next === after) return;
        await projectPage(service, sessionId, page, raw, next);
        more = page.nextAfterSequence !== undefined;
    }
}
async function resetSource(service: UserEventService, source: Source, sessionId: string, expected: string | null,
    code: string, boundsError?: unknown) {
    const started = Date.now(), operationId = randomUUID();
    const snapshot = await source.snapshot(), key = 'kernel/' + sessionId;
    // INVALID_SPEC alone is not evidence that a projection checkpoint is stale.
    if (boundsError && Number(expected) <= snapshot.asOfSequence) throw boundsError;
    const applied = await service.journal.transaction(async tx => {
        if (await tx.getState(key) !== expected) return false;
        await tx.append(`kernel-reset/${sessionId}/${snapshot.asOfSequence}`,
            {type: 'source.reset', resourceId: sessionId, sourceSequence: snapshot.asOfSequence});
        await tx.setState(key, String(snapshot.asOfSequence));
        return true;
    });
    console.warn('[ApplicationEvents]', {operation: 'events.source.recover', operationId, sessionId, stage: 'checkpoint_reset',
        result: applied ? 'success' : 'superseded', code,
        ...(expected !== null && Number.isSafeInteger(Number(expected)) ? {afterSequence: Number(expected)} : {}),
        asOfSequence: snapshot.asOfSequence, durationMs: Date.now() - started});
}
async function projectPage(service: UserEventService, sessionId: string, page: Page, expected: string | null, next: number) {
    const key = 'kernel/' + sessionId;
    await service.journal.transaction(async tx => {
        if (await tx.getState(key) !== expected) return;
        for (const event of page.items) {
            if (!retained.has(event.type)) continue;
            await tx.append(`kernel/${sessionId}/${event.sequence}`, {type: event.type, resourceId: event.taskId ?? sessionId,
                sourceSequence: event.sequence, ...(event.type === 'task.failed' ? {notification: 'error' as const} : {})}, event.occurredAt);
        }
        await tx.setState(key, String(next));
    });
}
