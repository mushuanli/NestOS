import type { ISessionRepository } from '@itookit/llm-session';
import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { ConversationManifest, SessionFolder } from '@itookit/llm-session';
import type { ProjectService } from '@itookit/app-contracts/services';
import type { ProjectTarget } from './targets';
import { archivePath, exportFileArchive, parseFileArchive, type FileArchiveEntry } from '../session/file-archive';
import { exportSessionBundle, parseSessionBundle, isSessionBundle, type SessionBundle } from '../session/session-bundle';

export type WorkbenchArchiveItem =
    | { kind: 'project'; name: string; files: FileArchiveEntry[]; children: WorkbenchArchiveItem[] }
    | { kind: 'group'; name: string; children: WorkbenchArchiveItem[] }
    | { kind: 'session'; data: SessionBundle; attachments?: FileArchiveEntry[]; children: WorkbenchArchiveItem[] }
    | { kind: 'files'; entries: FileArchiveEntry[] };
export interface WorkbenchArchive { format: 'itookit.workbench'; version: 1; items: WorkbenchArchiveItem[] }

/** The envelope records organization; imported identities are always fresh. */
export function parseWorkbenchArchive(content: string): WorkbenchArchive {
    if (isSessionBundle(content)) return { format: 'itookit.workbench', version: 1,
        items: [{ kind: 'session', data: parseSessionBundle(content), children: [] }] };
    let value; try { value = JSON.parse(content); } catch { throw new FSError('EINVAL', 'Invalid archive JSON'); }
    if (value?.format !== 'itookit.workbench' || value.version !== 1 || !Array.isArray(value.items))
        throw new FSError('EINVAL', 'Unsupported workbench archive');
    return { format: 'itookit.workbench', version: 1, items: value.items.map((item: unknown) => parseItem(item, false, false, 0)) };
}
function parseItem(value: unknown, inProject: boolean, inSession: boolean, depth: number): WorkbenchArchiveItem {
    if (!value || typeof value !== 'object' || depth > 100) throw new FSError('EINVAL', 'Invalid archive item');
    const item = value as Record<string, unknown>;
    const kind = item.kind;
    if (inSession && kind !== 'session') throw new FSError('EINVAL', 'Invalid child Session');
    if (kind === 'files' && depth === 0) return { kind, entries: parseFileArchive(item.entries) };
    if (!Array.isArray(item.children)) throw new FSError('EINVAL', 'Archive children must be a list');
    if (kind === 'session') return { kind, data: parseSessionBundle(JSON.stringify(item.data)),
        attachments: item.attachments === undefined ? undefined : parseFileArchive(item.attachments),
        children: item.children.map(child => parseItem(child, inProject, true, depth + 1)) };
    if (!['group', 'project'].includes(String(kind)) || (kind === 'project' && inProject)) throw new FSError('EINVAL', 'Invalid archive organization');
    const name = archivePath(item.name);
    if (name.trim() !== name || name.includes('/') || (name === '@sessions' && kind === 'project')) throw new FSError('EINVAL', 'Invalid archive name');
    const children = item.children.map(child => parseItem(child, inProject || kind === 'project', false, depth + 1));
    return kind === 'project' ? { kind, name, children, files: parseFileArchive(item.files) } : { kind: 'group', name, children };
}

export class WorkbenchArchiveExporter {
    private sessions: ConversationManifest[] = [];
    private folders: SessionFolder[] = [];
    constructor(private readonly projects: ProjectService, private readonly repository: ISessionRepository) {}
    async export(targets: readonly ProjectTarget[]): Promise<WorkbenchArchive> {
        [this.sessions, this.folders] = await Promise.all([this.repository.list(), this.repository.listFolders()]);
        const selectedFolders = new Set<string | null>();
        for (const target of targets) {
            if (target.kind === 'group') selectedFolders.add(target.folder);
            if (target.kind === 'project') selectedFolders.add((await this.projects.get(target.projectId)).path);
        }
        const covered = (folder: string | null) => [...selectedFolders].some(parent => parent === null || parent === folder || folder?.startsWith(parent + '/'));
        const sessions = new Set(targets.filter(item => item.kind === 'session').map(item => item.sessionId));
        const items: WorkbenchArchiveItem[] = [], files = new Map<string, string[]>();
        for (const folder of selectedFolders) {
            if ([...selectedFolders].some(parent => parent !== folder && (parent === null || folder?.startsWith(parent + '/')))) continue;
            if (folder === null) items.push(...await this.children(null)); else items.push(await this.folder(folder));
        }
        for (const id of sessions) {
            const session = this.sessions.find(item => item.id === id);
            if (!session) throw new FSError('ENOENT', 'Session not found');
            if (!covered(session.folder ?? null) && !this.hasSelectedParent(id, sessions)) items.push(await this.session(id));
        }
        for (const target of targets) if (target.kind === 'file') {
            const folder = (await this.projects.get(target.projectId)).path;
            if (!covered(folder)) files.set(folder, [...files.get(folder) ?? [], target.path]);
        }
        for (const [folder, paths] of files) items.push({ kind: 'files', entries: await this.files(folder, [...new Set(paths)]) });
        return { format: 'itookit.workbench', version: 1, items };
    }
    private hasSelectedParent(id: string, selected: Set<string>): boolean {
        let parent = this.sessions.find(item => item.id === id)?.parentSessionId;
        const visited = new Set<string>();
        while (parent && !visited.has(parent)) {
            if (selected.has(parent)) return true;
            visited.add(parent); parent = this.sessions.find(item => item.id === parent)?.parentSessionId;
        }
        return false;
    }
    private async files(folder: string, paths: string[]): Promise<FileArchiveEntry[]> {
        const owner = await this.projects.openFiles(folder);
        try {
            const selected = paths.includes('/') ? (await owner.fs.driver.getChildren('/')).filter(node => node.name !== '.nestos').map(node => node.path) : paths;
            return await exportFileArchive(owner.fs, selected);
        } finally { await owner.dispose(); }
    }
    private async folder(path: string): Promise<WorkbenchArchiveItem> {
        const folder = this.folders.find(item => item.path === path);
        if (!folder) throw new FSError('ENOENT', 'Selected folder no longer exists');
        const children = await this.children(path);
        return folder.project ? { kind: 'project', name: folder.name, files: await this.files(path, ['/']), children }
            : { kind: 'group', name: folder.name, children };
    }
    private async children(path: string | null): Promise<WorkbenchArchiveItem[]> {
        const children: WorkbenchArchiveItem[] = [];
        for (const folder of this.folders.filter(item => (item.parentPath ?? null) === path)) children.push(await this.folder(folder.path));
        for (const session of this.sessions.filter(item => (item.folder ?? null) === path && !item.parentSessionId)) children.push(await this.session(session.id));
        return children;
    }
    private async session(id: string): Promise<WorkbenchArchiveItem> {
        const data = parseSessionBundle((await exportSessionBundle(this.repository, id)).content);
        const view = await this.repository.openAttachments(id);
        let attachments: FileArchiveEntry[];
        try { attachments = await exportFileArchive(view as IFileSystem, ['/']); } finally { await view.dispose(); }
        data.attachments = [];
        const children: WorkbenchArchiveItem[] = [];
        for (const child of this.sessions.filter(item => item.parentSessionId === id)) children.push(await this.session(child.id));
        return { kind: 'session', data, attachments, children };
    }
}
