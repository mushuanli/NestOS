import { FSError } from '@itookit/vfs-core';
import { folderBrowserPath, remoteSessionPath } from '../../session/browser-routes';
import { projectRelativePath } from '../../vfs/workspace-namespace';
import type { ISessionRepository } from '@itookit/llm-session';
import type { ProjectService } from '@itookit/app-contracts/services';

export interface ResolvedProjectFavorite { path: string; kind: 'file' | 'directory' | 'session' }

export async function resolveProjectFavorite(projects: Pick<ProjectService, 'forFolder' | 'favorites' | 'remoteMounts'>, repository: Pick<ISessionRepository, 'getManifest'>,
    folder: string, id: string): Promise<ResolvedProjectFavorite> {
    const project = await projects.forFolder(folder);
    if (!project || project.path !== folder) throw new FSError('ENOENT', 'Favorite project not found');
    const favorite = (await projects.favorites.list(project.project.id)).find(item => item.id === id);
    if (!favorite) throw new FSError('ENOENT', 'Favorite not found');
    if (favorite.target.kind === 'remote-session') {
        const target = favorite.target, mount = projects.remoteMounts?.list(project.project.id).find(m => m.at === '/');
        if (mount?.connectionId !== target.connectionId || mount.serverId !== target.serverId || mount.serverProjectId !== target.serverProjectId)
            throw new FSError('ECONFLICT', 'Remote favorite binding is no longer available');
        return {kind: 'session', path: remoteSessionPath(project.path, target.profileId, target.sessionId, target.archived)};
    }
    if (favorite.target.kind === 'file') return { kind: favorite.target.nodeType, path: folderBrowserPath(project.path) + '/@files'
        + (favorite.target.path === '/workspace' ? '' : projectRelativePath(favorite.target.path)) };
    const session = await repository.getManifest(favorite.target.sessionId);
    if ((await projects.forFolder(session.folder))?.project.id !== project.project.id) throw new FSError('ENOENT', 'Favorite session left this project');
    return { kind: 'session', path: `${folderBrowserPath(session.folder)}/${session.id}` };
}
