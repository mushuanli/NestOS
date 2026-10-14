import { t, type NavigationRequest } from '@itookit/common';
import type { ProjectService } from '@itookit/app-contracts/services';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { EditorFileReference, EditorHostContext } from '@itookit/ui-common';

/** Store the quote before mounting chat, so a later reopen also restores the draft. */
export function createFileChatHandler(projects: ProjectService, repository: ISessionRepository,
    navigate: (request: NavigationRequest) => Promise<void>): NonNullable<EditorHostContext['chatFromFile']> {
    return async (reference, association) => {
        const folder = association?.projectFolder ?? (association?.sessionId
            ? (await repository.getManifest(association.sessionId)).folder : undefined);
        const owning = await projects.forFolder(folder);
        if (association?.projectFolder && !owning) throw new Error('Source project no longer exists');
        const project = owning ?? await projects.personal();
        const id = await projects.sessions.create(reference.path.split('/').pop() || t('editor.ai.title'),
            await projects.sessionFolder(project));
        await repository.updateUIState(id, { branchDrafts: { main: { inputText: quote(reference) } } });
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
