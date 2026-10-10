import type { IFileSystem, FSNode } from '@itookit/vfs-core';
import type { SessionRepository } from '@itookit/llm-session';
import type { ProjectService, ProjectFolder } from '../projects/project-service';
import type { TwinDiscoveredSource, TwinSourceCatalog } from './domain';
import { discoverHarness } from './harness-reader';

export const documentPath = (path: string) => !path.split('/').some(part => part.startsWith('.') || ['node_modules', 'private'].includes(part))
    && /\.(md|markdown|txt|mind|email|anki|project|rst|adoc|html|csv|ya?ml|json|[cm]?[jt]sx?|py|go|rs|java|c|cpp|h|css|sh|sql)$/i.test(path);
export const projectTarget = (id: string, path: string) => `project://${encodeURIComponent(id)}/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
export const scopeOf = (resource: TwinDiscoveredSource) => `${resource.projectId}/${resource.kind}`;
export const nodeVersion = (node: FSNode) => JSON.stringify([node.createdAt, node.modifiedAt, node.version, node.type === 'file' ? node.size : 0]);

export class TwinProjectCatalog {
    constructor(private readonly projects: ProjectService, private readonly sessions: SessionRepository) {}
    async discover(): Promise<TwinSourceCatalog> {
        const projects = await this.projects.list(), sessions = await this.sessions.list();
        const catalog: TwinSourceCatalog = { resources: [], projects: [...projects.map(item => item.project.id), '@unassigned'], completeScopes: [], errors: [] };
        for (const project of projects) {
            await this.files(project, catalog);
            await discoverHarness(this.projects, project, catalog);
        }
        for (const session of sessions.filter(item => !item.id.startsWith('twin-analysis-'))) {
            const project = projects.filter(item => session.folder && (session.folder === item.path || session.folder.startsWith(item.path + '/')))
                .sort((a, b) => b.path.length - a.path.length)[0];
            catalog.resources.push({ kind: 'session', target: session.id, sessionId: session.id, label: session.title,
                projectId: project?.project.id ?? '@unassigned', projectName: project?.name, version: String(session.updatedAt) });
        }
        catalog.completeScopes.push(...catalog.projects.map(id => `${id}/session`));
        if (catalog.resources.length > 10000) throw new Error('TWIN_SOURCE_COUNT_LIMIT');
        return catalog;
    }
    private async files(project: ProjectFolder, catalog: TwinSourceCatalog): Promise<void> {
        let source: Awaited<ReturnType<ProjectService['openFiles']>> | undefined;
        try {
            source = await this.projects.openFiles(project.path);
            const resources = await this.walk(source.fs, project.project.id, project.name);
            catalog.resources.push(...resources); catalog.completeScopes.push(`${project.project.id}/file`);
        } catch { catalog.errors.push(`${project.project.id}/file`); }
        finally { await source?.dispose(); }
    }
    private async walk(fs: IFileSystem, projectId: string, projectName: string): Promise<TwinDiscoveredSource[]> {
        const root = await fs.driver.getNode('/');
        if (root?.metadata.isProtected || root?.tags.includes('private')) return [];
        const queue = ['/'], resources: TwinDiscoveredSource[] = []; let visited = 0;
        while (queue.length) {
            const path = queue.shift()!;
            for (const node of await fs.driver.getChildren(path)) {
                if (++visited > 100000 || resources.length >= 10000) throw new Error('TWIN_SOURCE_COUNT_LIMIT');
                if (node.metadata.isProtected || node.tags.includes('private') || excluded(node.path)) continue;
                if (node.type === 'directory') queue.push(node.path);
                else if (node.type === 'file' && documentPath(node.path)) resources.push({ kind: 'file',
                    projectId, projectName, path: node.path.replace(/^\//, ''), target: projectTarget(projectId, node.path), label: node.path, version: nodeVersion(node) });
            }
        }
        return resources;
    }
}
const excluded = (path: string) => path.split('/').some(part => part.startsWith('.') || ['node_modules', 'private'].includes(part));
