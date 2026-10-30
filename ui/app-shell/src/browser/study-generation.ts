import {sessionRoute} from '@itookit/app-contracts';
import {t, createModuleLogger} from '@itookit/common';
import type {ISessionRepository} from '@itookit/llm-session';
import type {ApplicationBackend} from '@itookit/app-contracts/services';
import type {StudyCreation} from '@itookit/mdxeditor';
import {recoverGenerationResult} from './generation-result-recovery';
import {sessionGenerationResult} from './session-generation-result';
/** Cancellation is an explicit remote operation; AbortSignal itself is never serialized. */
export function studyGeneration(backend: ApplicationBackend, repository: Pick<ISessionRepository, 'updateManifest'>): Pick<StudyCreation, 'generate' | 'resumeGeneration' | 'configurationUrl' | 'generationTargets' | 'generationSaved'> {
    const generated = new Set<string>();
    return {resumeGeneration: async request => {
        request.onExecution?.({label: t('editor.studyRecoveringResult'), url: '#/chat/' + encodeURIComponent(sessionRoute(request.draftId, 'main'))});
        const content = await recoverGenerationResult(backend, request.draftId, request.operationId, request.signal); generated.add(request.draftId); return content;
    }, generationSaved: async draft => {if (generated.has(draft.operationId)) {await repository.updateManifest(draft.operationId, {title: t('editor.studySessionTitle') + draft.title}); generated.delete(draft.operationId);}}, configurationUrl: '#/settings/connections', generationTargets: {list: async signal => {
        signal.throwIfAborted(); const models = await backend.listTextModels(); signal.throwIfAborted();
        return models.map(model => ({id: model.id, label: model.name, model: model.model, models: model.models.map(value => ({id:value.id,label:value.name})),
            disabled: !model.available, reason: model.reason, default: model.default}));
    }}, generate: createGenerator(backend, generated)};
}
function createGenerator(backend: ApplicationBackend, generated: Set<string>): NonNullable<StudyCreation['generate']> {
    return async request => {
        request.signal.throwIfAborted();
        const cancel = () => {if (request.signal.reason?.code !== 'STUDY_DRAFT_SUSPENDED') void backend.cancelTextGeneration(request.operationId).catch(() => {});};
        request.signal.addEventListener('abort', cancel, {once: true});
        try {
            const {operationId, prompt, source, previousDraft, targetId, modelId, draftId} = request;
            const title = t('editor.studySessionTitle') + (request.title || request.promptName || t('editor.studyCreate'));
            await backend.createSessionDraft({sessionId: draftId, title, inputText: ''});
            generated.add(draftId); request.signal.throwIfAborted();
            request.onExecution?.({label: t('editor.studySessionView') + ' · ' + title, url: '#/chat/' + encodeURIComponent(sessionRoute(draftId, 'main'))});
            const result = await sessionGenerationResult(backend, {sessionId: draftId, operationId, prompt, source, previousDraft, connectionId: targetId, modelId}, request.signal, () => {
                request.onExecution?.({label: t('editor.studyRecoveringResult'), url: '#/chat/' + encodeURIComponent(sessionRoute(draftId, 'main'))});
            });
            checkOutputNotice(backend, request);
            request.signal.throwIfAborted(); return result;
        } finally {request.signal.removeEventListener('abort', cancel);}
    };
}
function checkOutputNotice(backend: ApplicationBackend, request: Parameters<NonNullable<StudyCreation['generate']>>[0]): void {
    const {draftId, operationId} = request;
    void backend.sessionResponse?.(draftId, {operationId, branch: 'main'}).then(response => {
        if (!request.signal.aborted && response?.finishReason === 'length') request.onExecution?.({label: t('editor.studyOutputLimited'), url: '#/chat/' + encodeURIComponent(sessionRoute(draftId, 'main'))});
    }).catch(() => {
        createModuleLogger('study-generation').warn('text.history', {operationId, stage: 'read-finish-reason', result: 'failure', code: 'TEXT_HISTORY_UNAVAILABLE'});
        return undefined;
    });
}
