import { buildRenamedFilename } from '@itookit/common';
import type { ProjectFavorite, ProjectFavoriteTarget, FavoriteMove } from './contracts';

export const favoriteKey = (target: ProjectFavoriteTarget): string => target.kind === 'session' ? `session:${target.sessionId}`
    : target.kind === 'remote-session' ? 'remote:' + JSON.stringify([target.connectionId, target.serverId, target.serverProjectId, target.profileId, target.sessionId]) : `file:${target.path}`;
const contains = (parent: string, path: string): boolean => parent === path || path.startsWith(parent + '/');

export function withoutDeletedFiles(items: ProjectFavorite[], paths: readonly string[]): ProjectFavorite[] {
    return items.filter(({ target }) => target.kind !== 'file' || !paths.some(path => contains(path, target.path)));
}
export function moveFavorites(items: ProjectFavorite[], moves: readonly FavoriteMove[]): ProjectFavorite[] {
    const updated = items.map(item => moveFavorite(item, moves));
    const seen = new Set<string>();
    return updated.filter(item => {
        const key = favoriteKey(item.target);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}
function moveFavorite(item: ProjectFavorite, moves: readonly FavoriteMove[]): ProjectFavorite {
    const target = item.target;
    if (target.kind !== 'file') return item;
    const move = moves.filter(move => contains(move.oldPath, target.path)).sort((a, b) => b.oldPath.length - a.oldPath.length)[0];
    if (!move) return item;
    const path = move.newPath + target.path.slice(move.oldPath.length), name = path.split('/').pop()!;
    const title = target.path !== move.oldPath ? item.title : target.nodeType === 'directory' ? name : buildRenamedFilename(name, name).title;
    return { ...item, target: { ...target, path }, title };
}
/**
 * Drop Session favorites that left the project and refresh titles from the current
 * catalog. `titles` is the project's live Session catalog, so absence means gone.
 */
export function reconcileSessions(items: ProjectFavorite[], titles: ReadonlyMap<string, string>): ProjectFavorite[] {
    return items.flatMap(item => item.target.kind !== 'session' ? [item]
        : titles.has(item.target.sessionId) ? [{ ...item, title: titles.get(item.target.sessionId)! }] : []);
}
