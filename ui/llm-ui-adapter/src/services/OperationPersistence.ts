import {mergeOperationRecords, type OperationRecord} from '@itookit/llm-ui';
import type {ISessionRepository} from '@itookit/llm-session/contracts';
import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {canonicalJson} from '../utils/canonical-json';
const log = createModuleLogger('workspace-operation-store');
type Repository = Pick<ISessionRepository, 'getManifest' | 'compareAndSetUIState'>;

/** UI owns merge policy; Session supplies only an atomic revision condition on opaque data. */
export async function persistOperations(repository: Repository, sessionId: string, incoming: readonly OperationRecord[]): Promise<readonly OperationRecord[]> {
    const proposed = structuredClone(incoming), operationId = randomUUID(), started = Date.now(); let stage = 'read', attempt = 0;
    try {
        if (!repository.compareAndSetUIState) throw failure('OPERATION_STORE_UNAVAILABLE');
        readRecords(proposed, sessionId);
        for (; attempt < 8; attempt++) {
            stage = 'read'; const snapshot = await repository.getManifest(sessionId);
            if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision! < 0) throw failure('OPERATION_STORE_UNAVAILABLE');
            stage = 'merge'; const stored = readRecords(snapshot.uiState?.operationRecords, sessionId), merged = mergeOperationRecords(stored, proposed);
            if (sameRecords(stored, merged)) {report(operationId, started, 'confirmed', attempt); return merged;}
            stage = 'conditional-write';
            try {await repository.compareAndSetUIState(sessionId, snapshot.revision!, {operationRecords: JSON.parse(JSON.stringify(merged))});}
            catch (error) {
                if ((error as {code?: unknown})?.code === 'SESSION_UI_STATE_CONFLICT') continue;
                stage = 'write-receipt'; const confirmed = await confirmWrite(repository, sessionId, proposed);
                if (confirmed) {report(operationId, started, stage, attempt); return confirmed;}
                throw error;
            }
            report(operationId, started, stage, attempt); return merged;
        }
        throw failure('OPERATION_SAVE_CONFLICT');
    } catch (error) {report(operationId, started, stage, attempt, error); throw error;}
}
async function confirmWrite(repository: Repository, sessionId: string, proposed: readonly OperationRecord[]): Promise<readonly OperationRecord[] | undefined> {
    try {
        const stored = readRecords((await repository.getManifest(sessionId)).uiState?.operationRecords, sessionId);
        return sameRecords(stored, mergeOperationRecords(stored, proposed)) ? structuredClone(stored) : undefined;
    } catch {return;}
}
function readRecords(value: unknown, sessionId: string): readonly OperationRecord[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(record => !record || record.conversationId !== sessionId)) throw failure('OPERATION_RECORD_INVALID');
    return value;
}
function sameRecords(left: readonly OperationRecord[], right: readonly OperationRecord[]): boolean {return canonicalJson(left) === canonicalJson(right);}
function failure(code: 'OPERATION_STORE_UNAVAILABLE' | 'OPERATION_SAVE_CONFLICT' | 'OPERATION_RECORD_INVALID'): Error {
    const key = code === 'OPERATION_STORE_UNAVAILABLE' ? 'callable.submission.storeUnavailable'
        : code === 'OPERATION_SAVE_CONFLICT' ? 'callable.submission.storeConflict' : 'callable.submission.invalidLedger';
    return Object.assign(new Error(t(key)), {code});
}
function report(operationId: string, started: number, stage: string, attempt: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const data = {operation: 'workspace.operations.save', operationId, stage, attempt, result: error ? 'failure' : 'success',
        durationMs: Date.now() - started, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : error ? 'OPERATION_STORE_FAILED' : undefined};
    try {if (error) log.warn('Operation journal persistence', data); else log.debug('Operation journal persistence', data);}
    catch { /* Logging cannot acknowledge an uncommitted operation or hide the original error. */ }
}
