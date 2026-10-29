import {createModuleLogger, randomUUID} from '@itookit/common';
import type {CallTargetCatalog, CallTargetRef, ChatView, ComposerDraft} from '@itookit/llm-ui';

/** Restore the next input preference; frozen operations and structured inputs retain their original versions. */
export function restoreDraftTarget(draft: ComposerDraft, catalog?: CallTargetCatalog,
    previous?: CallTargetRef, agentId?: string): ComposerDraft {
    if (!catalog || catalog.loading || catalog.error) return draft;
    const preferred = draft.target ?? previous;
    const choice = preferred
        ? catalog.entries.find(entry => entry.target.kind === preferred.kind && entry.target.id === preferred.id)
        : agentId ? catalog.entries.find(entry => entry.target.kind === 'agent' && entry.target.id === agentId) : catalog.entries.find(entry => entry.target.kind === 'agent' && !entry.inputContract);
    if (draft.target) {
        const target = draft.target;
        if (!choice || draft.input || draft.context?.value != null) return draft;
        if (choice.target.version === target.version && choice.target.digest === target.digest) return draft;
    }
    const target = choice?.target ?? preferred;
    return target ? {...draft, target: {...target}} : draft;
}

/** Refresh an unconfirmed preference after directory changes, without modifying frozen operations. */
export function refreshDraftTarget(view: ChatView | undefined, catalog?: CallTargetCatalog): boolean {
    if (!view || view.inputBusy) return false;
    const draft = view.getDraft();
    if (!draft.target) return false;
    const restored = restoreDraftTarget(draft, catalog);
    if (restored === draft) return false;
    const started = Date.now();
    view.configureInput({target: restored.target}, draft.revision);
    createModuleLogger('chat-target').info('chat.target.restore', {operationId: randomUUID(), stage: 'catalog-refresh', result: 'success',
        code: 'UNCONFIRMED_TARGET_REFRESHED', durationMs: Date.now() - started, kind: restored.target?.kind,
        previousVersion: draft.target.version, version: restored.target?.version});
    return true;
}
