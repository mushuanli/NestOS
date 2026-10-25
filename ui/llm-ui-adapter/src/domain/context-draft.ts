import {assertConversationSelection, type ConversationSelection} from '@itookit/kernel-adapters/contracts';
import {isTargetRef, sameTargetRef, type TargetRef} from '@itookit/llm-flow/contracts';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import {t} from '@itookit/common';

export type InputConversationSelection = Extract<ConversationSelection, {mode: 'new' | 'fork'}>;
/** UI revisions and scope are recovery evidence, never executable call arguments. */
export interface InputContextDraft {
    readonly revision: number;
    readonly sessionId: string;
    readonly branchId: string;
    readonly target: TargetRef;
    readonly selection: InputConversationSelection;
}

export function readInputContextDraft(value: unknown): InputContextDraft | undefined {
    if (value === undefined) return;
    const draft = value as InputContextDraft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw invalid();
    if (!validShape(draft)) throw invalid();
    try {assertConversationSelection(draft.selection);} catch {throw invalid();}
    return structuredClone(draft);
}

export function sameInputContextDraft(left?: InputContextDraft, right?: InputContextDraft): boolean {
    if (!left || !right) return left === right;
    return left.revision === right.revision && left.sessionId === right.sessionId && left.branchId === right.branchId
        && sameTargetRef(left.target, right.target) && sameContextSelection(left.selection, right.selection);
}

export function sameContextSelection(left?: ConversationSelection, right?: ConversationSelection): boolean {
    if (!left || !right) return left === right;
    if (left.mode !== right.mode || left.mode === 'continue') return false;
    return JSON.stringify(selectionIdentity(left)) === JSON.stringify(selectionIdentity(right));
}

export function contextDraftMatchesRequest(draft: InputContextDraft | undefined, request: SubmissionRequest): boolean {
    if (!draft) return request.overrides?.harnessConversation === undefined;
    return draft.sessionId === request.expectedSessionId && draft.branchId === request.expectedBranch
        && sameTargetRef(draft.target, request.expectedTarget) && sameContextSelection(draft.selection, request.overrides?.harnessConversation);
}

export function canConsumeContextDraft(evidence: unknown, captured: InputContextDraft | undefined,
    current: InputContextDraft | undefined, request: SubmissionRequest): boolean {
    let frozen: InputContextDraft | undefined;
    try {frozen = readInputContextDraft(evidence);} catch {return false;}
    return sameInputContextDraft(frozen, captured) && sameInputContextDraft(captured, current) && contextDraftMatchesRequest(frozen, request);
}

export function sameContextDraftEvidence(evidence: unknown, current?: InputContextDraft): boolean {
    try {return sameInputContextDraft(readInputContextDraft(evidence), readInputContextDraft(current));}
    catch {return false;}
}

export function prepareInputContextDraft(value: unknown, scope: {sessionId: string; branchId?: string; target?: TargetRef},
    selection?: ConversationSelection): InputContextDraft | undefined {
    const draft = readInputContextDraft(value);
    if (!draft) return;
    if (draft.sessionId !== scope.sessionId || draft.branchId !== scope.branchId || !sameTargetRef(draft.target, scope.target))
        throw Object.assign(new Error(t('callable.context.scopeChanged')), {code: 'CONTEXT_DRAFT_SCOPE_CHANGED'});
    if (selection && !sameContextSelection(draft.selection, selection))
        throw Object.assign(new Error(t('callable.context.selectionChanged')), {code: 'CONTEXT_DRAFT_SELECTION_CHANGED'});
    return draft;
}

function validShape(draft: InputContextDraft): boolean {
    return Object.keys(draft).every(key => ['revision', 'sessionId', 'branchId', 'target', 'selection'].includes(key))
        && Number.isSafeInteger(draft.revision) && draft.revision >= 0 && reference(draft.sessionId) && reference(draft.branchId)
        && isTargetRef(draft.target) && ['new', 'fork'].includes(draft.selection?.mode);
}
function selectionIdentity(selection: ConversationSelection): unknown[] {
    if (selection.mode === 'new') return ['new', selection.seedContextRef];
    if (selection.mode === 'fork') return ['fork', selection.sourceBindingId, selection.expectedBindingRevision, selection.expectedGeneration, selection.checkpointRef];
    return [];
}

function reference(value: unknown): value is string {return typeof value === 'string' && !!value && value.length <= 4096;}
function invalid(): Error {return Object.assign(new Error(t('callable.context.invalidDraft')), {code: 'CONTEXT_DRAFT_INVALID'});}
