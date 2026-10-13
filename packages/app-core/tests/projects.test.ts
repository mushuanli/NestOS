import { afterEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { SessionRepository, sessionDirectoryStorage } from '@itookit/llm-session';
import { FSError, MemoryBackend, type IStorageBackend } from '@itookit/vfs-core';
import { createApplicationRuntime, type ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { createSessionBrowser, folderBrowserPath } from '../src/session/session-browser';
import { ProjectRepository } from '../src/projects/project-repository';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(backend: IStorageBackend = new MemoryBackend()) {
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'web' });
    cleanups.push(() => runtime.dispose());
    const browser = await createSessionBrowser({ repository: runtime.sessionRepository, files: runtime.sessionFiles,
        projects: runtime.projects, kernel: runtime.kernel.kernel });
    cleanups.push(() => browser.dispose());
    return { ...runtime, browser };
}
async function readSession(runtime: ApplicationRuntime, id: string, path: string) {
    const owner = await runtime.sessionFiles.acquire(id);
    try { return await owner.vfs.readFile(path); } finally { await owner.release(); }
}

it('completes an empty project identity marker without replacing existing records', async () => {
    const r = await setup(), root = await r.vfs.openFileSystem('/');
    const directory = '/home/admin/recovered-workspace', info = directory + '/.mindos/info.seq';
    await root.driver.createFile({ parentPath: directory + '/.mindos', name: 'info.seq', type: 'seqfile', recursive: true });
    await root.meta.seq!.setEntry(info, 'retained', 'existing data');
    const project = await r.projects.ensureDirectory(directory, 'Recovered');
    expect(JSON.parse((await root.meta.seq!.getEntry(info, 'identity'))!).id).toBe(project.project.id);
    expect(await root.meta.seq!.getEntry(info, 'retained')).toBe('existing data');
    expect((await r.projects.ensureDirectory(directory)).project.id).toBe(project.project.id);
    const identities = new ProjectRepository(root, r.directoryMounts);
    await expect(identities.createLocal(directory, { version: 1, id: 'replacement', name: 'Replacement', createdAt: Date.now() }))
        .rejects.toMatchObject({ code: 'EEXIST' });
    expect(JSON.parse((await root.meta.seq!.getEntry(info, 'identity'))!).id).toBe(project.project.id);
});

it('reads a directory header and rows from one workspace and one projection', async () => {
    const r = await setup(), project = (await r.projects.current())!, path = folderBrowserPath(project.path) + '/@files';
    await r.browser.fs.driver.createFile({parentPath: path, name: 'fast.md', content: 'Ready'});
    const open = vi.spyOn(r.projects, 'openWorkspace'), favorites = vi.spyOn(r.projects.favorites, 'list');
    const directory = await r.browser.readFileDirectory(path);
    expect(open).toHaveBeenCalledOnce(); expect(favorites).toHaveBeenCalledOnce();
    expect(directory.node).toMatchObject({path, parentPath: folderBrowserPath(project.path), type: 'directory', metadata: {_fixedEntry: true, _readOnly: false}});
    expect(directory.nodes.map(node => node.name)).toContain('fast.md');
});

it('reuses the catalog when opening a workspace and reuses a caller-owned directory source', async () => {
    const r = await setup(), project = (await r.projects.current())!, path = folderBrowserPath(project.path) + '/@files';
    const catalog = vi.spyOn(r.projects, 'list'), owner = await r.projects.openWorkspace(project.path);
    expect(catalog).toHaveBeenCalledOnce();
    const node = (await owner.fs.driver.getNode('/workspace'))!;
    const getNode = vi.spyOn(owner.fs.driver, 'getNode'), dispose = vi.spyOn(owner, 'dispose');
    const open = vi.spyOn(r.projects, 'openWorkspace'); open.mockClear();
    try {
        expect((await r.browser.readFileDirectory(path, {fs: owner.fs, node})).node.path).toBe(path);
        expect(getNode).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
        const controller = new AbortController(); controller.abort();
        await expect(r.browser.readFileDirectory(path, {signal: controller.signal})).rejects.toMatchObject({code: 'ECANCELLED'});
        expect(open).not.toHaveBeenCalled();
    } finally {await owner.dispose();}
});

it('does not relocate an unknown project owner into the currently selected project', async () => {
    const r = await setup(), current = (await r.projects.current())!;
    const root = await r.vfs.openFileSystem('/');
    const legacy = new SessionRepository(root); await legacy.init();
    await legacy.createFolder('/Orphan');
    await legacy.createFolder('/Orphan/@sessions');
    const id = await legacy.createSession('Unresolved owner', '/Orphan/@sessions');
    await r.projects.adoptSession(id);
    expect((await r.sessionRepository.getManifest(id)).folder).toBe('/Orphan/@sessions');
    expect(await root.driver.exists(`${current.project.directory}/.mindos/sessions/${id}`)).toBe(false);
    expect(await root.driver.exists(`/var/lib/sessions/${id}/session.seq`)).toBe(true);
    await legacy.dispose();
});

it('shares files among project Sessions and isolates other projects', async () => {
    const r = await setup();
    const a = (await r.projects.current())!, b = await r.projects.create('Research');
    const aFolder = await r.projects.sessionFolder(a), bFolder = await r.projects.sessionFolder(b);
    const a1 = await r.sessionRepository.createSession('First', aFolder);
    const a2 = await r.sessionRepository.createSession('Second', aFolder);
    const b1 = await r.sessionRepository.createSession('Other project', bFolder);
    const aFiles = folderBrowserPath(a.path) + '/@files', bFiles = folderBrowserPath(b.path) + '/@files';
    await r.browser.fs.driver.createFile({ parentPath: aFiles, name: 'notes.md', content: 'project A' });
    await r.browser.fs.driver.createFile({ parentPath: bFiles, name: 'notes.md', content: 'project B' });
    expect(await readSession(r, a1, 'notes.md')).toBe('project A');
    expect(await readSession(r, a2, 'notes.md')).toBe('project A');
    expect(await readSession(r, b1, 'notes.md')).toBe('project B');
    const tools = (await r.kernel.sessions.get(a1)).toolService;
    const edit = await tools.invoke({ toolId: 'Edit', args: { file_path: 'notes.md', old_string: 'project A', new_string: 'shared result' } });
    expect(edit.success).toBe(true);
    expect(await r.browser.fs.driver.readContent(aFiles + '/notes.md', { encoding: 'utf-8' })).toBe('shared result');
    expect((await tools.invoke({ toolId: 'Grep', args: { pattern: 'shared', path: '.' } })).success).toBe(true);
    expect(tools.getToolMeta('Bash')?.enabled).toBe(false);
});

it('creates a real project for a workbench root directory and ordinary directories inside its files', async () => {
    const r = await setup();
    const node = await r.browser.fs.driver.createDirectory({ parentPath: '/', name: 'Workbench project' });
    expect(node.metadata.projectId).toBeTruthy();
    const project = await r.projects.get(String(node.metadata.projectId));
    const files = folderBrowserPath(project.path) + '/@files';
    expect((await r.browser.fs.driver.getNode(files))?.metadata._disabled).toBe(false);
    const child = await r.browser.fs.driver.createDirectory({ parentPath: files, name: 'ordinary' });
    expect(child.metadata.projectId).toBeUndefined();
    expect((await r.projects.list()).filter(item => item.project.id === project.project.id)).toHaveLength(1);
    expect(await (await r.vfs.openFileSystem('/')).driver.exists(project.project.directory + '/ordinary')).toBe(true);
});

it('organizes projects and Sessions in folders while keeping identity and files stable', async () => {
    const r = await setup();
    await r.sessionRepository.createFolder('/Work');
    const project = await r.projects.create('Research', '/Work');
    const sessions = await r.projects.sessionFolder(project);
    await r.sessionRepository.createFolder(sessions + '/Ideas');
    const id = await r.sessionRepository.createSession('Plan', sessions + '/Ideas');
    const prefix = folderBrowserPath(project.path);
    await r.browser.fs.driver.createDirectory({ parentPath: prefix + '/@files', name: 'drafts' });
    await r.browser.fs.driver.createFile({ parentPath: prefix + '/@files/drafts', name: 'plan.md', content: 'keep' });
    await r.browser.fs.driver.rename(prefix, 'Renamed');
    const renamed = (await r.projects.list()).find(item => item.project.id === project.project.id)!;
    expect(renamed.path).toBe('/Work/Renamed');
    expect(renamed.project.directory).toBe(project.project.directory);
    expect((await r.sessionRepository.getManifest(id)).folder).toBe('/Work/Renamed/@sessions/Ideas');
    expect(await readSession(r, id, 'drafts/plan.md')).toBe('keep');
    const files = folderBrowserPath(renamed.path) + '/@files';
    await r.browser.fs.driver.createDirectory({ parentPath: files, name: 'archive' });
    await r.browser.fs.driver.move([files + '/drafts/plan.md'], files + '/archive');
    await r.browser.fs.driver.rename(files + '/archive/plan.md', 'final.md');
    expect(await readSession(r, id, 'archive/final.md')).toBe('keep');
    await r.browser.fs.driver.delete([files + '/archive/final.md']);
    await expect(readSession(r, id, 'archive/final.md')).rejects.toThrow();
});

it('moves Sessions across projects and protects project sections', async () => {
    const r = await setup();
    const a = (await r.projects.current())!, b = await r.projects.create('Other');
    const aFolder = await r.projects.sessionFolder(a), bFolder = await r.projects.sessionFolder(b);
    const id = await r.sessionRepository.createSession('Conversation', aFolder);
    const child = await r.sessionRepository.createSession('Child', aFolder, id);
    await r.projects.favorites.toggle(a.project.id, { kind: 'session', sessionId: id }, 'Conversation');
    await r.projects.favorites.toggle(a.project.id, { kind: 'session', sessionId: child }, 'Child');
    await r.projects.favorites.toggle(a.project.id, { kind: 'file', path: '/workspace/a.md', nodeType: 'file' }, 'a.md');
    await r.browser.fs.driver.move([folderBrowserPath(aFolder) + '/' + id], folderBrowserPath(bFolder));
    expect((await r.sessionRepository.getManifest(id)).folder).toBe(bFolder);
    expect((await r.sessionRepository.getManifest(child)).folder).toBe(bFolder);
    const config = await r.sessionFiles.inspect(child);
    expect(r.directoryMounts.describe(config!.mounts.find(mount => mount.at === '/workspace')!)).toBe(b.project.directory);
    expect((await r.projects.favorites.list(a.project.id)).map(item => item.target.kind)).toEqual(['file']);
    expect((await r.projects.favorites.list(b.project.id)).map(item => item.target)).toEqual([
        { kind: 'session', sessionId: id }, { kind: 'session', sessionId: child },
    ]);
    expect(await r.projects.sessionMoves.ready(id)).toBe(true);
    await r.browser.fs.driver.delete([folderBrowserPath(a.path) + '/@files'], { recursive: true });
    expect(await r.browser.fs.driver.exists(folderBrowserPath(a.path) + '/@files')).toBe(true);
    await expect(r.browser.fs.driver.rename(folderBrowserPath(aFolder), 'Hidden')).rejects.toThrow();
});

it('retains a failed Session move and resumes workspace and favorites without duplicating entries', async () => {
    const r = await setup();
    const a = (await r.projects.current())!, b = await r.projects.create('Recovery');
    const id = await r.sessionRepository.createSession('Conversation', await r.projects.sessionFolder(a));
    await r.projects.favorites.toggle(a.project.id, { kind: 'session', sessionId: id }, 'Conversation');
    const failure = vi.spyOn(r.directoryMounts, 'setWorkspace').mockRejectedValueOnce(new Error('interrupted'));
    await expect(r.projects.sessionMoves.move(id, await r.projects.sessionFolder(b))).rejects.toThrow('interrupted');
    expect((await r.sessionRepository.getManifest(id)).folder).toBe(b.path + '/@sessions');
    expect(await r.projects.sessionMoves.ready(id)).toBe(false);
    await expect(r.sessionFiles.acquireFiles(id)).rejects.toMatchObject({ code: 'EBUSY' });
    failure.mockRestore();
    await r.projects.sessionMoves.recover(id);
    await r.projects.sessionMoves.recover(id);
    expect(await r.projects.sessionMoves.ready(id)).toBe(true);
    expect(await r.projects.favorites.list(a.project.id)).toEqual([]);
    expect(await r.projects.favorites.list(b.project.id)).toHaveLength(1);
    const config = await r.sessionFiles.inspect(id);
    expect(r.directoryMounts.describe(config!.mounts.find(mount => mount.at === '/workspace')!)).toBe(b.project.directory);
});

it('finishes a persisted Session move after reopening the application', async () => {
    const backend = new IndexedDBBackend({ dbName: `session-move-${crypto.randomUUID()}` });
    const first = await createApplicationRuntime({ backend, ownerKind: 'web' });
    const source = (await first.projects.current())!, target = await first.projects.create('Recovered');
    const id = await first.sessionRepository.createSession('Conversation', await first.projects.sessionFolder(source));
    await first.kernel.sessions.get(id);
    await first.projects.favorites.toggle(source.project.id, { kind: 'session', sessionId: id }, 'Conversation');
    const failure = vi.spyOn(first.directoryMounts, 'setWorkspace').mockRejectedValueOnce(new Error('interrupted'));
    await expect(first.projects.sessionMoves.move(id, await first.projects.sessionFolder(target))).rejects.toThrow('interrupted');
    failure.mockRestore(); await first.dispose();
    const reopened = await createApplicationRuntime({ backend, ownerKind: 'web' });
    cleanups.push(() => reopened.dispose());
    await vi.waitFor(async () => expect(await reopened.projects.sessionMoves.ready(id)).toBe(true));
    const config = await reopened.sessionFiles.inspect(id);
    expect(reopened.directoryMounts.describe(config!.mounts.find(mount => mount.at === '/workspace')!)).toBe(target.project.directory);
    expect(await reopened.projects.favorites.list(source.project.id)).toEqual([]);
    expect(await reopened.projects.favorites.list(target.project.id)).toHaveLength(1);
});

it('fixes the workspace to its project while allowing additional mounts to be managed', async () => {
    const r = await setup();
    const a = (await r.projects.current())!, b = await r.projects.create('Reference');
    const id = await r.sessionRepository.createSession('Bound', await r.projects.sessionFolder(a));
    const primary = (await r.sessionFiles.inspect(id))!.mounts[0];
    const mounts = r.directoryMounts;
    expect(await mounts.fixedWorkspace(id)).toBe(a.project.directory);
    await mounts.addDirectory(id, b.project.directory, 'ro', '/reference');
    const before = (await r.sessionFiles.inspect(id))!;
    const extra = before.mounts.find(m => m.at === '/reference')!;
    await mounts.setHome(b.project.directory);
    const attempts = [
        () => mounts.setWorkspace(id, b.project.directory),
        () => mounts.remove(id, primary.mountId),
        () => mounts.update(id, primary.mountId, 'ro', false),
        () => mounts.update(id, extra.mountId, 'ro', true),
        () => mounts.addDirectory(id, a.project.directory, 'rw', '/renamed'),
        () => mounts.addDirectory(id, b.project.directory, 'rw', '/reference', true),
        () => mounts.mountHome(id),
    ];
    for (const attempt of attempts) {
        await expect(attempt()).rejects.toThrow();
        expect(await r.sessionFiles.inspect(id)).toEqual(before);
    }
    await mounts.update(id, extra.mountId, 'rw', false);
    await mounts.reconnect(id, primary.mountId);
    await mounts.remove(id, extra.mountId);
    expect((await r.sessionFiles.inspect(id))!.mounts).toEqual([primary]);
    const owner = await r.sessionFiles.acquire(id);
    try { await owner.vfs.writeFile('editable.txt', 'still writable'); } finally { await owner.release(); }
    expect(await readSession(r, id, 'editable.txt')).toBe('still writable');
});

it('restores the default project after reopening persistent storage', async () => {
    const dbName = `project-reopen-${crypto.randomUUID()}`;
    const backend = new IndexedDBBackend({ dbName });
    const first = await createApplicationRuntime({ backend, ownerKind: 'web' });
    const project = (await first.projects.current())!;
    const id = await first.sessionRepository.createSession('Remember me');
    const owner = await first.projects.openFiles(project.path);
    await owner.fs.driver.createFile({ parentPath: '/', name: 'remember.md', content: 'persisted' });
    await owner.dispose(); await first.dispose();
    const second = await setup(new IndexedDBBackend({ dbName }));
    expect((await second.projects.current())?.project).toEqual(project.project);
    expect((await second.projects.list()).length).toBe(1);
    expect((await second.sessionRepository.getManifest(id)).folder).toBe(project.path + '/@sessions');
    expect(await readSession(second, id, 'remember.md')).toBe('persisted');
});

it('adopts the legacy personal project by label and retains its identity after a rename', async () => {
    const r = await setup();
    const personal = await r.projects.personal();
    const root = await r.vfs.openFileSystem('/');
    await root.driver.delete(['/etc/personal-project.json']);
    await r.projects.create('AAA unrelated');
    expect((await r.projects.personal()).project.id).toBe(personal.project.id);
    await r.projects.renameProject(personal.path, '/Renamed');
    expect((await r.projects.personal()).path).toBe('/Renamed');
    expect(JSON.parse(await root.driver.readContent('/etc/personal-project.json', { encoding: 'utf-8' })).id)
        .toBe(personal.project.id);
});

it('ignores move and delete of the fixed Files entry while leaving its contents writable', async () => {
    const r = await setup();
    const project = await r.projects.create('Fixed entries');
    const prefix = folderBrowserPath(project.path), files = prefix + '/@files';
    await r.browser.fs.driver.createFile({ parentPath: files, name: 'keep.txt', content: 'keep' });
    expect((await r.browser.fs.driver.getNode(files))?.metadata._fixedEntry).toBe(true);
    await r.browser.fs.driver.delete([files], { recursive: true });
    await r.browser.fs.driver.move([files], '/');
    expect(await r.browser.fs.driver.exists(files)).toBe(true);
    expect(await r.browser.fs.driver.readContent(files + '/keep.txt', { encoding: 'utf-8' })).toBe('keep');
    await r.browser.fs.driver.delete([files + '/keep.txt']);
    expect(await r.browser.fs.driver.exists(files + '/keep.txt')).toBe(false);
    await r.browser.fs.driver.rename(prefix, 'Renamed fixed');
    expect(await r.browser.fs.driver.exists(folderBrowserPath('/Renamed fixed') + '/@files')).toBe(true);
    await r.browser.fs.driver.delete([folderBrowserPath('/Renamed fixed')], { recursive: true });
    expect((await r.projects.list()).some(item => item.project.id === project.project.id)).toBe(false);
});

it('keeps favorites aligned with committed file moves, subtree deletion and Session changes', async () => {
    const r = await setup(), project = (await r.projects.current())!;
    const favorites = r.projects.favorites, id = project.project.id;
    let owner = await r.projects.openWorkspace(project.path);
    await owner.fs.driver.createFile({ parentPath: '/workspace/docs', name: 'note.md', content: 'note', recursive: true });
    await owner.fs.driver.createDirectory({ parentPath: '/workspace', name: 'archive' });
    await favorites.toggle(id, { kind: 'file', path: '/workspace/docs', nodeType: 'directory' }, 'docs');
    await favorites.toggle(id, { kind: 'file', path: '/workspace/docs/note.md', nodeType: 'file' }, 'note');
    await owner.fs.driver.rename('/workspace/docs', 'renamed');
    await owner.dispose();
    expect((await favorites.list(id)).map(item => item.target)).toEqual([
        { kind: 'file', path: '/workspace/renamed', nodeType: 'directory' },
        { kind: 'file', path: '/workspace/renamed/note.md', nodeType: 'file' },
    ]);
    owner = await r.projects.openWorkspace(project.path);
    await owner.fs.driver.move(['/workspace/renamed'], '/workspace/archive'); await owner.dispose();
    expect((await favorites.list(id))[1].target).toMatchObject({ path: '/workspace/archive/renamed/note.md' });
    owner = await r.projects.openWorkspace(project.path);
    await owner.fs.driver.delete(['/workspace/archive'], { recursive: true }); await owner.dispose();
    expect(await favorites.list(id)).toEqual([]);
    const session = await r.sessionRepository.createSession('Old title', await r.projects.sessionFolder(project));
    await favorites.toggle(id, { kind: 'session', sessionId: session }, 'Old title');
    await r.sessionRepository.updateManifest(session, { title: 'New title' });
    expect((await favorites.list(id))[0].title).toBe('New title');
    await r.sessionRepository.deleteSession(session);
    expect(await favorites.list(id)).toEqual([]);
});

it('copies and moves nested project files across projects without overwriting collisions', async () => {
    const r = await setup();
    const a = (await r.projects.current())!, b = await r.projects.create('Copy target');
    const from = folderBrowserPath(a.path) + '/@files', to = folderBrowserPath(b.path) + '/@files';
    await r.browser.fs.driver.createFile({ name: 'a.md', parentPath: from + '/nested', content: 'source', recursive: true });
    await r.browser.transferItems('copy', [from + '/nested', from + '/nested/a.md'], to);
    expect(await r.browser.fs.driver.readContent(to + '/nested/a.md', { encoding: 'utf-8' })).toBe('source');
    expect(await r.browser.fs.driver.exists(from + '/nested/a.md')).toBe(true);
    await expect(r.browser.transferItems('move', [from + '/nested'], to)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await r.browser.fs.driver.exists(from + '/nested')).toBe(true);
    await r.browser.fs.driver.createDirectory({ name: 'moved', parentPath: to });
    await r.browser.transferItems('move', [from + '/nested'], to + '/moved');
    expect(await r.browser.fs.driver.exists(from + '/nested')).toBe(false);
    expect(await r.browser.fs.driver.readContent(to + '/moved/nested/a.md', { encoding: 'utf-8' })).toBe('source');
    await expect(r.browser.transferItems('copy', [from], to)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(r.browser.transferItems('copy', [to + '/nested'], folderBrowserPath(a.path))).rejects.toMatchObject({ code: 'EACCES' });
});

it('rejects duplicate, descendant and ancestor project roots before changing storage', async () => {
    const r = await setup(), a = (await r.projects.current())!;
    const from = folderBrowserPath(a.path) + '/@files';
    await r.browser.fs.driver.createFile({ parentPath: from, name: 'keep.md', content: 'keep' });
    for (const directory of [a.project.directory, a.project.directory + '/child', '/home/admin/projects', '/home/admin']) {
        await expect(r.projects.create('Invalid root', null, directory)).rejects.toMatchObject({ code: 'EACCES', reason: 'PROJECT_ROOT_OVERLAP' });
    }
    expect((await r.projects.list()).some(project => project.name === 'Invalid root')).toBe(false);
    expect(await (await r.vfs.openFileSystem('/')).driver.exists(a.project.directory + '/child')).toBe(false);
    expect(await r.browser.fs.driver.readContent(from + '/keep.md', { encoding: 'utf-8' })).toBe('keep');
});

it('serializes competing local root registrations so only one project owns the directory', async () => {
    const r = await setup(), directory = '/home/admin/independent';
    await (await r.vfs.openFileSystem('/')).driver.createDirectory({ parentPath: '/home/admin', name: 'independent' });
    const results = await Promise.allSettled([r.projects.create('First owner', null, directory), r.projects.create('Second owner', null, directory)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { reason: 'PROJECT_ROOT_OVERLAP' } });
    expect((await r.projects.list()).filter(project => project.project.directory === directory)).toHaveLength(1);
});

it('uses directory identities as the authority and rediscovers projects after clearing the navigation cache', async () => {
    const r = await setup(), project = await r.projects.create('Portable');
    const root = await r.vfs.openFileSystem('/');
    const info = project.project.directory + '/.mindos/info.seq';
    expect(JSON.parse((await root.meta.seq!.getEntry(info, 'identity'))!).id).toBe(project.project.id);
    await r.sessionRepository.deleteFolder(project.path, true);
    expect((await r.projects.get(project.project.id)).project.directory).toBe(project.project.directory);
    await r.projects.initializeSources();
    expect((await r.sessionRepository.listFolders()).find(folder => folder.project?.id === project.project.id)?.path).toBe(project.path);
    await root.driver.delete([project.project.directory], { recursive: true });
    expect((await r.projects.list()).some(item => item.project.id === project.project.id)).toBe(false);
    expect((await r.browser.fs.driver.getChildren('/')).some(item => item.metadata.projectId === project.project.id)).toBe(false);
    expect(await root.driver.exists(project.project.directory)).toBe(false);
});

it('stores portable conversation files inside the project and keeps execution controls separate', async () => {
    const backend = new IndexedDBBackend({ dbName: `portable-project-${crypto.randomUUID()}` });
    const first = await createApplicationRuntime({ backend, ownerKind: 'web' });
    const project = (await first.projects.current())!;
    const id = await first.sessionRepository.createSession('Conversation', await first.projects.sessionFolder(project));
    await first.sessionRepository.writeDocument(id, 'round-one.json', '{"text":"portable"}');
    const root = await first.vfs.openFileSystem('/');
    expect(await root.driver.exists(`${project.project.directory}/.mindos/sessions/${id}/history.seq`)).toBe(true);
    expect(await root.meta.seq!.getEntry(`/var/lib/sessions/${id}/session.seq`, 'session')).toBeNull();
    await first.dispose();
    const reopened = await createApplicationRuntime({ backend, ownerKind: 'web' }); cleanups.push(() => reopened.dispose());
    expect(await reopened.sessionRepository.readDocument(id, 'round-one.json')).toBe('{"text":"portable"}');
    expect((await reopened.sessionRepository.list()).map(session => session.id)).toContain(id);
});

it('shows expected permission failures as unavailable without swallowing unrelated IO faults', async () => {
    const r = await setup(), project = (await r.projects.current())!;
    const prefix = folderBrowserPath(project.path);
    const readonly = vi.spyOn(r.projects, 'workspaceReadOnly').mockRejectedValue(new FSError('EACCES', 'Access revoked'));
    try {
        expect((await r.browser.fs.driver.getChildren(prefix)).find(node => node.path === prefix + '/@files')?.metadata._disabled).toBe(true);
        readonly.mockRejectedValue(new Error('unexpected disk failure'));
        await expect(r.browser.fs.driver.getChildren(prefix)).rejects.toMatchObject({ code: 'EIO' });
    } finally { readonly.mockRestore(); }
});


it('boots existing central Sessions into project storage without moving their runtime grants', async () => {
    const backend = new IndexedDBBackend({ dbName: `central-session-${crypto.randomUUID()}` });
    const first = await createApplicationRuntime({ backend, ownerKind: 'web' });
    const project = (await first.projects.current())!;
    const root = await first.vfs.openFileSystem('/');
    const legacy = new SessionRepository(root); await legacy.init();
    const id = await legacy.createSession('Before project storage', await first.projects.sessionFolder(project));
    await legacy.writeDocument(id, 'round.json', '{"text":"saved"}');
    await first.kernel.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    await first.directoryMounts.setWorkspace(id, project.project.directory);
    const before = await first.sessionFiles.inspect(id);
    await legacy.dispose(); await first.dispose();
    const reopened = await createApplicationRuntime({ backend, ownerKind: 'web' });
    cleanups.push(() => reopened.dispose());
    const files = await reopened.vfs.openFileSystem('/');
    expect(await reopened.sessionRepository.readDocument(id, 'round.json')).toBe('{"text":"saved"}');
    await vi.waitFor(async () => expect(await files.driver.exists(`${project.project.directory}/.mindos/sessions/${id}/history.seq`)).toBe(true));
    expect((await reopened.sessionFiles.inspect(id))?.mounts).toEqual(before?.mounts);
    expect(await files.driver.exists(`/var/lib/sessions/${id}/kernel`)).toBe(true);
});


it('frees a missing project name without deleting retained Sessions', async () => {
    const runtime = await setup();
    const root = await runtime.vfs.openFileSystem('/');
    const original = '/home/admin/projects/old-project';
    await root.driver.createFile({ parentPath: '/home/admin', name: 'retained.md', content: 'original' });
    await runtime.sessionRepository.createFolder('/Hidden', { id: 'old-project', directory: original });
    await runtime.sessionRepository.createFolder('/Hidden/@sessions');
    const old = new SessionRepository(root); await old.init();
    const id = await old.createSession('Old history', '/Hidden/@sessions');
    await old.writeDocument(id, 'round.json', '{"text":"keep"}');
    await old.dispose();
    expect((await runtime.projects.list()).some(project => project.path === '/Hidden')).toBe(false);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const created = await runtime.projects.create('Hidden');
        expect(created.project.id).not.toBe('old-project');
        expect(created.project.directory).not.toBe(original);
        expect((await runtime.projects.list()).filter(project => project.path === '/Hidden')).toHaveLength(1);
        expect(await root.driver.readContent('/home/admin/retained.md', { encoding: 'utf-8' })).toBe('original');
        const archived = (await runtime.sessionRepository.listFolders()).find(folder => folder.project?.id === 'old-project')!;
        expect(archived.path).toMatch(/^\/\.retired-project-old-project-/);
        expect((await runtime.sessionRepository.getManifest(id)).folder).toBe(archived.path + '/@sessions');
        expect(await runtime.sessionRepository.readDocument(id, 'round.json')).toBe('{"text":"keep"}');
        expect(warning).toHaveBeenCalledWith('[Project index] Reconciled stale name', expect.objectContaining({ projectId: 'old-project' }));
        await expect(runtime.projects.create('Hidden')).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { warning.mockRestore(); }
});


it('does not let an invisible old folder cache reserve a project name', async () => {
    const runtime = await setup();
    await runtime.sessionRepository.createFolder('/Ghost');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        expect((await runtime.projects.navigationFolders()).some(folder => folder.path === '/Ghost')).toBe(false);
        expect((await runtime.projects.create('Ghost')).path).toBe('/Ghost');
    } finally { warning.mockRestore(); }
});


it('converts data-bearing legacy directories using the original project identity and Session ownership', async () => {
    const runtime = await setup();
    const root = await runtime.vfs.openFileSystem('/');
    const directory = '/home/admin/projects/legacy-data';
    await root.driver.createFile({ parentPath: directory + '/src', name: 'keep.md', content: 'saved', recursive: true });
    await runtime.sessionRepository.createFolder('/Recovered', { id: 'legacy-data', directory });
    await runtime.sessionRepository.createFolder('/Recovered/@sessions');
    const old = new SessionRepository(root); await old.init();
    const id = await old.createSession('Existing history', '/Recovered/@sessions');
    await old.writeDocument(id, 'round.json', '{"text":"retained"}'); await old.dispose();
    await runtime.projects.initializeSources();
    const recovered = await runtime.projects.get('legacy-data');
    expect(recovered.path).toBe('/Recovered'); expect(recovered.project.directory).toBe(directory);
    expect(JSON.parse((await root.meta.seq!.getEntry(`${directory}/.mindos/info.seq`, 'identity'))!).id).toBe('legacy-data');
    expect((await runtime.sessionRepository.getManifest(id)).folder).toBe('/Recovered/@sessions');
    expect(await runtime.sessionRepository.readDocument(id, 'round.json')).toBe('{"text":"retained"}');
    const files = await runtime.projects.openFiles(recovered.path);
    try { expect(await files.fs.driver.readContent('/src/keep.md', { encoding: 'utf-8' })).toBe('saved'); }
    finally { await files.dispose(); }
    await runtime.projects.initializeSources();
    expect((await runtime.projects.list()).filter(project => project.project.id === 'legacy-data')).toHaveLength(1);
    await expect(runtime.projects.create('Recovered')).rejects.toMatchObject({ code: 'EEXIST' });
});

it.each([false, true])('registers a workbench data directory as a project (old folder cache: %s)', async cached => {
    const runtime = await setup();
    const root = await runtime.vfs.openFileSystem('/');
    await root.driver.createFile({ parentPath: '/home/admin/projects/Loose/child', name: 'note.md', content: 'keep', recursive: true });
    if (cached) await runtime.sessionRepository.createFolder('/Loose');
    await runtime.projects.initializeSources();
    const project = (await runtime.projects.list()).find(project => project.path === '/Loose')!;
    expect(project.project.directory).toBe('/home/admin/projects/Loose');
    expect((await runtime.projects.list()).some(project => project.name === 'child')).toBe(false);
    expect((await runtime.sessionRepository.listFolders()).find(folder => folder.path === '/Loose')?.project?.id).toBe(project.project.id);
    expect(await root.driver.readContent('/home/admin/projects/Loose/child/note.md', { encoding: 'utf-8' })).toBe('keep');
});

it('retains an unreadable legacy directory and its index instead of treating it as missing', async () => {
    const runtime = await setup();
    const root = await runtime.vfs.openFileSystem('/');
    const directory = '/home/admin/projects/unreadable-old';
    await root.driver.createFile({ parentPath: directory, name: 'data.md', content: 'retain', recursive: true });
    await runtime.sessionRepository.createFolder('/Unreadable', { id: 'unreadable-old', directory });
    const getChildren = root.driver.getChildren.bind(root.driver);
    const scan = vi.spyOn(root.driver, 'getChildren').mockImplementation((path, options) =>
        path === directory ? Promise.reject(new FSError('EIO', 'Temporary scan failure')) : getChildren(path, options));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        await expect(runtime.projects.create('Unreadable')).rejects.toMatchObject({ code: 'EIO' });
        expect((await runtime.sessionRepository.listFolders()).find(folder => folder.project?.id === 'unreadable-old')?.path).toBe('/Unreadable');
        expect(await root.driver.exists(`${directory}/.mindos/info.seq`)).toBe(false);
    } finally { scan.mockRestore(); warning.mockRestore(); }
    await runtime.projects.initializeSources();
    expect((await runtime.projects.get('unreadable-old')).path).toBe('/Unreadable');
    expect(await root.driver.readContent(`${directory}/data.md`, { encoding: 'utf-8' })).toBe('retain');
});

it('recovers an old data directory and its conversation during IndexedDB application startup', async () => {
    const backend = new IndexedDBBackend({ dbName: `legacy-directory-${crypto.randomUUID()}` });
    const first = await createApplicationRuntime({ backend, ownerKind: 'web' });
    const root = await first.vfs.openFileSystem('/'), directory = '/home/admin/projects/old-startup';
    await root.driver.createFile({ parentPath: directory, name: 'old.md', content: 'original file', recursive: true });
    await first.sessionRepository.createFolder('/Old startup', { id: 'old-startup', directory });
    await first.sessionRepository.createFolder('/Old startup/@sessions');
    const legacy = new SessionRepository(root); await legacy.init();
    const id = await legacy.createSession('Original conversation', '/Old startup/@sessions');
    await legacy.writeDocument(id, 'round.json', '{"text":"original conversation"}');
    await first.kernel.kernel.createSession({ id, storage: sessionDirectoryStorage(id) });
    await first.directoryMounts.setWorkspace(id, directory);
    await legacy.dispose(); await first.dispose();
    const reopened = await createApplicationRuntime({ backend, ownerKind: 'web' });
    cleanups.push(() => reopened.dispose());
    expect((await reopened.projects.get('old-startup')).path).toBe('/Old startup');
    expect((await reopened.sessionRepository.getManifest(id)).folder).toBe('/Old startup/@sessions');
    expect(await reopened.sessionRepository.readDocument(id, 'round.json')).toBe('{"text":"original conversation"}');
    await vi.waitFor(async () => expect(await (await reopened.vfs.openFileSystem('/')).driver.exists(`${directory}/.mindos/sessions/${id}/history.seq`)).toBe(true));
    expect(await readSession(reopened, id, 'old.md')).toBe('original file');
    expect(await (await reopened.vfs.openFileSystem('/')).driver.exists(`${directory}/.mindos/sessions/${id}/history.seq`)).toBe(true);
});

it('projects an empty Sessions section when a discovered project has no organization record', async () => {
    const runtime = await setup(), project = await runtime.projects.create('learn');
    const section = project.path + '/@sessions', route = folderBrowserPath(section);
    await runtime.sessionRepository.deleteFolder(section);
    const writes = vi.spyOn(runtime.sessionRepository, 'createFolder');
    try {
        const snapshot = await runtime.projects.sessions.navigation();
        expect(snapshot.folders.filter(folder => folder.path === section)).toEqual([
            expect.objectContaining({ name: '@sessions', parentPath: project.path }),
        ]);
        const listing = await runtime.browser.fs.driver.getChildren(folderBrowserPath(project.path));
        expect(listing.some(node => node.path === route)).toBe(true);
        expect((await runtime.browser.fs.driver.getNode(route))?.type).toBe('directory');
        expect(await runtime.browser.fs.driver.getChildren(route)).toEqual([]);
        expect((await runtime.sessionRepository.listFolders()).some(folder => folder.path === section)).toBe(false);
        expect(writes).not.toHaveBeenCalled();
        await runtime.projects.sessionFolder(project);
        expect((await runtime.projects.sessions.navigation()).folders.filter(folder => folder.path === section)).toHaveLength(1);
        runtime.browser.invalidateNavigation();
        const id = await runtime.sessionRepository.createSession('First', section);
        expect((await runtime.browser.fs.driver.getChildren(route)).map(node => node.path)).toContain(route + '/' + id);
    } finally { writes.mockRestore(); }
});
