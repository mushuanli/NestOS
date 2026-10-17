import { t, type NavigationRequest } from '@itookit/common';
import type { ApplicationBackend } from '@itookit/app-contracts/services';
import type { EditorFileReference, EditorHostContext } from '@itookit/ui-common';

/** Store the quote before mounting chat, so a later reopen also restores the draft. */
export function createFileChatHandler(backend: Pick<ApplicationBackend, 'createSessionDraft'>,
    navigate: (request: NavigationRequest) => Promise<void>): NonNullable<EditorHostContext['chatFromFile']> {
    return async (reference, association) => {
        const id = await backend.createSessionDraft({ title: reference.path.split('/').pop() || t('editor.ai.title'),
            inputText: quote(reference), source: association });
        await navigate({ target: 'chat', resourceId: id });
    };
}

function quote(reference: EditorFileReference): string {
    // A fence longer than any source run preserves embedded Markdown fences verbatim.
    const runs = reference.content.match(/`+/g) ?? [];
    const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
    const scope = t(reference.selection ? 'editor.ai.selection' : 'editor.ai.file');
    return `${scope}: ${reference.path.replace(/[\r\n]/g, ' ')}\n\n${fence}\n${reference.content}\n${fence}\n\n`;
}
