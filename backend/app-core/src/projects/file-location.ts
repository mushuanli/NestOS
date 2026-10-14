import { normalizeVirtualPath } from '@itookit/vfs-core';
import type { ProjectFolder } from './project-service';
import type { ProjectRemoteMount } from './remote-mounts';

export interface ProjectFileLocation { namespace: string; path: string; label: string }
export interface ProjectFileRoot { projectId: string; name: string; location: ProjectFileLocation }

export function overlappingProjectRoots(location: ProjectFileLocation, roots: readonly ProjectFileRoot[]): ProjectFileRoot[] {
    return roots.filter(root => root.location.namespace === location.namespace && (root.location.path === location.path
        || root.location.path.startsWith(location.path.replace(/\/$/, '') + '/')
        || location.path.startsWith(root.location.path.replace(/\/$/, '') + '/')));
}

/** A directory containing a registered root cannot be moved as an ordinary folder. */
export function containedProjectRoots(location: ProjectFileLocation, roots: readonly ProjectFileRoot[]): ProjectFileRoot[] {
    return roots.filter(root => root.location.namespace === location.namespace && (root.location.path === location.path
        || root.location.path.startsWith(location.path.replace(/\/$/, '') + '/')));
}

/** Resolve a project-relative path through the same longest-prefix grants as its file view. */
export function projectFileLocation(project: ProjectFolder, relative: string,
    mounts: readonly ProjectRemoteMount[]): ProjectFileLocation {
    relative = normalizeVirtualPath(relative);
    const mount = mounts.filter(item => item.at === '/' || relative === item.at || relative.startsWith(item.at + '/'))
        .sort((a, b) => b.at.length - a.at.length)[0];
    if (mount) {
        const suffix = mount.at === '/' ? relative : relative.slice(mount.at.length);
        const path = normalizeVirtualPath(mount.root.replace(/\/$/, '') + '/' + suffix);
        return { namespace: JSON.stringify(['remote', mount.serverId ?? mount.endpoint, mount.username ?? '', mount.alias]), path,
            label: `${mount.endpoint}/${mount.alias}${path === '/' ? '' : path}` };
    }
    if (project.project.source?.kind === 'remote') {
        return { namespace: `unbound-project:${project.project.id}`, path: relative, label: project.project.directory };
    }
    const directory = project.project.directory;
    const expanded = directory === '~' ? '/home/admin' : directory.startsWith('~/') ? '/home/admin/' + directory.slice(2) : directory;
    const managed = !expanded.startsWith('host:') && (expanded === '/home/admin' || expanded.startsWith('/home/admin/'));
    const base = expanded.replace(/^host:/, '').replace(/\\/g, '/').replace(/\/$/, '');
    const joined = base + (relative === '/' ? '' : relative);
    const path = managed ? normalizeVirtualPath(joined) : joined;
    return { namespace: managed ? 'managed' : 'host', path, label: path };
}
