export type ProjectFavoriteTarget = { kind: 'file'; path: string; nodeType: 'file' | 'directory' } | { kind: 'session'; sessionId: string }
    | {kind: 'remote-session'; connectionId: string; serverId: string; serverProjectId: string; profileId: string; sessionId: string; archived?: boolean};
export interface ProjectFavorite { id: string; title: string; target: ProjectFavoriteTarget; }
/**
 * Pure reducer from the stored list to the next list. A store may invoke it more than
 * once per request (existence probe, then the read-modify-write transaction), so it
 * must not depend on call count or mutate its input.
 */
export type FavoriteUpdate = (items: ProjectFavorite[]) => ProjectFavorite[];
export interface ProjectFavoriteStore {
    read(projectId: string): Promise<ProjectFavorite[]>;
    update(projectId: string, update: FavoriteUpdate): Promise<{ items: ProjectFavorite[]; changed: boolean }>;
}
export type SessionFavoriteTitles = (projectId: string) => Promise<ReadonlyMap<string, string>>;
export interface FavoriteFileChanges {
    deleteFiles(projectId: string, paths: readonly string[]): Promise<void>;
    moveFiles(projectId: string, moves: readonly FavoriteMove[]): Promise<void>;
}
export interface FavoriteMove { oldPath: string; newPath: string }
