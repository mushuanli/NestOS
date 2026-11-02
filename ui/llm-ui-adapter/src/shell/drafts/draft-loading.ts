import {createModuleLogger, randomUUID, t} from '@itookit/common';

const log = createModuleLogger('draft-loading');
type Stage = 'attachments' | 'configuration' | 'targets';

/** Keep asynchronous restoration visible without logging draft contents. */
export function draftLoading(container: HTMLElement, signal?: AbortSignal) {
    const notice = document.createElement('p'), operationId = randomUUID();
    notice.className = 'llm-draft-loading'; notice.setAttribute('role', 'status'); container.append(notice);
    return {
        async read<T>(stage: Stage, read: () => Promise<T>): Promise<T> {
            const started = performance.now(); notice.textContent = t(`project.draftLoading.${stage}`);
            try {
                signal?.throwIfAborted(); const result = await read(); signal?.throwIfAborted();
                log.debug('draft.open', {operationId, stage, result: 'success', durationMs: Math.round(performance.now() - started)});
                return result;
            } catch (error) {
                const raw = (error as {code?: unknown})?.code;
                const code = signal?.aborted ? 'ABORTED' : typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'DRAFT_OPEN_FAILED';
                log.warn('draft.open', {operationId, stage, result: 'failure', code, durationMs: Math.round(performance.now() - started)});
                if (signal?.aborted) notice.remove();
                else {notice.setAttribute('role', 'alert'); notice.textContent = `${t('project.draftLoading.failed')} ${error instanceof Error ? error.message : code}`;}
                throw error;
            }
        },
        finish: () => notice.remove(),
    };
}
