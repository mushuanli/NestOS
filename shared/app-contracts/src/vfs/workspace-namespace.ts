import { FSError, normalizeVirtualPath } from '@itookit/vfs-core';

/**
 * Canonical namespace of the project workspace mount. Editors, tools and execution
 * all address project files below this path; browser routes and source views stay
 * relative and convert at this boundary only.
 */
export const WORKSPACE_PATH = '/workspace';

/** Enter the workspace namespace from a source/presentation-relative path. */
export function workspacePath(relative: string): string {
    const path = normalizeVirtualPath(relative);
    return WORKSPACE_PATH + (path === '/' ? '' : path);
}

/** Strip only the project root; sibling grants must never become project files. */
export function projectRelativePath(path: string): string {
    const normalized = normalizeVirtualPath(path);
    if (normalized === WORKSPACE_PATH) return '/';
    if (!normalized.startsWith(WORKSPACE_PATH + '/')) throw new FSError('EACCES', 'Path is outside the project workspace');
    return normalized.slice(WORKSPACE_PATH.length);
}
