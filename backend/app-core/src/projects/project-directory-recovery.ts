import { randomUUID } from '@itookit/common';
import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { ISessionRepository, SessionFolder } from '@itookit/llm-session';
import type { DirectoryMountService } from '@itookit/app-contracts/services';
import { ProjectRepository, type StoredProject } from './project-repository';

const ROOT = '/home/admin/projects';
type ProjectReference = NonNullable<SessionFolder['project']>;
interface Context {
    root: IFileSystem; repository: ISessionRepository; identities: ProjectRepository; directories: DirectoryMountService;
    check(path: string, reference: ProjectReference): Promise<void>;
}

/** Recover data-bearing directories without moving contents or replacing existing identities. */
export async function recoverProjectDirectories(context: Context): Promise<Map<string, unknown>> {
    const failures = new Map<string, unknown>(), folders = await context.repository.listFolders();
    const active = await context.identities.list();
    const children = await context.root.driver.getChildren(ROOT).catch(error => {
        if (error instanceof FSError && error.code === 'ENOENT') return []; throw error;
    });
    const candidates = new Set(children.filter(child => child.type === 'directory' && child.name !== '.nestos').map(child => child.path));
    for (const folder of folders) if (folder.project?.directory.startsWith('/home/admin/') && folder.project.directory !== ROOT)
        candidates.add(folder.project.directory);
    for (const directory of candidates) {
        if (active.some(project => project.directory === directory)) continue;
        try { await recoverDirectory(context, directory, folders, active); }
        catch (error) {
            failures.set(directory, error);
            console.warn('[Project recovery] Directory conversion failed', { directory, error });
        }
    }
    return failures;
}

async function recoverDirectory(context: Context, directory: string, folders: SessionFolder[], active: StoredProject[]): Promise<void> {
    const owner = await context.directories.inspectDirectory(directory).catch(error => {
        if (error instanceof FSError && error.code === 'ENOENT') return undefined; throw error;
    });
    if (!owner) return;
    let data: boolean;
    try { data = (await owner.fs.driver.getChildren('/', { includeHidden: true, includeInternalDirs: true })).length > 0; }
    finally { await owner.dispose(); }
    if (!data) return;
    const cached = folders.find(folder => folder.project?.directory === directory)
        ?? folders.find(folder => !folder.project && folder.path === '/' + directory.split('/').pop());
    const id = cached?.project?.id ?? randomUUID();
    if (active.some(project => project.id === id)) throw new FSError('ECONFLICT', 'Legacy project identity refers to multiple directories');
    const parent = cached?.parentPath ?? null;
    const base = cached && !cached.path.startsWith('/.retired-project-') ? cached.name : directory.split('/').pop()!;
    let name = base;
    for (let n = 2; active.some(project => project.name === name) || folders.some(folder => folder !== cached && folder.path === `${parent ?? ''}/${name}`); n++) name = `${base} (${n})`;
    const path = `${parent ?? ''}/${name}`, reference: ProjectReference = { id, directory, source: { kind: 'local' } };
    await context.check(path, reference);
    await context.repository.validateProjectSessions?.(`${directory}/.nestos/sessions`);
    await context.identities.adoptLocal(directory, { version: 1, id, name, createdAt: cached?.updatedAt ?? Date.now() });
    if (cached) {
        if (cached.path !== path) await context.repository.renameFolder(cached.path, path);
        await context.repository.promoteProjectFolder!(path, reference);
    } else await context.repository.createFolder(path, reference);
    active.push({ version: 1, id, name, createdAt: Date.now(), directory, kind: 'local' });
    console.info('[Project recovery] Converted directory', { path, projectId: id, directory });
}
