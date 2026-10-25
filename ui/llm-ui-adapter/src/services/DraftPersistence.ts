import type {ConversationUIState} from '@itookit/llm-session/contracts';
import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {canonicalJson} from '../utils/canonical-json';
import {writeUIStateConditionally, type ConditionalUIRepository} from './conditional-ui-state';
export type BranchDraft = NonNullable<ConversationUIState['branchDrafts']>[string];
export interface DraftConflict {readonly id: string; readonly branch: string; readonly saved?: BranchDraft}
const log = createModuleLogger('workspace-draft-store');

/** Baselines belong to one editor; only the Session record is authoritative. */
export class DraftPersistence {
    private readonly baselines = new Map<string, BranchDraft | undefined>();
    private readonly conflicts = new Map<string, DraftConflict>();
    private readonly listeners = new Set<() => void>();
    constructor(private readonly repository: ConditionalUIRepository) {}
    subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => this.listeners.delete(listener);}
    observe(sessionId: string, branch: string, state?: ConversationUIState): void {
        const key = this.key(sessionId, branch);
        this.baselines.set(key, structuredClone(readBranchDraft(state, branch))); this.conflicts.delete(key); this.notify();
    }
    getConflict(sessionId: string, branch: string): DraftConflict | undefined {return structuredClone(this.conflicts.get(this.key(sessionId, branch)));}
    async save(sessionId: string, branch: string, patch: ConversationUIState, replaceId?: string): Promise<void> {
        const key = this.key(sessionId, branch), proposed = structuredClone(patch), operationId = randomUUID(), started = Date.now();
        const conflict = this.conflicts.get(key);
        if (!this.baselines.has(key)) throw draftFailure('DRAFT_BASELINE_UNAVAILABLE');
        if (replaceId && conflict?.id !== replaceId) throw draftFailure('DRAFT_RESOLUTION_CHANGED');
        const expected = structuredClone(replaceId ? conflict?.saved : this.baselines.get(key));
        const saved = await writeUIStateConditionally(this.repository, sessionId, state => {
            const current = readBranchDraft(state, branch), next = proposed.branchDrafts?.[branch];
            if (sameDraft(current, next)) return {value: structuredClone(current)};
            if (!sameDraft(current, expected)) {this.recordConflict(key, branch, current); throw draftFailure('SESSION_DRAFT_CONFLICT');}
            return {value: structuredClone(next), patch: proposed};
        }, {unavailable: () => draftFailure('DRAFT_STORE_UNAVAILABLE'), conflict: () => draftFailure('DRAFT_SAVE_CONFLICT'),
            report: (stage, attempt, error) => report(operationId, started, stage, attempt, error)});
        this.baselines.set(key, saved); this.conflicts.delete(key); this.notify();
    }
    private recordConflict(key: string, branch: string, saved?: BranchDraft): void {
        const previous = this.conflicts.get(key);
        if (!previous || !sameDraft(previous.saved, saved)) this.conflicts.set(key, {id: randomUUID(), branch, saved: structuredClone(saved)});
        this.notify();
    }
    private key(sessionId: string, branch: string): string {return JSON.stringify([sessionId, branch]);}
    private notify(): void {for (const listener of this.listeners) {try {listener();} catch { /* Observers cannot change persisted facts. */ }}}
}
export function readBranchDraft(state: ConversationUIState | undefined, branch: string): BranchDraft | undefined {
    const drafts = state?.branchDrafts;
    if (drafts !== undefined && (!drafts || typeof drafts !== 'object' || Array.isArray(drafts))) throw draftFailure('DRAFT_BASELINE_INVALID');
    const value = drafts?.[branch];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
        || value.inputText !== undefined && typeof value.inputText !== 'string')) throw draftFailure('DRAFT_BASELINE_INVALID');
    return value;
}
function sameDraft(left?: BranchDraft, right?: BranchDraft): boolean {return canonicalJson(left) === canonicalJson(right);}
export function draftFailure(code: string): Error {
    const key = code === 'SESSION_DRAFT_CONFLICT' ? 'chatInput.draft.conflict'
        : code === 'DRAFT_BASELINE_UNAVAILABLE' ? 'chatInput.draft.notLoaded' : code === 'DRAFT_BASELINE_INVALID' ? 'chatInput.draft.invalid'
        : code === 'DRAFT_SAVE_CONFLICT' ? 'chatInput.draft.busy' : code === 'DRAFT_RESOLUTION_CHANGED' ? 'chatInput.draft.changed' : code === 'DRAFT_STORE_UNAVAILABLE' ? 'chatInput.draft.unavailable' : 'chatInput.draft.saveFailed';
    return Object.assign(new Error(t(key)), {code});
}
function report(operationId: string, started: number, stage: string, attempt: number, error?: unknown): void {
    const raw = (error as {code?: unknown})?.code;
    const metadata = {operation: 'workspace.draft.save', operationId, stage, attempt, result: error ? 'failure' : 'success',
        durationMs: Date.now() - started, code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : error ? 'DRAFT_SAVE_FAILED' : undefined};
    try {if (error) log.warn('Input draft persistence', metadata); else log.debug('Input draft persistence', metadata);}
    catch { /* Logging cannot overwrite another editor's draft or mask the original failure. */ }
}
