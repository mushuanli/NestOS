import {createModuleLogger} from '@itookit/common';
import type {ApplicationBackend, ClientDiagnostic} from '@itookit/app-contracts/services';

export function resultQueryFailure(error: unknown): Error & {code: string; remoteCode?: string; requestId?: string} {
    const source = error as {code?: unknown; remoteCode?: unknown; requestId?: unknown; name?: unknown};
    const code = typeof source?.code === 'string' && /^TEXT_RESULT_QUERY_[A-Z_]+$/.test(source.code) ? source.code
        : source?.code === 'ECAPABILITY' ? 'TEXT_RESULT_QUERY_CAPABILITY_UNAVAILABLE'
        : typeof source?.code === 'string' ? 'TEXT_RESULT_QUERY_REJECTED' : 'TEXT_RESULT_QUERY_TRANSPORT_FAILED';
    const remote = source?.remoteCode ?? (typeof source?.code === 'string' && source.code.startsWith('TEXT_RESULT_QUERY_') ? undefined : source?.code);
    return Object.assign(new Error(code), {code,
        remoteCode: typeof remote === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(remote) ? remote : undefined,
        requestId: typeof source?.requestId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(source.requestId) ? source.requestId : undefined});
}
export function reportResultQuery(reader: Partial<Pick<ApplicationBackend, 'reportClientDiagnostic'>>, sessionId: string, operationId: string, error: unknown, durationMs: number, retrying: boolean): void {
    const failure = resultQueryFailure(error);
    const diagnostic: ClientDiagnostic = {operation: 'text.result', sessionId, operationId,
        stage: failure.code === 'TEXT_RESULT_QUERY_TIMEOUT' ? 'query-wait' : 'query-request', code: failure.code,
        result: retrying ? 'retrying' : 'failure', durationMs, remoteCode: failure.remoteCode, requestId: failure.requestId};
    createModuleLogger('study-generation').warn('text.query', diagnostic);
    try {void reader.reportClientDiagnostic?.(diagnostic).catch(() => {});} catch { /* Diagnostics never replace the generation result. */ }
}
