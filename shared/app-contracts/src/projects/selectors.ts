import type { ProjectFavoriteTarget, ProjectFolder, ProjectService } from '../ports/projects';
import type { SessionFolder } from '@itookit/llm-session/contracts';

export const favoriteKey = (target: ProjectFavoriteTarget): string => target.kind === 'session' ? `session:${target.sessionId}`
    : target.kind === 'remote-session' ? 'remote:' + JSON.stringify([target.connectionId, target.serverId, target.serverProjectId, target.profileId, target.sessionId]) : `file:${target.path}`;

export function projectFileSource(project: ProjectFolder, remote?: ProjectService['remoteMounts']) {
    return project.project.source?.kind === 'remote' || remote?.list(project.project.id).some(mount => mount.at === '/')
        ? { kind: 'remote' as const, reference: `project:${project.project.id}` }
        : { kind: 'local' as const, directory: project.project.directory };
}
export function projectWorkspaceAccess(project: ProjectFolder, remote?: ProjectService['remoteMounts'], requested: 'ro' | 'rw' = 'rw'): 'ro' | 'rw' {
    return requested === 'ro' || remote?.list(project.project.id).some(mount => mount.at === '/' && mount.access === 'ro') ? 'ro' : 'rw';
}
export function projectNavigation(folders: readonly SessionFolder[], remote?: ProjectService['remoteMounts']): ProjectFolder[] {
    return folders.filter((folder): folder is ProjectFolder => !!folder.project).map(folder => {
        const connection = remote?.list(folder.project.id).find(mount => mount.at === '/')?.connectionId;
        const server = remote?.connections().find(item => item.id === connection);
        return { ...folder, displayName: server ? `${server.name}:${folder.name}` : folder.name };
    });
}
/** Attached directories expose navigation only through a registered owning grant. */
export function remoteSessionSources(projects: ProjectService, owner: ProjectFolder, registered: readonly ProjectFolder[]) {
    const remote = projects.remoteMounts;
    if (!remote) return [];
    const attached = remote.list(owner.project.id).filter(m => m.at !== '/' && m.serverId && m.connectionId);
    return registered.filter(project => project.project.id !== owner.project.id && attached.some(mount =>
        remote.list(project.project.id).some(root => root.at === '/' && root.serverProjectId && root.serverId === mount.serverId
            && root.connectionId === mount.connectionId && root.alias === mount.alias && root.root === mount.root)));
}
