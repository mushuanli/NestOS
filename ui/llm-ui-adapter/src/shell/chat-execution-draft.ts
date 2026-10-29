import {t} from '@itookit/common';
import type {ChatView, ComposerDraft} from '@itookit/llm-ui';
import type {EditorOptions} from '@itookit/ui-common';

/** The host owns cross-executor navigation; input is copied without consuming the current draft. */
export function mountExecutionDraftAction(root: HTMLElement, options: EditorOptions, view: () => ChatView | undefined,
    readFiles: (draft: ComposerDraft) => Promise<File[]>, available: () => boolean, report: (error: unknown) => void): () => void {
    if (!options.onStartConversationDraft) return () => {};
    const control = document.createElement('button'); control.type = 'button';
    control.textContent = t('chatInput.switchTarget'); control.title = t('chatInput.switchTargetHint');
    control.onclick = () => {void transfer().catch(report);}; root.append(control);
    async function transfer(): Promise<void> {
        const current = view(); if (!current || !available() || current.inputBusy) throw new Error(t('chatInput.switchUnavailable'));
        const draft = current.getDraft(); control.disabled = true;
        try {
            await current.flushDraft(); const files = await readFiles(draft);
            if (!available() || current !== view()) throw new Error(t('chatInput.switchUnavailable'));
            await options.onStartConversationDraft!({text: draft.text, files});
        } finally {control.disabled = false;}
    }
    return () => {control.onclick = null; control.remove();};
}
