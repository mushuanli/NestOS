import type { ISessionRepository } from '@itookit/llm-session';
import { FSError } from '@itookit/vfs-core';
import type { ProjectService } from '@itookit/app-contracts/services';
import type { SessionLifecycleService } from '@itookit/app-contracts/services';
import type { ProjectTarget } from './targets';
import { importSessionBundle } from '../session/session-bundle';
import { importFileArchive, type FileArchiveEntry } from '../session/file-archive';
import { parseWorkbenchArchive, type WorkbenchArchiveItem } from './workbench-archive';

type Undo = () => Promise<unknown>;
interface Destination { folder: string | null; outer: string | null; project?: string; files: string }

/** Validation precedes mutation; rollback only touches objects created by this import. */
export class WorkbenchArchiveImporter {
    constructor(private readonly projects: ProjectService, private readonly lifecycle: SessionLifecycleService, private readonly repository: ISessionRepository) {}
    async import(content: string, target: ProjectTarget): Promise<ProjectTarget[]> {
        const archive = parseWorkbenchArchive(content);
        const destination = await this.destination(target), undo: Undo[] = [], created: ProjectTarget[] = [];
        if (archive.items.some(item => item.kind === 'files') && !destination.project) throw new FSError('EINVAL', 'Select a project for file import');
        try {
            for (const item of archive.items) {
                if (item.kind === 'files') created.push(...await this.files(item.entries, destination.project!, destination.files, undo));
                else created.push(await this.item(item, containsProject(item) ? destination.outer : destination.folder, undefined, undo));
            }
            return created;
        } catch (error) {
            const failures: unknown[] = [error];
            for (const revert of undo.reverse()) { try { await revert(); } catch (cleanup) { failures.push(cleanup); } }
            if (failures.length > 1) throw new AggregateError(failures, 'Import and cleanup failed');
            throw error;
        }
    }
    private async destination(target: ProjectTarget): Promise<Destination> {
        let folder = target.kind === 'group' ? target.folder : target.kind === 'session' ? null : (await this.projects.get(target.projectId)).path;
        if ('sessionId' in target) folder = (await this.repository.getManifest(target.sessionId)).folder ?? null;
        const project = await this.projects.forFolder(folder) ?? (folder ? undefined : await this.projects.current());
        let files = '/';
        if (target.kind === 'file') {
            const owner = await this.projects.openFiles(folder!);
            try {
                const node = await owner.fs.driver.getNode(target.path);
                if (!node) throw new FSError('ENOENT', 'Import destination no longer exists');
                files = node.type === 'directory' ? target.path : target.path.slice(0, target.path.lastIndexOf('/')) || '/';
            } finally { await owner.dispose(); }
        }
        if (folder && !(await this.repository.listFolders()).some(item => item.path === folder)) throw new FSError('ENOENT', 'Import folder no longer exists');
        return { folder: project && (!folder || folder === project.path) ? await this.projects.sessionFolder(project) : folder,
            outer: project ? project.parentPath ?? null : folder, project: project?.path, files };
    }
    private async item(item: WorkbenchArchiveItem, parent: string | null, sessionParent: string | undefined, undo: Undo[]): Promise<ProjectTarget> {
        if (item.kind === 'files') throw new FSError('EINVAL', 'Files must be imported into a project');
        if (item.kind === 'session') return this.session(item, parent, sessionParent, undo);
        const name = await this.uniqueName(parent, item.name);
        const path = `${parent ?? ''}/${name}`;
        if (item.kind === 'project') {
            const project = await this.projects.create(name, parent);
            undo.push(() => this.projects.discardImportedProject(project));
            undo.push(() => this.lifecycle.deleteFolder(path, true));
            await this.files(item.files, path, '/', undo);
        } else {
            await this.repository.createFolder(path);
            undo.push(() => this.lifecycle.deleteFolder(path, true));
        }
        for (const child of item.children) {
            if (item.kind === 'project' && child.kind === 'group' && child.name === '@sessions') {
                for (const session of child.children) await this.item(session, path + '/@sessions', undefined, undo);
            } else await this.item(child, path, undefined, undo);
        }
        return item.kind === 'project' ? { kind: 'project', projectId: (await this.projects.forFolder(path))!.project.id } : { kind: 'group', folder: path };
    }
    private async session(item: Extract<WorkbenchArchiveItem, { kind: 'session' }>, folder: string | null, parent: string | undefined, undo: Undo[]): Promise<ProjectTarget> {
        const repo = this.repository;
        const id = await importSessionBundle(repo, JSON.stringify(item.data), { folder });
        undo.push(() => this.lifecycle.deleteSession(id));
        if (parent) await repo.updateManifest(id, { parentSessionId: parent });
        if (item.attachments?.length) {
            const view = await repo.openAttachments(id);
            try { await importFileArchive(view, '/', item.attachments); } finally { await view.dispose(); }
        }
        for (const child of item.children) await this.item(child, (await repo.getManifest(id)).folder ?? null, id, undo);
        return { kind: 'session', sessionId: id };
    }
    private async files(entries: FileArchiveEntry[], folder: string, target: string, undo: Undo[]): Promise<ProjectTarget[]> {
        const owner = await this.projects.openFiles(folder);
        let paths: string[];
        try { paths = await importFileArchive(owner.fs, target, entries); } finally { await owner.dispose(); }
        undo.push(async () => {
            const current = await this.projects.openFiles(folder);
            try { await current.fs.driver.delete(paths, { recursive: true }); } finally { await current.dispose(); }
        });
        const project = (await this.projects.forFolder(folder))!;
        return paths.map(path => ({ kind: 'file', projectId: project.project.id, path }));
    }
    private async uniqueName(parent: string | null, name: string): Promise<string> {
        const folders = new Set((await this.repository.listFolders()).map(item => item.path));
        let result = name;
        for (let n = 2; folders.has(`${parent ?? ''}/${result}`); n++) result = `${name} (${n})`;
        return result;
    }
}
function containsProject(item: WorkbenchArchiveItem): boolean {
    return item.kind === 'project' || (item.kind === 'group' && item.children.some(containsProject));
}
