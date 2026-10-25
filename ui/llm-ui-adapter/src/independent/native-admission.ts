import {createModuleLogger} from '@itookit/common';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';

const log = createModuleLogger('native-submission');

/** End the UI admission wait on durable evidence, independently of its transport reply. */
export async function awaitNativeAdmission(controls: ConversationControls, operationId: string,
    start: () => Promise<ConversationSnapshot>, signal?: AbortSignal): Promise<ConversationSnapshot> {
    const started = Date.now();
    signal?.throwIfAborted();
    if (!controls.subscribe || !controls.snapshot) return start();
    return new Promise((resolve, reject) => {
        let settled = false, stop = () => {};
        const finish = (result: {value: ConversationSnapshot} | {error: unknown}) => {
            if (settled) return;
            settled = true; signal?.removeEventListener('abort', abort); release(stop, operationId);
            if ('value' in result) resolve(result.value); else reject(result.error);
        };
        const abort = () => finish({error: signal?.reason ?? new Error('Native admission observation closed')});
        const observe = () => {
            try {
                const state = controls.snapshot!();
                if (admitted(state, operationId)) {reportAccepted(operationId, started); finish({value: state});}
            } catch (error) {finish({error});}
        };
        stop = controls.subscribe!(observe);
        if (settled) {release(stop, operationId); return;}
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) {abort(); return;}
        observe();
        void Promise.resolve().then(() => settled ? undefined : start()).then(
            value => {if (value) finish({value});}, error => finish({error}));
    });
}

function admitted(state: ConversationSnapshot, id: string): boolean {
    return state.instructionQueue?.acceptedIds.includes(id) === true
        || state.submission?.id === id && state.submission.status === 'accepted';
}

function release(stop: () => void, operationId: string): void {
    const started = Date.now();
    try {stop();}
    catch {
        try {log.warn('native.admission', {operationId, stage: 'unsubscribe', result: 'failure',
            code: 'ADMISSION_OBSERVER_RELEASE_FAILED', durationMs: Date.now() - started});}
        catch { /* Diagnostics must not strand an already settled view wait. */ }
    }
}

function reportAccepted(operationId: string, started: number): void {
    try {log.info('native.admission', {operationId, stage: 'durable-receipt', result: 'success', durationMs: Date.now() - started});}
    catch { /* Diagnostics must not change native admission facts. */ }
}
