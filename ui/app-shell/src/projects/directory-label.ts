import { folderPathFromBrowserPath, projectRelativePath, resolveBrowserTarget } from '@itookit/app-contracts';
import { t } from '@itookit/common';
import type { FSNode } from '@itookit/vfs-core';

/** Decode virtual project routes while preserving literal physical filenames. */
export function directoryPathLabel(path: string, title?: string): string {
    const target = resolveBrowserTarget(path);
    const folder = 'folder' in target ? target.folder : folderPathFromBrowserPath(path) ?? '/';
    const names = folder.split('/').filter(Boolean);
    if (target.kind === 'project-files' || target.kind === 'files') {
        if (target.kind === 'files') names.push(target.sessionId);
        names.push(t('project.files'));
        const physical = (target.kind === 'project-files' ? projectRelativePath(target.path) : target.path).split('/').filter(Boolean);
        if (title && physical.length) physical[physical.length - 1] = title;
        names.push(...physical);
    } else if (target.kind === 'favorites') names.push(t('project.favorites'));
    else if (target.kind === 'remote') {
        names.push(t('harness.remoteSessions'));
        if (target.profileId) names.push(target.profileId);
        if (target.cursor) names.push(t('harness.more'));
    }
    return names.join(' / ') || t('workbench.allProjects');
}

/** Synthetic project/folder names are route segments; file names remain literal. */
export function directoryEntryName(node: FSNode): string {
    const target = resolveBrowserTarget(node.path);
    if (target.kind === 'folder' || target.kind === 'session' || target.kind === 'remote' || node.metadata._fixedEntry)
        return String(node.metadata.title || (target.kind === 'folder' ? folderPathFromBrowserPath(node.path)?.split('/').pop() || node.name : node.name));
    return node.name;
}
