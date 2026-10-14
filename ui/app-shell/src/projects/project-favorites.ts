import { resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectFavoriteTarget, ProjectService } from '@itookit/app-contracts/services';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { FavoriteAction, VFSNodeUI } from '@itookit/vfs-ui';

type FavoriteRoute = Extract<ReturnType<typeof resolveBrowserTarget>, { kind: 'project-files' | 'session' | 'favorite' | 'remote' }>;

/** Translate generic row controls into project commands; refresh is driven by service events. */
export function projectFavoriteAction(projects: ProjectService, repository: ISessionRepository): FavoriteAction {
    return {
        state: node => {
            const target = favoriteRoute(node.id);
            if (!target) return undefined;
            return target.kind === 'favorite' || !!node.metadata.custom._favorite;
        },
        toggle: async node => {
            const target = favoriteRoute(node.id);
            if (target) await toggleFavorite(projects, repository, target, node);
        },
    };
}
function favoriteRoute(path: string): FavoriteRoute | undefined {
    try {
        const target = resolveBrowserTarget(path);
        if (target.kind === 'project-files' || target.kind === 'session' || target.kind === 'favorite') return target;
        if (target.kind === 'remote' && target.profileId && target.nativeSessionId) return target;
    } catch { /* Other workspaces use different resource routes. */ }
}
async function toggleFavorite(projects: ProjectService, repository: ISessionRepository, target: FavoriteRoute, node: VFSNodeUI): Promise<void> {
    const folder = target.kind === 'session' ? (await repository.getManifest(target.sessionId)).folder : target.folder;
    const project = await projects.forFolder(folder);
    if (!project) return;
    if (target.kind === 'favorite') return projects.favorites.remove(project.project.id, target.favoriteId);
    if (target.kind === 'remote') {
        const root = projects.remoteMounts?.list(project.project.id).find(m => m.at === '/');
        if (!root?.connectionId || !root.serverId || !root.serverProjectId) return;
        await projects.favorites.toggle(project.project.id, {kind: 'remote-session', connectionId: root.connectionId, serverId: root.serverId,
            serverProjectId: root.serverProjectId, profileId: target.profileId!, sessionId: target.nativeSessionId!, archived: target.archived}, node.metadata.title); return;
    }
    const favorite: ProjectFavoriteTarget = target.kind === 'project-files'
        ? { kind: 'file', path: target.path, nodeType: node.type } : { kind: 'session', sessionId: target.sessionId };
    await projects.favorites.toggle(project.project.id, favorite, node.metadata.title);
}
