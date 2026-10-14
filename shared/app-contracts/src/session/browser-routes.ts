import { FSError, normalizeVirtualPath } from '@itookit/vfs-core';
import { workspacePath } from '../vfs/workspace-namespace';

export type BrowserTarget =
    | { kind: 'folder'; path: string }
    | { kind: 'remote'; folder: string; profileId?: string; nativeSessionId?: string; draft?: boolean; cursor?: string; archived?: boolean }
    | { kind: 'project-files'; folder: string; path: string }
    | { kind: 'favorites'; folder: string }
    | { kind: 'favorite'; folder: string; favoriteId: string }
    | { kind: 'session'; sessionId: string }
    | { kind: 'tasks'; sessionId: string }
    | { kind: 'task'; sessionId: string; taskId: string }
    | { kind: 'files'; sessionId: string; path: string };

export type FileTarget = Extract<BrowserTarget, { kind: 'files' | 'project-files' }>;
export function isFileTarget(target: BrowserTarget): target is FileTarget { return target.kind === 'files' || target.kind === 'project-files'; }

export const FOLDER_SEGMENT_PREFIX = 'folder:';

export function isFolderSegment(segment: string): boolean {
    return segment.startsWith(FOLDER_SEGMENT_PREFIX) && segment.length > FOLDER_SEGMENT_PREFIX.length;
}
export function folderBrowserPath(folder: string | null | undefined): string {
    if (!folder || folder === '/') return '';
    return '/' + folder.split('/').filter(Boolean).map(segment => FOLDER_SEGMENT_PREFIX + encodeURIComponent(segment)).join('/');
}
function browserFolderPath(path: string): string | null {
    const segments = normalizeVirtualPath(path).slice(1).split('/').filter(Boolean);
    const prefix: string[] = [];
    for (const segment of segments) {
        if (!isFolderSegment(segment)) break;
        prefix.push(segment);
    }
    return prefix.length ? '/' + prefix.join('/') : null;
}
export function folderPathFromBrowserPath(path: string): string | null {
    const prefix = browserFolderPath(path);
    if (!prefix) return null;
    return '/' + prefix.slice(1).split('/').filter(Boolean).map(segment => decodeURIComponent(segment.slice(FOLDER_SEGMENT_PREFIX.length))).join('/');
}
function sessionBrowserPrefix(path: string): string {
    const segments = normalizeVirtualPath(path).slice(1).split('/').filter(Boolean);
    let index = 0;
    while (index < segments.length && isFolderSegment(segments[index])) index++;
    return '/' + segments.slice(0, index + 1).join('/');
}
export function filesBrowserPrefix(path: string): string {
    const target = resolveBrowserTarget(path);
    return target.kind === 'project-files' ? `${folderBrowserPath(target.folder)}/@files` : `${sessionBrowserPrefix(path)}/files`;
}
export function parentBrowserPath(path: string): string {
    const normalized = normalizeVirtualPath(path);
    const index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
}
export function browserName(path: string): string {
    const segment = normalizeVirtualPath(path).split('/').filter(Boolean).pop() ?? '';
    return isFolderSegment(segment) ? decodeURIComponent(segment.slice(FOLDER_SEGMENT_PREFIX.length)) : segment;
}
export function resolveBrowserTarget(path: string): BrowserTarget {
    const normalized = normalizeVirtualPath(path);
    if (normalized === '/') return { kind: 'folder', path: '/' };
    const segments = normalized.slice(1).split('/').filter(Boolean);
    let index = 0;
    while (index < segments.length && isFolderSegment(segments[index])) index++;
    const folderPrefix = '/' + segments.slice(0, index).join('/');
    if (index === segments.length) return { kind: 'folder', path: folderPrefix };
    if (segments[index] === '@harness' && index > 0) return remoteTarget(segments.slice(index + 1), folderPathFromBrowserPath(folderPrefix)!);
    if (segments[index] === '@favorites' && index > 0) {
        const favoriteId = segments[index + 1];
        if (segments.length > index + 2 || favoriteId && !/^[a-zA-Z0-9_-]{1,128}$/.test(favoriteId))
            throw new FSError('EINVAL', 'Invalid favorite browser path', undefined, normalized);
        const folder = folderPathFromBrowserPath(folderPrefix)!;
        return favoriteId ? { kind: 'favorite', folder, favoriteId } : { kind: 'favorites', folder };
    }
    if (segments[index] === '@files' && index > 0) return { kind: 'project-files',
        folder: folderPathFromBrowserPath(folderPrefix)!, path: workspacePath('/' + segments.slice(index + 1).join('/')) };
    const sessionId = segments[index];
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
        throw new FSError('EINVAL', `Invalid Session browser segment "${sessionId}"`, undefined, normalized);
    const area = segments[index + 1];
    const rest = segments.slice(index + 2);
    if (!area) return { kind: 'session', sessionId };
    if (area === 'files') {
        const filePath = '/' + rest.join('/');
        return { kind: 'files', sessionId, path: filePath };
    }
    if (area === 'tasks' && !rest.length) return { kind: 'tasks', sessionId };
    if (area === 'tasks' && rest.length === 1 && rest[0] === '@more') return { kind: 'tasks', sessionId };
    if (area === 'tasks' && rest.length === 1 && /^[a-zA-Z0-9_-]+$/.test(rest[0])) return { kind: 'task', sessionId, taskId: rest[0] };
    throw new FSError('ENOENT', 'Session browser entry not found', undefined, normalized);
}
/**
 * Folder that owns a browser target.
 *
 * Folder-bearing targets resolve from their identity. Session-scoped targets use the
 * manifest folder the caller resolved; the browser path is only a fallback, so a stale
 * prefix can never override the manifest.
 */
export function browserTargetFolder(target: BrowserTarget, path: string, sessionFolder?: string | null): string {
    if ('folder' in target) return target.folder;
    if (target.kind !== 'folder') return sessionFolder !== undefined ? sessionFolder ?? '/' : folderPathFromBrowserPath(path) ?? '/';
    return folderPathFromBrowserPath(path) ?? '/';
}

export function remoteSessionPath(folder: string, profileId?: string, nativeSessionId?: string, archived = false): string {
    return folderBrowserPath(folder) + '/@harness' + (profileId ? '/' + encodeURIComponent(profileId) : '')
        + (archived && profileId ? '/@archived' : '')
        + (nativeSessionId ? '/' + encodeURIComponent(nativeSessionId) : '');
}
function remoteIdentity(value: string, cursor = false): string {
    let id: string;
    try { id = decodeURIComponent(value); } catch { throw new FSError('EINVAL', 'Invalid remote identity'); }
    if (!id || id.length > 2048 || /[\x00-\x1f]/.test(id) || !cursor && /[\\/]/.test(id) || id === '.' || id === '..') throw new FSError('EINVAL', 'Invalid remote identity');
    return id;
}
function remotePages(parts: string[]): {index: number; cursor?: string} {
    let index = parts[1] === '@archived' ? 2 : 1, cursor: string | undefined;
    while (parts[index]?.startsWith('@page:') || parts[index] === '@page') {
        // A page is one directory entry; retain decoding of previously saved two-segment routes.
        if (parts[index] === '@page') {
            cursor = remoteIdentity(parts[index + 1] ?? '',true); index += 2;
        } else {
            cursor = remoteIdentity(parts[index].slice(6),true); index++;
        }
    }
    return {index,cursor};
}
function remoteTarget(parts: string[], folder: string): Extract<BrowserTarget, {kind: 'remote'}> {
    const profileId = parts[0] ? remoteIdentity(parts[0]) : undefined;
    const {index,cursor} = remotePages(parts);
    const leaf = parts[index];
    if (parts.length > index + 1 || leaf?.startsWith('@') && leaf !== '@new') throw new FSError('EINVAL', 'Invalid remote route');
    return {kind: 'remote', folder, profileId, nativeSessionId: leaf && leaf !== '@new' ? remoteIdentity(leaf) : undefined,
        draft: leaf === '@new' || undefined, cursor, ...(parts[1] === '@archived' ? {archived: true} : {})};
}
