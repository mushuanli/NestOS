import type {ComposerArgumentDraft} from '@itookit/llm-ui';
import {isTargetRef, sameTargetRef, type TargetRef} from '@itookit/llm-flow/contracts';
import {t} from '@itookit/common';

/** JSON remains the sole parameter draft; composerText records the basis used to prefill it. */
export interface WorkspaceArgumentDraft extends ComposerArgumentDraft {readonly target?: TargetRef; readonly composerText?: string;}

export function readInputDraft(value: unknown): WorkspaceArgumentDraft | undefined {
    if (value === undefined) return;
    const draft = value as WorkspaceArgumentDraft;
    if (!validDraftShape(draft) || !validDraftSignature(draft.signature) || !validDraftScope(draft))
        throw Object.assign(new Error(t('callable.input.invalidDraft')), {code: 'CALL_INPUT_DRAFT_INVALID'});
    return structuredClone(draft);
}
function validDraftShape(draft: WorkspaceArgumentDraft): boolean {
    return !!draft && Number.isSafeInteger(draft.revision) && draft.revision >= 0 && typeof draft.json === 'string'
        && typeof draft.targetId === 'string' && !!draft.targetId;
}
function validDraftSignature(signature: WorkspaceArgumentDraft['signature']): boolean {
    return !!signature && typeof signature.id === 'string' && Number.isSafeInteger(signature.revision) && signature.revision >= 1 && typeof signature.digest === 'string';
}
function validDraftScope(draft: WorkspaceArgumentDraft): boolean {
    return (draft.target === undefined || isTargetRef(draft.target)) && (draft.composerText === undefined || typeof draft.composerText === 'string');
}

export function sameInputDraft(left?: WorkspaceArgumentDraft, right?: WorkspaceArgumentDraft): boolean {
    if (!left || !right) return left === right;
    return left.revision === right.revision && left.targetId === right.targetId && left.json === right.json && left.composerText === right.composerText
        && sameTargetRef(left.target, right.target) && left.signature.id === right.signature.id
        && left.signature.revision === right.signature.revision && left.signature.digest === right.signature.digest;
}
