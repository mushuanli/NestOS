import type { ProjectFolder, ProjectService } from '@itookit/app-contracts/services';

/** Attached directories only expose native navigation when a matching registered project owns the grant. */
export function remoteSessionSources(projects: ProjectService, owner: ProjectFolder, registered: readonly ProjectFolder[]) {
    const remote = projects.remoteMounts;
    if (!remote) return [];
    const attached = remote.list(owner.project.id).filter(m => m.at !== '/' && m.serverId && m.connectionId);
    return registered.filter(project => project.project.id !== owner.project.id && attached.some(mount =>
        remote.list(project.project.id).some(root => root.at === '/' && root.serverProjectId && root.serverId === mount.serverId
            && root.connectionId === mount.connectionId && root.alias === mount.alias && root.root === mount.root)));
}
