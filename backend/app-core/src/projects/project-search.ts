import { checkOperation, operationScope, FSError, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectService } from '@itookit/app-contracts/services';
import { searchLocalFiles } from './search-local-files';
export interface ProjectSearchQuery { query: string; scope: 'file-path' | 'file-content' | 'session-title' | 'session-content'; archived?: boolean; profileId?: string }
export interface ProjectSearchMatch {
    projectId: string; folder: string; kind: 'file' | 'remote-session'; summary: string; title: string;
    bindingIdentity?: string; path?: string; line?: number; profileId?: string; sessionId?: string; turnId?: string; itemId?: string; updatedAt?: number | null; archived?: boolean;
}
export interface ProjectSearchResult { matches: ProjectSearchMatch[]; truncated: boolean; nextCursor: null }
/** Explicit project-wide reads; the synchronous tree filter remains free of I/O. */
export class ProjectSearch {
    constructor(private readonly projects: ProjectService) {}
    async search(folder: string, query: ProjectSearchQuery, options?: OperationOptions): Promise<ProjectSearchResult> {
        const scope = operationScope({timeoutMs: 20_000, ...options});
        try { return await this.query(folder, query, scope.options); } finally { scope.dispose(); }
    }
    private async query(folder: string, query: ProjectSearchQuery, options?: OperationOptions): Promise<ProjectSearchResult> {
        if (!query.query.trim() || query.query.length > 1024) throw new FSError('EINVAL', 'Invalid project search query');
        checkOperation(options);
        const project = await this.projects.forFolder(folder);
        if (!project || project.path !== folder) throw new FSError('ENOENT', 'Project unavailable');
        const remote = this.projects.remoteMounts;
        if (query.scope.startsWith('file-')) {
            if (!remote?.list(project.project.id).some(mount => mount.at === '/')) return searchLocalFiles(this.projects, folder, project.project.id, query, options);
            const result = await remote.searchFiles(project.project.id, {query: query.query, mode: query.scope === 'file-path' ? 'path' : 'content'}, options);
            return {...result, matches: result.matches.map(row => ({...row, kind: 'file' as const, projectId: project.project.id, folder, title: row.path, bindingIdentity: JSON.stringify(remote.list(project.project.id))}))};
        }
        if (!remote) throw new FSError('ECAPABILITY', 'Native session search unavailable');
        return this.nativeSearch(folder, project.project.id, query, options);
    }
    private async nativeSearch(folder: string, projectId: string, query: ProjectSearchQuery, options?: OperationOptions): Promise<ProjectSearchResult> {
        const remote = this.projects.remoteMounts!;
        const client = await remote.projectHarness(projectId, options);
        const fingerprint = JSON.stringify(remote.list(projectId));
        try {
            const profiles = (await client.profiles(options)).profiles.filter(profile => profile.projectRuntime && profile.capabilities.search && (!query.profileId || profile.id === query.profileId));
            if (!client.search || !profiles.length) throw new FSError('ECAPABILITY', 'Native session search unavailable');
            const matches: ProjectSearchMatch[] = []; let truncated = false;
            for (const profile of profiles) {
                const result = await client.search(profile.id, {query: query.query, mode: query.scope === 'session-title' ? 'title' : 'content', archived: query.archived}, options);
                matches.push(...result.matches.map(row => ({...row, kind: 'remote-session' as const, projectId, folder, profileId: profile.id, bindingIdentity: fingerprint, archived: query.archived})));
                truncated ||= result.truncated; if (matches.length >= 100) { truncated = true; break; }
            }
            if (fingerprint !== JSON.stringify(remote.list(projectId))) throw new FSError('ECONFLICT', 'Project authorization changed');
            return {matches: matches.slice(0, 100), truncated, nextCursor: null};
        } finally { await client.close(); }
    }
}
