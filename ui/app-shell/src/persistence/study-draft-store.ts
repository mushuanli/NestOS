import type {StudyCreation, StudyCreationState} from '@itookit/mdxeditor';
import {FileRecoveryStore} from './file-recovery-store';

/** Reuse authenticated per-user, per-tab recovery storage; no shared browser draft key. */
export function studyDraftStore(scope: string): NonNullable<StudyCreation['recovery']> {
    const store = new FileRecoveryStore(scope, '@study/creation');
    return {load: async signal => {
        signal.throwIfAborted(); const value = await store.read().catch(storageFailure); signal.throwIfAborted(); if (!value) return undefined;
        let draft: StudyCreationState;
        try {draft = JSON.parse(value.text);} catch {throw invalid();}
        if (!draft || draft.version !== 1 || ['draftId', 'title', 'source', 'prompt', 'content', 'generated'].some(key => typeof draft[key as keyof StudyCreationState] !== 'string')) throw invalid();
        if (draft.parent && (draft.parent.kind !== 'directory' || typeof draft.parent.id !== 'string' || typeof draft.parent.title !== 'string')) throw invalid();
        if (draft.tab && !['source', 'prompt', 'result'].includes(draft.tab)) throw invalid();
        if (['promptName', 'targetId', 'modelId', 'pendingOperationId'].some(key => draft[key as keyof StudyCreationState] !== undefined && typeof draft[key as keyof StudyCreationState] !== 'string')) throw invalid();
        if (draft.execution && (typeof draft.execution.label !== 'string' || typeof draft.execution.url !== 'string' || !draft.execution.url.startsWith('#/'))) throw invalid();
        return draft;
    }, save: state => store.write({base: 'study-creation-v1', text: JSON.stringify(state), savedAt: Date.now()}).catch(storageFailure), clear: () => store.clear().catch(storageFailure)};
}
function invalid(): Error {return Object.assign(new Error('Invalid creation recovery'), {code: 'STUDY_DRAFT_INVALID'});}
function storageFailure(error: unknown): never {
    const code = (error as {name?: string})?.name === 'QuotaExceededError' ? 'STUDY_DRAFT_QUOTA' : 'STUDY_DRAFT_STORAGE_UNAVAILABLE';
    throw Object.assign(new Error(code), {code});
}
