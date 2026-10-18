import { FSError } from '@itookit/vfs-core';
import { browserTargetFolder, folderBrowserPath, projectConversationsPath, resolveBrowserTarget } from '@itookit/app-contracts';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { ProjectNavigationRequest, ProjectNavigationView, ProjectService } from '@itookit/app-contracts/services';

/** Resolve organization beside storage; the frontend only consumes prepared navigation. */
export async function readProjectNavigation(projects: ProjectService,
    repository: Pick<ISessionRepository, 'getManifest'>, request: ProjectNavigationRequest): Promise<ProjectNavigationView> {
    const target = resolveBrowserTarget(request.path);
    const [snapshot, manifest] = await Promise.all([
        projects.sessions.navigation({ includeSessions: false }),
        'sessionId' in target ? readManifest(repository, target.sessionId) : undefined,
    ]);
    const choices = projects.listNavigation(snapshot.folders);
    const folder = browserTargetFolder(target, request.path, manifest?.folder);
    const project = request.projectId !== undefined ? choices.find(item => item.project.id === request.projectId)
        : choices.filter(item => folder === item.path || folder.startsWith(item.path + '/'))
            .sort((a, b) => b.path.length - a.path.length)[0];
    const path = 'sessionId' in target ? manifest ? `${folderBrowserPath(manifest.folder)}/${manifest.id}`
        : folderBrowserPath(project?.path) || '/' : request.path;
    return { path, project, projects: choices, sessionId: manifest?.id, pendingDeletions: snapshot.pending.length,
        offlineProjectIds: choices.filter(item => projects.remoteMounts?.projectOffline(item.project.id)).map(item => item.project.id),
        loadPaths: project ? [projectConversationsPath(project.path, {recent: true})] : [] };
}

async function readManifest(repository: Pick<ISessionRepository, 'getManifest'>, sessionId: string) {
    try { return await repository.getManifest(sessionId); }
    catch (error) { if (error instanceof FSError && error.code === 'ENOENT') return undefined; throw error; }
}
