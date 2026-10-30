import type {ClientDiagnostic} from '@itookit/app-contracts/services';

const identity = /^[a-zA-Z0-9_-]{1,160}$/;
const label = /^[a-z][a-z0-9.-]{0,63}$/;
const code = /^[A-Z][A-Z0-9_]{0,79}$/;
const tokens = {operation: label, operationId: identity, sessionId: identity, stage: label, code, remoteCode: code, requestId: identity};
const required = new Set(['operation', 'operationId', 'stage', 'code']);
const allowed = new Set([...Object.keys(tokens), 'result', 'durationMs']);

/** Rebuild an allowlisted record before it reaches the host runtime log. */
export function reportClientDiagnostic(value: ClientDiagnostic): void {
    const record = value as unknown as Record<string, unknown>;
    if (!record || typeof record !== 'object' || Object.keys(record).some(key => !allowed.has(key)) || !validTokens(record) || !validOutcome(record))
        throw Object.assign(new Error('Invalid client diagnostic metadata'), {code: 'CLIENT_DIAGNOSTIC_INVALID'});
    console.warn('[ClientDiagnostic]', {source: 'client', operation: value.operation, operationId: value.operationId,
        sessionId: value.sessionId, stage: value.stage, code: value.code, result: value.result, durationMs: value.durationMs,
        remoteCode: value.remoteCode, requestId: value.requestId});
}
function validTokens(record: Record<string, unknown>): boolean {
    return Object.entries(tokens).every(([key, pattern]) => record[key] === undefined ? !required.has(key)
        : typeof record[key] === 'string' && pattern.test(record[key] as string));
}
function validOutcome(record: Record<string, unknown>): boolean {
    return (record.result === 'retrying' || record.result === 'failure') && typeof record.durationMs === 'number'
        && Number.isFinite(record.durationMs) && record.durationMs >= 0 && record.durationMs <= 86400000;
}
