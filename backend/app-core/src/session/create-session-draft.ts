import {createModuleLogger} from '@itookit/common';
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
    const folderPath = await projects.sessionFolder(project);
    if (request.sessionId) return ensureDraft(repository, request, folderPath);
    return repository.createSession(request.title, folderPath, null,
        { branchDrafts: { main: { inputText: request.inputText } } });
}

async function ensureDraft(repository: ISessionRepository, request: SessionDraftRequest, folder: string): Promise<string> {
    const id = request.sessionId!, branch = request.branchName ?? 'main', started = Date.now();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(branch))
        throw new FSError('EINVAL', 'Invalid draft identity or branch name');
    await repository.ensureSession(id, request.title, 'web', folder, null);
    const manifest = await repository.getManifest(id);
    if (manifest.folder !== folder) throw new FSError('ECONFLICT', 'Draft belongs to another project');
    if (Object.hasOwn(manifest.branches, branch)) return id;
    if (manifest.rootRoundId !== null) throw new FSError('ECONFLICT', 'Draft already contains history');
    await repository.updateManifest(id, {branches: {...manifest.branches, [branch]: null}, currentBranch: branch, currentHead: null,
        branchMeta: {...manifest.branchMeta, [branch]: {createdAt: Date.now(), createdFrom: 'manual', forkedFromBranch: manifest.currentBranch, branchRootRoundId: ''}},
        uiState: {...manifest.uiState, branchDrafts: {...manifest.uiState?.branchDrafts, [branch]: {inputText: request.inputText}}}});
    createModuleLogger('session-draft').info('draft.branch', {operationId: id, sessionId: id, stage: 'branch-create', result: 'success', durationMs: Date.now() - started});
    return id;
}
