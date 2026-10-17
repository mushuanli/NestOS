import { FSError } from '@itookit/vfs-core';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { ProjectService, SessionDraftRequest } from '@itookit/app-contracts/services';

/** Persist the initial input with the identity before publishing a new conversation. */
export async function createSessionDraft(projects: ProjectService, repository: ISessionRepository,
    request: SessionDraftRequest): Promise<string> {
    const source = request.source;
    const folder = source?.projectFolder ?? (source?.sessionId ? (await repository.getManifest(source.sessionId)).folder : undefined);
    const owning = await projects.forFolder(folder);
    if ((source?.projectFolder !== undefined || folder != null) && !owning)
        throw new FSError('ENOENT', 'Source project no longer exists');
    const project = owning ?? await projects.personal();
    return repository.createSession(request.title, await projects.sessionFolder(project), null,
        { branchDrafts: { main: { inputText: request.inputText } } });
}
