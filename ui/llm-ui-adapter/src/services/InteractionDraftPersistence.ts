import {createModuleLogger} from '@itookit/common';
import type {ConversationUIState} from '@itookit/llm-session/contracts';
import type {InteractionDraftContent, InteractionDraftRecord, InteractionDraftScope, InteractionDraftStorage, InteractionDraftWrite} from '../domain/interaction-draft';
import {writeUIStateConditionally, type ConditionalUIRepository} from './conditional-ui-state';
import {canonicalJson} from '../utils/canonical-json';

const log = createModuleLogger('interaction-draft-store');
/** Merge policy belongs to the UI host; Session supplies the existing manifest CAS. */
export class InteractionDraftPersistence implements InteractionDraftStorage {
    constructor(private repository: ConditionalUIRepository) {}
    async read(supplied: InteractionDraftScope): Promise<InteractionDraftRecord | undefined> {
        const started = Date.now(); let outcome = 'failure', code: string | undefined;
        try {const scope = structuredClone(supplied), key = scopeKey(scope), result = readRecord((await this.repository.getManifest(scope.sessionId)).uiState, key); outcome = 'success'; return result;}
        catch (error) {code = errorCode(error); throw error;}
        finally {report('read', supplied, undefined, started, {stage: 'read', outcome, code});}
    }
    async write(supplied: InteractionDraftWrite): Promise<InteractionDraftRecord> {
        const started = Date.now(); let change: InteractionDraftWrite, key: string;
        try {change = structuredClone(supplied); key = scopeKey(change?.scope); validateWrite(change);}
        catch (error) {report('write', supplied?.scope, supplied?.editId, started, {stage: 'validate', outcome: 'failure', code: errorCode(error)}); throw error;}
        return writeUIStateConditionally(this.repository, change.scope.sessionId, state => {
            const previous = readRecord(state, key);
            const proposed: InteractionDraftRecord = {revision: (change.expectedRevision ?? 0) + 1, editId: change.editId, content: change.content};
            if (previous?.editId === change.editId) {
                if (canonicalJson(previous) !== canonicalJson(proposed)) throw failure('INTERACTION_DRAFT_IDENTITY_CONFLICT');
                return {value: previous};
            }
            if ((previous?.revision ?? null) !== change.expectedRevision) throw failure('INTERACTION_DRAFT_CONFLICT');
            return {value: proposed, patch: {interactionDrafts: {...state?.interactionDrafts, [key]: JSON.parse(JSON.stringify(proposed))}}};
        }, {unavailable: () => failure('INTERACTION_DRAFT_STORE_UNAVAILABLE'), conflict: () => failure('INTERACTION_DRAFT_SAVE_CONFLICT'),
            report: (stage, attempt, error) => report('write', change.scope, change.editId, started, {stage, attempt, outcome: error ? 'failure' : 'success', code: error && errorCode(error)})});
    }
}
function scopeKey(scope: InteractionDraftScope): string {
    const keys = ['sessionId', 'branchId', 'callId', 'executionSessionId', 'taskId', 'targetTaskId', 'interactionId'] as const;
    if (!scope || keys.some(key => typeof scope[key] !== 'string' || !scope[key].trim())
        || !Number.isFinite(scope.requestedAt) || scope.requestedAt < 0 || Object.keys(scope).some(key => ![...keys, 'requestedAt'].includes(key)))
        throw failure('INTERACTION_DRAFT_SCOPE_INVALID');
    return JSON.stringify([...keys.map(key => scope[key]), scope.requestedAt]);
}
function validateWrite(change: InteractionDraftWrite): void {
    if (!change || typeof change.editId !== 'string' || !change.editId.trim() || change.editId.length > 256
        || change.expectedRevision !== null && (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 1 || change.expectedRevision >= Number.MAX_SAFE_INTEGER)
        || !validContent(change.content) || Object.keys(change).some(key => !['scope', 'expectedRevision', 'editId', 'content'].includes(key)))
        throw failure('INTERACTION_DRAFT_INVALID');
}
function readRecord(state: ConversationUIState | undefined, key: string): InteractionDraftRecord | undefined {
    const records = state?.interactionDrafts;
    if (records !== undefined && (!records || typeof records !== 'object' || Array.isArray(records))) throw failure('INTERACTION_DRAFT_RECORD_INVALID');
    const record = records?.[key] as unknown as InteractionDraftRecord | undefined;
    if (record === undefined) return;
    if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.editId !== 'string' || !record.editId.trim() || record.editId.length > 256
        || !validContent(record.content) || Object.keys(record).some(key => !['revision', 'editId', 'content'].includes(key))) throw failure('INTERACTION_DRAFT_RECORD_INVALID');
    return structuredClone(record);
}
function validContent(value: unknown): value is InteractionDraftContent | null {
    if (value === null) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const content = value as InteractionDraftContent;
    return ['text', 'json'].includes(content.format) && !!content.values && typeof content.values === 'object' && !Array.isArray(content.values)
        && (Object.getPrototypeOf(content.values) === Object.prototype || Object.getPrototypeOf(content.values) === null)
        && (content.note === undefined || typeof content.note === 'string') && Object.keys(content).every(key => ['format', 'values', 'note'].includes(key))
        && Object.values(content.values).every(item => typeof item === 'string' || Array.isArray(item) && Array.from(item).every(value => typeof value === 'string'));
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function errorCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'INTERACTION_DRAFT_STORE_FAILED';
}
function report(operation: string, scope: InteractionDraftScope, editId: string | undefined, started: number, result: Record<string, unknown>): void {
    const safe = (value: unknown) => typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;
    const detail = {operation: `interaction.draft.${operation}`, operationId: safe(editId), sessionId: safe(scope?.sessionId),
        callId: safe(scope?.callId), taskId: safe(scope?.targetTaskId), ...result, durationMs: Date.now() - started};
    try {if (result.outcome === 'failure') log.warn('Interaction draft persistence', detail); else log.debug('Interaction draft persistence', detail);}
    catch { /* Diagnostics never acknowledge a draft that was not saved. */ }
}
