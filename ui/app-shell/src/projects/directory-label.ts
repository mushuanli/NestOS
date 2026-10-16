import { filesBrowserPrefix, folderBrowserPath, folderPathFromBrowserPath, parentBrowserPath, remoteSessionPath, resolveBrowserTarget } from '@itookit/app-contracts';
import { t } from '@itookit/common';
import type { FSNode } from '@itookit/vfs-core';
import { fileDirectoryBreadcrumbs, type DirectoryBreadcrumb } from '../workbench/directory-breadcrumbs';

/** Project route policy stays outside the generic breadcrumb renderer. */
export function directoryBreadcrumbs(path: string, title?: string): DirectoryBreadcrumb[] {
    const target = resolveBrowserTarget(path), folder = folderPathFromBrowserPath(path) ?? '/';
    const result = fileDirectoryBreadcrumbs(folder, t('workbench.allProjects'))
        .map(item => ({ ...item, id: folderBrowserPath(item.id) || '/' }));
    if (target.kind === 'project-files' || target.kind === 'files') {
        const root = filesBrowserPrefix(path);
        if (target.kind === 'files') result.push({ id: parentBrowserPath(root), label: target.sessionId });
        const children = fileDirectoryBreadcrumbs(path.slice(root.length), t('project.files'));
        for (const item of children) result.push({ id: root + (item.id === '/' ? '' : item.id), label: item.label });
        if (title && children.length > 1) result[result.length - 1].label = title;
    } else if (target.kind === 'favorites') result.push({ id: path, label: t('project.favorites') });
    else if (target.kind === 'remote') {
        result.push({ id: remoteSessionPath(target.folder), label: t('harness.remoteSessions') });
        if (target.profileId) result.push({ id: remoteSessionPath(target.folder, target.profileId), label: target.profileId });
        if (target.archived) result.push({ id: remoteSessionPath(target.folder, target.profileId, undefined, true), label: t('harness.archived') });
        if (target.cursor) result.push({ id: path, label: t('harness.more') });
    }
    return result;
}

/** Synthetic project/folder names are route segments; file names remain literal. */
export function directoryEntryName(node: FSNode): string {
    const target = resolveBrowserTarget(node.path);
    if (target.kind === 'folder' || target.kind === 'session' || target.kind === 'remote' || node.metadata._fixedEntry)
        return String(node.metadata.title || (target.kind === 'folder' ? folderPathFromBrowserPath(node.path)?.split('/').pop() || node.name : node.name));
    return node.name;
}
