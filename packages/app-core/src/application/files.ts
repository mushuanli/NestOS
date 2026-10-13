import { FSError, normalizeVirtualPath, type IFileSystem } from '@itookit/vfs-core';
import { workspaceRoot } from '../session/workspace-paths';
import type { ProjectService } from '../projects/project-service';
import type { WorkspaceIdentity, DirectoryQuery, DirectoryPage } from './contracts';

export interface ApplicationFileSources {
    workspaces: readonly string[];
    openWorkspace(name: string): Promise<IFileSystem>;
    projects: Pick<ProjectService, 'get' | 'openFiles'>;
}

/** Resolve identities at the application boundary; no host paths cross the transport. */
export class ApplicationFiles {
    private readonly workspaces = new Map<string, Promise<IFileSystem>>();
    private readonly releases: Array<() => void> = [];
    constructor(private readonly sources: ApplicationFileSources, private readonly changed?: () => void) {}
    private openWorkspace(name: string): Promise<IFileSystem> {
        let pending = this.workspaces.get(name);
        if (!pending) {
            pending = this.sources.openWorkspace(name).then(fs => {
                if (this.changed && fs.onAny) this.releases.push(fs.onAny(event => { if (event.type !== 'error') this.changed?.(); })); return fs;
            });
            this.workspaces.set(name, pending);
            void pending.catch(() => { if (this.workspaces.get(name) === pending) this.workspaces.delete(name); });
        }
        return pending;
    }
    close(): void { this.releases.splice(0).forEach(release => release()); this.workspaces.clear(); }
    async use<T>(identity: WorkspaceIdentity, path: string, run: (fs: IFileSystem, path: string) => Promise<T>): Promise<T> {
        if (!path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(part => part === '..' || part === '.'))
            throw new FSError('EINVAL', 'Invalid application path');
        const normalized = normalizeVirtualPath(path);
        if (identity.kind === 'workspace') {
            if (!this.sources.workspaces.includes(identity.name)) throw new FSError('EACCES', 'Workspace is unavailable');
            workspaceRoot(identity.name);
            return run(await this.openWorkspace(identity.name), normalized);
        }
        if (identity.kind !== 'project' || !identity.id) throw new FSError('EINVAL', 'Invalid workspace identity');
        const project = await this.sources.projects.get(identity.id);
        const owner = await this.sources.projects.openFiles(project.path);
        try { return await run(owner.fs, normalized); } finally { await owner.dispose(); }
    }
    directory(query: DirectoryQuery): Promise<DirectoryPage> {
        const { offset = 0, limit = 100 } = query;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000)
            return Promise.reject(new FSError('EINVAL', 'Invalid directory page'));
        return this.use(query.workspace, query.path, async (fs, path) => {
            const children = await fs.driver.getChildren(path);
            return { entries: children.slice(offset, offset + limit), ...(offset + limit < children.length ? { nextOffset: offset + limit } : {}) };
        });
    }
}
