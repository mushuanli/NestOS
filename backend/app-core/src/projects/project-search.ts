import { checkOperation, operationScope, FSError, type OperationOptions } from '@itookit/vfs-core';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { ProjectService, ProjectSearchQuery, ProjectSearchResult } from '@itookit/app-contracts/services';
import { searchLocalFiles } from './search-local-files';
import { searchLocalSessions } from './search-local-sessions';
import { searchNativeSessions } from './search-native-sessions';
export type { ProjectSearchQuery, ProjectSearchMatch, ProjectSearchResult } from '@itookit/app-contracts/services';

/** Explicit source queries; synchronous navigation filtering remains free of I/O. */
export class ProjectSearch {
    constructor(private readonly projects: ProjectService, private readonly repository?: ISessionRepository) {}
    async search(folder: string, query: ProjectSearchQuery, options?: OperationOptions): Promise<ProjectSearchResult> {
        validateQuery(query);
        const scope = operationScope({timeoutMs: 20_000, ...options});
        try { return await this.query(folder, query, scope.options); } finally { scope.dispose(); }
    }
    private async query(folder: string, query: ProjectSearchQuery, options: OperationOptions): Promise<ProjectSearchResult> {
        checkOperation(options);
        const project = await this.projects.forFolder(folder);
        if (!project || project.path !== folder) throw new FSError('ENOENT', 'Project unavailable');
        if (query.scope.startsWith('file-')) return this.files(folder, project.project.id, query, options);
        const local = this.repository && !query.profileId ? await searchLocalSessions(this.repository, folder, project.project.id, query, options) : undefined;
        const remote = this.projects.remoteMounts;
        if (!remote || this.repository && !remote.list(project.project.id).length) {
            if (local) return local;
            throw new FSError('ECAPABILITY', 'Session search unavailable');
        }
        let native: ProjectSearchResult;
        try { native = await searchNativeSessions(remote, folder, project.project.id, query, options); }
        catch (error) {
            checkOperation(options);
            if (!local || (error as {code?: string}).code === 'ECONFLICT') throw error;
            return {...local, truncated: true, unavailableSources: ['remote']};
        }
        if (!local) return native;
        const matches = [...local.matches, ...native.matches].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        return {...native, matches: matches.slice(0, 100), truncated: local.truncated || native.truncated || matches.length > 100};
    }
    private async files(folder: string, projectId: string, query: ProjectSearchQuery, options: OperationOptions): Promise<ProjectSearchResult> {
        const remote = this.projects.remoteMounts;
        if (!remote?.list(projectId).some(mount => mount.at === '/')) return searchLocalFiles(this.projects, folder, projectId, query, options);
        const fingerprint = JSON.stringify(remote.list(projectId));
        const result = await remote.searchFiles(projectId, {query: query.query,
            mode: query.scope === 'file-content' ? 'content' : query.scope === 'file-name' ? 'name' : 'path',
            ...(query.directory ? {directory: query.directory} : {})}, options);
        checkOperation(options);
        if (fingerprint !== JSON.stringify(remote.list(projectId))) throw new FSError('ECONFLICT', 'Project authorization changed');
        return {...result, matches: result.matches.map(row => ({...row, kind: 'file' as const, projectId, folder, title: row.path, bindingIdentity: fingerprint}))};
    }
}
function validateQuery(query: ProjectSearchQuery): void {
    if (typeof query.query !== 'string' || !query.query.trim() || query.query.length > 1024 || query.query.includes('\0')
        || !['file-name', 'file-path', 'file-content', 'session-title', 'session-content', 'session-prompt'].includes(query.scope))
        throw new FSError('EINVAL', 'Invalid project search query');
    const directory = query.directory;
    if (directory !== undefined && (typeof directory !== 'string' || directory.length > 4096 || directory.includes('\0') || directory.includes('\\')
        || directory !== '' && directory.split('/').some(part => !part || part === '.' || part === '..')))
        throw new FSError('EINVAL', 'Invalid search directory');
}
