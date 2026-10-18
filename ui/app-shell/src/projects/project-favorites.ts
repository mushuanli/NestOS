import { resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectFavoriteTarget, ProjectService } from '@itookit/app-contracts/services';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { FavoriteAction, VFSNodeUI } from '@itookit/vfs-ui';
import type { FSNode } from '@itookit/vfs-core';

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
            if (target) await toggleFavorite(projects, repository, target, {type: node.type, title: node.metadata.title});
        },
    };
}
/** Directory rows can outnumber the sidebar preview and must not depend on its loaded nodes. */
export function directoryFavoriteAction(projects: ProjectService, repository: ISessionRepository, initial: FSNode[]) {
    const rows = new Map(initial.map(node => [node.path, node])), cache = new Map<string, boolean>();
    const state = (id: string) => {
        const row = rows.get(id), target = favoriteRoute(id);
        return cache.get(id) ?? (row && target ? target.kind === 'favorite' || !!row.metadata._favorite : undefined);
    };
    return {state, update: (nodes: FSNode[]) => {rows.clear(); cache.clear(); for (const node of nodes) rows.set(node.path, node);},
        toggle: async (id: string) => {
            const row = rows.get(id), target = favoriteRoute(id), before = state(id);
            if (!row || !target) return;
            await toggleFavorite(projects, repository, target, {type: row.type === 'directory' ? 'directory' : 'file', title: String(row.metadata.title ?? row.name)});
            cache.set(id, !before);
        }};
}
function favoriteRoute(path: string): FavoriteRoute | undefined {
    try {
        const target = resolveBrowserTarget(path);
        if (target.kind === 'project-files' || target.kind === 'session' || target.kind === 'favorite') return target;
        if (target.kind === 'remote' && target.profileId && target.nativeSessionId) return target;
    } catch { /* Other workspaces use different resource routes. */ }
}
async function toggleFavorite(projects: ProjectService, repository: ISessionRepository, target: FavoriteRoute, node: {type: VFSNodeUI['type']; title: string}): Promise<void> {
    const folder = target.kind === 'session' ? (await repository.getManifest(target.sessionId)).folder : target.folder;
    const project = await projects.forFolder(folder);
    if (!project) return;
    if (target.kind === 'favorite') return projects.favorites.remove(project.project.id, target.favoriteId);
    if (target.kind === 'remote') {
        const root = projects.remoteMounts?.list(project.project.id).find(m => m.at === '/');
        if (!root?.connectionId || !root.serverId || !root.serverProjectId) return;
        await projects.favorites.toggle(project.project.id, {kind: 'remote-session', connectionId: root.connectionId, serverId: root.serverId,
            serverProjectId: root.serverProjectId, profileId: target.profileId!, sessionId: target.nativeSessionId!, archived: target.archived}, node.title); return;
    }
    const favorite: ProjectFavoriteTarget = target.kind === 'project-files'
        ? { kind: 'file', path: target.path, nodeType: node.type } : { kind: 'session', sessionId: target.sessionId };
    await projects.favorites.toggle(project.project.id, favorite, node.title);
}
