import { randomUUID } from '@itookit/common';
import type { ProjectFavorite, ProjectFavoriteTarget, ProjectFavoriteStore, SessionFavoriteTitles, FavoriteMove, FavoriteUpdate } from './contracts';
import { validateTarget } from './codec';
import { favoriteKey, withoutDeletedFiles, moveFavorites, reconcileSessions } from './policy';

/** Project-owned navigation shortcuts. They never grant access to their targets. */
export class ProjectFavorites {
    private readonly cache = new Map<string, ProjectFavorite[]>();
    private readonly listeners = new Set<() => void>();
    private readonly pending = new Map<string, Promise<unknown>>();
    constructor(private readonly store: ProjectFavoriteStore, private readonly sessionTitles?: SessionFavoriteTitles) {}
    subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    /**
     * Current shortcuts. With a Session catalog this also reconciles titles and membership,
     * so a list call may publish one change notification.
     */
    list(projectId: string): Promise<ProjectFavorite[]> {
        return this.serial(projectId, () => this.load(projectId));
    }
    private async load(projectId: string): Promise<ProjectFavorite[]> {
        const items = await this.store.read(projectId);
        if (!this.sessionTitles || !items.some(item => item.target.kind === 'session'))
            return this.cached(projectId, items);
        const titles = await this.sessionTitles(projectId);
        return this.persist(projectId, entries => reconcileSessions(entries, titles));
    }
    /** Read-only cache accessors; call `list` first when a project may not be loaded yet. */
    hasSession(sessionId: string): boolean { return [...this.cache.values()].some(items => items.some(item => item.target.kind === 'session' && item.target.sessionId === sessionId)); }
    has(projectId: string, target: ProjectFavoriteTarget): boolean { return this.cache.get(projectId)?.some(item => favoriteKey(item.target) === favoriteKey(target)) ?? false; }
    async toggle(projectId: string, target: ProjectFavoriteTarget, title: string): Promise<void> {
        validateTarget(target);
        const favorite = { id: randomUUID(), target: structuredClone(target), title: title.slice(0, 512) };
        const key = favoriteKey(favorite.target);
        await this.change(projectId, items => items.some(item => favoriteKey(item.target) === key)
            ? items.filter(item => favoriteKey(item.target) !== key) : [...items, favorite]);
    }
    async remove(projectId: string, id: string): Promise<void> { await this.change(projectId, items => items.filter(item => item.id !== id)); }
    async include(projectId: string, favorites: readonly ProjectFavorite[]): Promise<void> {
        for (const item of favorites) validateTarget(item.target);
        await this.change(projectId, items => {
            const keys = new Set(items.map(item => favoriteKey(item.target)));
            return [...items, ...favorites.filter(item => !keys.has(favoriteKey(item.target))).map(item => structuredClone(item))];
        });
    }
    async deleteFiles(projectId: string, paths: readonly string[]): Promise<void> {
        await this.change(projectId, items => withoutDeletedFiles(items, paths));
    }
    async moveFiles(projectId: string, moves: readonly FavoriteMove[]): Promise<void> {
        await this.change(projectId, items => moveFavorites(items, moves));
    }
    async deleteNativeSessions(projectId: string, target: Extract<ProjectFavoriteTarget, {kind: 'remote-session'}>, ids: readonly string[]): Promise<void> {
        validateTarget(target);
        const keys = new Set(ids.map(sessionId => favoriteKey({...target, sessionId})));
        await this.change(projectId, items => items.filter(item => !keys.has(favoriteKey(item.target))));
    }
    async updateNativeSession(projectId: string, target: Extract<ProjectFavoriteTarget, {kind: 'remote-session'}>, title: string, archived: boolean): Promise<void> {
        validateTarget(target);
        const key = favoriteKey(target);
        await this.change(projectId, items => items.map(item => favoriteKey(item.target) === key
            ? {...item, title: title.slice(0, 512), target: {...target, archived}} : item));
    }
    private change(projectId: string, update: FavoriteUpdate): Promise<void> {
        return this.serial(projectId, async () => { await this.persist(projectId, update); });
    }
    private serial<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
        const work = (this.pending.get(projectId) ?? Promise.resolve()).catch(() => {}).then(operation);
        this.pending.set(projectId, work);
        void work.finally(() => { if (this.pending.get(projectId) === work) this.pending.delete(projectId); }).catch(() => {});
        return work;
    }
    private async persist(projectId: string, update: FavoriteUpdate): Promise<ProjectFavorite[]> {
        const { items, changed } = await this.store.update(projectId, update);
        const snapshot = this.cached(projectId, items);
        if (changed) for (const listener of this.listeners) listener();
        return snapshot;
    }
    private cached(projectId: string, items: ProjectFavorite[]): ProjectFavorite[] {
        this.cache.set(projectId, items);
        return structuredClone(items);
    }
}
