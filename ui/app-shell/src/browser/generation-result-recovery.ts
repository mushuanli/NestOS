import {createModuleLogger} from '@itookit/common';
import type {ApplicationBackend} from '@itookit/app-contracts/services';

type Reader = Pick<ApplicationBackend, 'sessionResponse'>;
const fail = (code: string) => Object.assign(new Error(code), {code});
/** Recover the original durable result after a lost reply; never repeat the submission. */
export async function recoverGenerationResult(reader: Reader, sessionId: string, operationId: string, signal: AbortSignal): Promise<string> {
    const started = Date.now(), log = createModuleLogger('study-generation');
    log.warn('text.recover', {operationId, sessionId, stage: 'lost-reply', result: 'pending', code: 'TEXT_REPLY_INTERRUPTED'});
    if (!reader.sessionResponse) throw fail('TEXT_RESULT_UNAVAILABLE');
    try {
        const content = await readOriginal(reader, sessionId, operationId, signal, started);
        log.info('text.recover', {operationId, sessionId, stage: 'durable-result', result: 'success', outputCharacters: content.length, durationMs: Date.now() - started});
        return content;
    } catch (error) {
        const code = (error as {code?: string})?.code;
        log.warn('text.recover', {operationId, sessionId, stage: 'durable-result', result: 'failure',
            code: signal.aborted ? 'TEXT_CANCELLED' : code && /^TEXT_[A-Z_]+$/.test(code) ? code : 'TEXT_RESULT_UNAVAILABLE', durationMs: Date.now() - started});
        throw error;
    }
}
async function readOriginal(reader: Reader, sessionId: string, operationId: string, signal: AbortSignal, started: number): Promise<string> {
    for (;;) {
        signal.throwIfAborted();
        const round = await reader.sessionResponse(sessionId, {operationId, branch: 'main'}).catch(() => {throw fail('TEXT_RESULT_UNAVAILABLE');});
        if (round && ['failed', 'cancelled'].includes(round.status)) throw fail(round.status === 'cancelled' ? 'TEXT_CANCELLED' : 'TEXT_SESSION_FAILED');
        if (round?.status === 'completed') {
            const content = round.text.trim();
            if (!content) throw fail('TEXT_OUTPUT_EMPTY');
            return content;
        }
        if (!round && Date.now() - started >= 30_000) throw fail('TEXT_RESULT_UNCONFIRMED');
        await pause(signal);
    }
}
function pause(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const cancel = () => {clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason);};
        const timer = setTimeout(() => {signal.removeEventListener('abort', cancel); resolve();}, 1000);
        signal.addEventListener('abort', cancel, {once: true}); if (signal.aborted) cancel();
    });
}
