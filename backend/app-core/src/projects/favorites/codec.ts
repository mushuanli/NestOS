import { FSError, normalizeVirtualPath } from '@itookit/vfs-core';
import { WORKSPACE_PATH } from '../../vfs/workspace-namespace';
import type { ProjectFavorite, ProjectFavoriteTarget } from './contracts';

const IDENTITY = /^[a-zA-Z0-9_-]{1,128}$/;
/** Upper bound shared by the codec and the store, so an oversized list never publishes. */
export const MAX_FAVORITES = 256;

export function validateTarget(target: ProjectFavoriteTarget): void {
    if (target?.kind === 'remote-session' && (target.archived === undefined || typeof target.archived === 'boolean') && [target.connectionId, target.serverId, target.serverProjectId, target.profileId, target.sessionId]
        .every(id => typeof id === 'string' && !!id && id.length <= 512 && !/[\x00-\x1f/\\]/.test(id))) return;
    if (target?.kind === 'session' && typeof target.sessionId === 'string' && IDENTITY.test(target.sessionId)) return;
    if (target?.kind === 'file' && ['file', 'directory'].includes(target.nodeType) && typeof target.path === 'string'
        && normalizeVirtualPath(target.path) === target.path
        && (target.path === WORKSPACE_PATH || target.path.startsWith(WORKSPACE_PATH + '/'))) return;
    throw new FSError('EINVAL', 'Invalid favorite target');
}
export function decodeFavorites(raw: string | null): ProjectFavorite[] {
    if (raw === null) return [];
    let items: ProjectFavorite[];
    try { items = JSON.parse(raw); } catch { throw new FSError('EIO', 'Invalid project favorites'); }
    if (!Array.isArray(items) || items.length > MAX_FAVORITES) throw new FSError('EIO', 'Invalid project favorites');
    for (const item of items) {
        if (!item || typeof item.title !== 'string' || typeof item.id !== 'string' || !IDENTITY.test(item.id)) throw new FSError('EIO', 'Invalid favorite');
        validateTarget(item.target);
    }
    return items;
}
