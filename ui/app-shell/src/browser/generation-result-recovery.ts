import {createModuleLogger} from '@itookit/common';
import type {ApplicationBackend, SessionResponse} from '@itookit/app-contracts/services';
import {reportResultQuery, resultQueryFailure} from './result-query-diagnostic';

type Reader = Pick<ApplicationBackend, 'sessionResponse'> & Partial<Pick<ApplicationBackend, 'reportClientDiagnostic'>>;
const fail = (code: string) => Object.assign(new Error(code), {code});
/** Recover the original durable result after a lost reply; never repeat the submission. */
export async function recoverGenerationResult(reader: Reader, sessionId: string, operationId: string, signal: AbortSignal, observing: boolean | (() => boolean) = false, queryDelayed?: () => void): Promise<string> {
    const started = Date.now(), log = createModuleLogger('study-generation');
    if (!observing) log.warn('text.recover', {operationId, sessionId, stage: 'lost-reply', result: 'pending', code: 'TEXT_REPLY_INTERRUPTED'});
    if (!reader.sessionResponse) throw fail('TEXT_RESULT_UNAVAILABLE');
    try {
        const content = await readOriginal(reader, sessionId, operationId, signal, started, observing, queryDelayed);
        log.info('text.recover', {operationId, sessionId, stage: 'durable-result', result: 'success', outputCharacters: content.length, durationMs: Date.now() - started});
        return content;
    } catch (error) {
        if (signal.aborted && observing) throw error;
        const code = (error as {code?: string})?.code;
        log.warn('text.recover', {operationId, sessionId, stage: 'durable-result', result: 'failure',
            code: signal.aborted ? 'TEXT_CANCELLED' : code && /^TEXT_[A-Z_]+$/.test(code) ? code : 'TEXT_RESULT_UNAVAILABLE', durationMs: Date.now() - started});
        throw error;
    }
}
interface RecoveryQuery {
    reader: Reader; sessionId: string; operationId: string; signal: AbortSignal;
    observing: boolean | (() => boolean); queryDelayed?: () => void;
    pending?: Promise<SessionResponse | undefined>; reportedAt?: number;
}
async function readOriginal(reader: Reader, sessionId: string, operationId: string, signal: AbortSignal, started: number, observing: boolean | (() => boolean), queryDelayed?: () => void): Promise<string> {
    const query: RecoveryQuery = {reader, sessionId, operationId, signal, observing, queryDelayed};
    for (;;) {
        signal.throwIfAborted(); const round = await readQuery(query);
        if (round === null) {await pause(signal); continue;}
        const text = completedResponse(round); if (text !== undefined) return text;
        if (!round && !isObserving(observing) && Date.now() - started >= 30_000) throw fail('TEXT_RESULT_UNCONFIRMED');
        await pause(signal);
    }
}
function isObserving(value: RecoveryQuery['observing']): boolean {return typeof value === 'function' ? value() : value;}
function pendingQuery(query: RecoveryQuery): Promise<SessionResponse | undefined> {
    const request = query.pending ??= Promise.resolve().then(() => query.reader.sessionResponse(query.sessionId, {operationId: query.operationId, branch: 'main'}));
    const release = () => {if (query.pending === request) query.pending = undefined;};
    void request.then(release, release); return request;
}
async function readQuery(query: RecoveryQuery): Promise<SessionResponse | undefined | null> {
    const started = Date.now();
    try {return await cancellable(pendingQuery(query), query.signal);} catch (error) {
        if (query.signal.aborted) throw error;
        const retrying = isObserving(query.observing);
        if (!retrying || query.reportedAt === undefined || Date.now() - query.reportedAt >= 15000) {
            reportResultQuery(query.reader, query.sessionId, query.operationId, error, Date.now() - started, retrying);
            query.reportedAt = Date.now(); query.queryDelayed?.();
        }
        if (!retrying) throw resultQueryFailure(error); return null;
    }
}
function completedResponse(round: SessionResponse | undefined): string | undefined {
    if (round && ['failed', 'cancelled'].includes(round.status)) throw fail(round.status === 'cancelled' ? 'TEXT_CANCELLED' : 'TEXT_SESSION_FAILED');
    if (round?.status !== 'completed') return undefined;
    const text = round.text.trim(); if (!text) throw fail('TEXT_OUTPUT_EMPTY'); return text;
}
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = () => {clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason);};
        const timer = setTimeout(() => {signal.removeEventListener('abort', cancel); reject(fail('TEXT_RESULT_QUERY_TIMEOUT'));}, 10_000);
        signal.addEventListener('abort', cancel, {once: true});
        work.then(resolve, error => reject(resultQueryFailure(error))).finally(() => {clearTimeout(timer); signal.removeEventListener('abort', cancel);});
        if (signal.aborted) cancel();
    });
}
function pause(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const cancel = () => {clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason);};
        const timer = setTimeout(() => {signal.removeEventListener('abort', cancel); resolve();}, 1000);
        signal.addEventListener('abort', cancel, {once: true}); if (signal.aborted) cancel();
    });
}
