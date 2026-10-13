import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { createSessionBrowser, resolveBrowserTarget } from '../src/session/session-browser';
import { SessionLifecycleService } from '../src/session/session-lifecycle';
import { SessionFilesService } from '../src/vfs/session-files';
let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup = []; });
async function setup(kernelOverrides: Record<string, unknown> = {}) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init(); cleanup.push(() => repository.dispose());
    const a = await repository.createSession('会话 A'), b = await repository.createSession('会话 B');
    const files = new SessionFilesService(root); await files.initialize(); cleanup.push(() => files.dispose());
    const home = await manager.openFileSystem('/home/admin');
    await home.driver.createFile({ parentPath: '/project', name: 'same.md', content: 'mapped', recursive: true });
    files.registerSource('home', home); await files.configure(a, { mounts: [{ mountId: 'work', sourceId: 'home', at: '/workspace', root: '/project', access: 'rw' }], cwd: '/workspace' }, 0);
    const task = { id: 't', sessionId: a, program: { kind: 'test' }, status: 'succeeded', version: 2, createdAt: 1, updatedAt: 2, input: 'hello', output: 'done', effects: {}, currentAttempt: { leaseToken: 'private-token' } };
    const kernel = { async *listSessions() { yield { id: a }; }, listSessionTasks: vi.fn(async () => [task]),
        listSessionTaskPage: vi.fn(async () => ({ items: [task], throughIndex: 2, nextAfterIndex: 1 })),
        task: vi.fn(async (sid: string, tid: string) => { if (sid !== a || tid !== 't') throw new Error('Task unavailable'); return task; }),
        taskHistory: vi.fn(async () => [{ ...task, status: 'created', version: 1 }, task]),
        closeSession: vi.fn(async () => {}), sessionStat: vi.fn(async () => ({ phase: 'closed' })),
        removeSession: vi.fn(async () => true), ...kernelOverrides };
    const lifecycle = new SessionLifecycleService({ repository, kernel: kernel as any }, { closeTimeoutMs: 20, closePollMs: 1 });
    const browser = await createSessionBrowser({ repository, files, kernel: kernel as any, lifecycle }); cleanup.push(() => browser.dispose());
    return { a, b, files, repository, browser, kernel, lifecycle };
}
describe('Session browser projection', () => {
    it('reads Session directory rows and their header with one file lease', async () => {
        const f = await setup(), acquire = vi.spyOn(f.files, 'acquireFiles');
        const directory = await f.browser.readFileDirectory(`/${f.a}/files`);
        expect(acquire).toHaveBeenCalledOnce();
        expect(directory.node).toMatchObject({path: `/${f.a}/files`, parentPath: `/${f.a}`, metadata: {title: '文件'}});
        expect(directory.nodes.map(node => node.name)).toContain('workspace');
    });
    it('emits canonical folder rename paths and keeps Session identities stable', async () => {
        const f = await setup();
        await f.repository.createFolder('/原项目文档');
        const from = '/folder:' + encodeURIComponent('原项目文档'), to = '/folder:' + encodeURIComponent('新项目文档');
        const renamed = vi.fn(); const stop = f.browser.fs.on('node:renamed', renamed);
        try {
            await f.browser.fs.driver.rename(from, '新项目文档');
            expect(renamed).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
                nodes: [expect.objectContaining({ oldPath: from, newPath: to })],
            }) }));
            expect(await f.browser.fs.driver.getNode(to)).not.toBeNull();
            expect(await f.browser.fs.driver.getNode(from)).toBeNull();
            await f.browser.fs.driver.rename('/' + f.a, 'Updated Session');
            expect((await f.browser.fs.driver.getNode('/' + f.a))?.metadata.title).toBe('Updated Session');
            expect(renamed).toHaveBeenCalledOnce();
            await expect(f.browser.fs.driver.rename(to, 'invalid/name')).rejects.toMatchObject({ code: 'EINVAL' });
        } finally { stop(); }
    });

    it('shares one catalog across expanded folders and refreshes after changes or explicit reload', async () => {
        const f = await setup();
        await f.repository.createFolder('/Work');
        await f.repository.createFolder('/Work/Child');
        const list = vi.spyOn(f.repository, 'listSummariesInFolder');
        await f.browser.fs.driver.getChildren('/');
        await f.browser.fs.driver.getChildren('/folder:Work');
        await f.browser.fs.driver.getChildren('/folder:Work/folder:Child');
        expect(list).toHaveBeenCalledTimes(3);
        await f.repository.updateManifest(f.a, { folder: '/Work', title: 'Moved' });
        list.mockClear();
        expect((await f.browser.fs.driver.getChildren('/folder:Work')).map(node => node.metadata.title)).toContain('Moved');
        expect(list).toHaveBeenCalledTimes(1);
        f.browser.invalidateNavigation();
        await f.browser.fs.driver.getChildren('/folder:Work');
        expect(list).toHaveBeenCalledTimes(2);
    });
    it('reuses one root catalog across repeated root reads', async () => {
        const f = await setup();
        await f.repository.createFolder('/Work');
        const list = vi.spyOn(f.repository, 'listSummariesInFolder');
        const folders = vi.spyOn(f.repository, 'listFolders');
        const first = await f.browser.fs.driver.getChildren('/');
        const second = await f.browser.fs.driver.getChildren('/');
        expect(second.map(node => node.path)).toEqual(first.map(node => node.path));
        expect(list).toHaveBeenCalledTimes(1);
        expect(folders).toHaveBeenCalledTimes(1);
    });
    it('invalidates the root catalog after a repository or browser write', async () => {
        const f = await setup();
        const list = vi.spyOn(f.repository, 'listSummariesInFolder');
        await f.browser.fs.driver.getChildren('/');
        await f.repository.updateManifest(f.a, { title: 'Renamed' });
        expect((await f.browser.fs.driver.getChildren('/')).find(node => node.path === '/' + f.a)?.metadata.title).toBe('Renamed');
        expect(list).toHaveBeenCalledTimes(2);
        const before = await f.browser.fs.driver.getChildren('/');
        const created = await f.browser.fs.driver.createFile({ name: 'New Session', parentPath: '/', content: 'plain' });
        const after = await f.browser.fs.driver.getChildren('/');
        expect(after.map(node => node.path)).toContain(created.path);
        expect(after).toHaveLength(before.length + 1);
        await f.browser.fs.driver.rename(created.path, 'Renamed Session');
        expect((await f.browser.fs.driver.getChildren('/')).find(node => node.path === created.path)?.metadata.title).toBe('Renamed Session');
        await f.browser.fs.driver.delete([created.path]);
        expect((await f.browser.fs.driver.getChildren('/')).map(node => node.path)).not.toContain(created.path);
    });
    it('serves folder stats from the shared catalog', async () => {
        const f = await setup();
        await f.repository.createFolder('/Work');
        await f.browser.fs.driver.getChildren('/');
        const list = vi.spyOn(f.repository, 'listSummariesInFolder'), folders = vi.spyOn(f.repository, 'listFolders');
        expect((await f.browser.fs.driver.getNode('/folder:Work'))?.metadata.title).toBe('Work');
        expect(folders).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        await f.repository.createFolder('/Other');
        expect((await f.browser.fs.driver.getNode('/folder:Other'))?.metadata.title).toBe('Other');
        expect(folders).toHaveBeenCalledTimes(1);
    });
    it('retries a failed navigation read', async () => {
        const f = await setup();
        await f.repository.createFolder('/Work');
        const list = vi.spyOn(f.repository, 'listSummariesInFolder').mockRejectedValueOnce(new Error('Read failed'));
        await expect(f.browser.fs.driver.getChildren('/folder:Work')).rejects.toMatchObject({ code: 'EIO' });
        await expect(f.browser.fs.driver.getChildren('/folder:Work')).resolves.toEqual([]);
        expect(list).toHaveBeenCalledTimes(2);
    });
    it('deletes a Session without traversing its mounted workspace or Task previews', async () => {
        const f = await setup();
        const owner = await f.files.acquireFiles(f.a); cleanup.push(() => owner.release());
        for (let index = 0; index < 64; index++) {
            await owner.context.fs.driver.createFile({ parentPath: '/workspace', name: `source-${index}.ts`, content: 'keep' });
        }
        const acquire = vi.spyOn(f.files, 'acquireFiles');
        const manifest = vi.spyOn(f.repository, 'getManifest');
        const started = performance.now();
        await f.browser.fs.driver.delete(['/' + f.a], { recursive: true });
        console.info('session-delete-projection', { ms: Math.round(performance.now() - started),
            workspaceOpens: acquire.mock.calls.length, manifestReads: manifest.mock.calls.length,
            taskPreviews: f.kernel.listSessionTaskPage.mock.calls.length });
        expect(acquire).not.toHaveBeenCalled();
        expect(f.kernel.listSessionTaskPage).not.toHaveBeenCalled();
        expect(await owner.context.fs.driver.readContent('/workspace/source-63.ts', { encoding: 'utf-8' })).toBe('keep');
        await expect(f.repository.getManifest(f.a)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('keeps physical layout protection when deleting a projected workspace file', async () => {
        const f = await setup();
        const owner = await f.files.acquireFiles(f.a); cleanup.push(() => owner.release());
        await owner.context.fs.driver.updateMetadata('/workspace/same.md', { vfsFixedLayout: true });
        await expect(f.browser.fs.driver.delete([`/${f.a}/files/workspace/same.md`])).rejects.toThrow();
        expect(await owner.context.fs.driver.readContent('/workspace/same.md', { encoding: 'utf-8' })).toBe('mapped');
        await f.browser.fs.driver.delete(['/' + f.a], { recursive: true });
        expect(await owner.context.fs.driver.readContent('/workspace/same.md', { encoding: 'utf-8' })).toBe('mapped');
    });
    it('can delete a Session even when its mounted files cannot be opened', async () => {
        const f = await setup();
        vi.spyOn(f.files, 'acquireFiles').mockRejectedValue(new Error('Mounted directory offline'));
        await f.browser.fs.driver.delete(['/' + f.a], { recursive: true });
        await expect(f.repository.getManifest(f.a)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('projects live mounted file permissions and marks the tasks container read-only', async () => {
        const f = await setup();
        const prefix = `/${f.a}/files/workspace`;
        expect((await f.browser.fs.driver.getChildren(`/${f.a}`)).find(node => node.name === 'tasks')?.metadata._readOnly).toBe(true);
        expect((await f.browser.fs.driver.getNode(prefix))?.metadata._readOnly).toBe(false);
        await f.files.configure(f.a, { mounts: [{ mountId: 'work', sourceId: 'home', at: '/workspace', root: '/project', access: 'ro' }], cwd: '/workspace' }, 1);
        expect((await f.browser.fs.driver.getNode(prefix))?.metadata._readOnly).toBe(true);
        expect((await f.browser.fs.driver.getChildren(prefix)).every(node => node.metadata._readOnly === true)).toBe(true);
        expect((await f.browser.fs.driver.getChildren(`/${f.a}/files`)).find(node => node.name === 'workspace')?.metadata._readOnly).toBe(true);
        await expect(f.browser.fs.driver.createFile({ parentPath: prefix, name: 'blocked.md' })).rejects.toMatchObject({ code: 'EROFS' });
    });
    it('previews one Task page and exposes the explicit paginated-list entry', async () => {
        const f = await setup();
        expect((await f.browser.fs.driver.getChildren(`/${f.a}/tasks`)).map(node => node.name)).toEqual(['t', '@more']);
        expect(resolveBrowserTarget(`/${f.a}/tasks/@more`)).toEqual({ kind: 'tasks', sessionId: f.a });
        expect(f.kernel.listSessionTasks).not.toHaveBeenCalled();
    });
    it('marks Task entries read-only so the UI does not offer delete', async () => {
        const f = await setup();
        const nodes = await f.browser.fs.driver.getChildren(`/${f.a}/tasks`);
        expect(nodes.every(node => node.metadata._readOnly === true)).toBe(true);
        expect((await f.browser.fs.driver.getNode('/' + f.a))?.metadata._readOnly).toBeUndefined();
    });
    it('exposes only tasks/files beneath stable Session directories', async () => {
        const f = await setup();
        expect((await f.browser.fs.driver.getChildren('/' + f.a)).map(n => n.name).sort()).toEqual(['files', 'tasks']);
        await f.repository.updateManifest(f.a, { title: '改名' });
        expect((await f.browser.fs.driver.getNode('/' + f.a))?.metadata.title).toBe('改名');
        expect(resolveBrowserTarget('/' + f.a)).toEqual({ kind: 'session', sessionId: f.a });
        await expect(f.browser.fs.driver.readContent(`/${f.a}/history`)).rejects.toThrow();
    });
    it('hides system roots and rejects direct projected access without hiding user directories with the same name', async () => {
        const f = await setup();
        const owner = await f.files.acquireFiles(f.a);
        try {
            await owner.context.fs.driver.createDirectory({ parentPath: '/workspace', name: 'etc' });
            expect((await owner.context.fs.driver.getChildren('/')).map(n => n.name)).toEqual(['workspace']);
            const visible = (await f.browser.fs.driver.getChildren(`/${f.a}/files`)).map(n => n.name);
            for (const name of ['etc', 'var', 'dev', 'run']) {
                expect(visible).not.toContain(name);
                await expect(owner.context.fs.driver.readContent(`/${name}/private`)).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(f.browser.fs.driver.getChildren(`/${f.a}/files/${name}`)).rejects.toMatchObject({ code: 'ENOENT' });
            }
            expect((await f.browser.fs.driver.getChildren(`/${f.a}/files/workspace`)).map(n => n.name)).toContain('etc');
        } finally { await owner.release(); }
    });
    it('reads and writes mapped files through the Session file context', async () => {
        const f = await setup(); const path = `/${f.a}/files/workspace/same.md`;
        expect(await f.browser.fs.driver.readContent(path, { encoding: 'utf-8' })).toBe('mapped');
        await f.browser.fs.driver.writeContent(path, 'browser write');
        expect(await f.browser.fs.driver.readContent(path, { encoding: 'utf-8' })).toBe('browser write');
        const owner = await f.files.acquireFiles(f.a); cleanup.push(() => owner.release());
        await owner.context.fs.driver.writeContent('/workspace/same.md', 'edited');
        expect(await f.browser.fs.driver.readContent(path, { encoding: 'utf-8' })).toBe('edited');
        await f.files.disable(f.a, 1);
        await expect(f.browser.fs.driver.readContent(path)).rejects.toMatchObject({ code: 'EACCES' });
        expect((await f.browser.fs.driver.getChildren('/' + f.a)).map(n => n.name).sort()).toEqual(['files', 'tasks']);
    });
    it('creates, groups, renames and deletes Sessions through the writable projection', async () => {
        const f = await setup();
        const folder = await f.browser.fs.driver.createDirectory({ name: 'Work', parentPath: '/' });
        expect(folder.path).toBe('/folder:Work');
        expect((await f.browser.fs.driver.getChildren('/')).some(node => node.metadata.title === 'Work')).toBe(true);

        const imported = await f.browser.fs.driver.createFile({
            name: 'Imported Session',
            parentPath: folder.path,
            content: new TextEncoder().encode(JSON.stringify({
                version: 1,
                manifest: { title: 'Imported title', folder: '/Work' },
                history: { 'round.json': '{"content":"imported"}' },
            })),
        });
        expect(imported.metadata.title).toBe('Imported title');
        expect((await f.browser.fs.driver.getChildren(folder.path)).map(node => node.metadata.title)).toContain('Imported title');
        const id = imported.path.slice(imported.path.lastIndexOf('/') + 1);
        expect(await f.repository.readDocument(id, 'round.json')).toBe('{"content":"imported"}');

        await f.browser.fs.driver.rename(imported.path, 'Renamed Session');
        expect((await f.repository.getManifest(id)).title).toBe('Renamed Session');

        await f.browser.fs.driver.delete([imported.path]);
        await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
        await f.browser.fs.driver.delete([folder.path], { recursive: true });
        expect((await f.browser.fs.driver.getChildren('/')).some(node => node.metadata.title === 'Work')).toBe(false);
    });

    it('keeps the Session when the Kernel refuses to close it', async () => {
        const f = await setup({ closeSession: vi.fn(async () => { throw new Error('process still running'); }) });
        await expect(f.browser.fs.driver.delete([`/${f.a}`])).rejects.toMatchObject({ code: 'EBUSY' });
        await expect(f.lifecycle.deleteSession(f.b)).rejects.toThrow(/process still running/);
        expect((await f.repository.getManifest(f.a)).id).toBe(f.a);
        expect((await f.repository.getManifest(f.b)).id).toBe(f.b);
        expect(f.kernel.removeSession).not.toHaveBeenCalled();
    });

    it('keeps the Session when it never reaches closed', async () => {
        const f = await setup({ sessionStat: vi.fn(async () => ({ phase: 'closing', blockedBy: 'resource-claims' })) });
        await expect(f.browser.fs.driver.delete([`/${f.a}`])).rejects.toMatchObject({ code: 'EBUSY' });
        expect((await f.repository.getManifest(f.a)).id).toBe(f.a);
    });

    it('closes every Kernel Session inside a folder before deleting the folder', async () => {
        const f = await setup();
        const folder = await f.browser.fs.driver.createDirectory({ name: 'Work', parentPath: '/' });
        const id = await f.repository.createSession('Inside', '/Work');
        await f.browser.fs.driver.delete([folder.path], { recursive: true });
        expect(f.kernel.closeSession).toHaveBeenCalledWith(id, true);
        expect(f.kernel.removeSession).toHaveBeenCalledWith(id);
        await expect(f.repository.getManifest(id)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('imports a Session bundle from a regular file write', async () => {
        const f = await setup();
        const bundle = JSON.stringify({
            version: 1,
            manifest: { title: 'Bundle import' },
            history: { 'one.json': '{"round":1}' },
        });
        const created = await f.browser.fs.driver.createFile({ name: 'bundle.json', parentPath: '/', content: bundle });
        const id = created.path.slice(created.path.lastIndexOf('/') + 1);
        expect((await f.repository.getManifest(id)).title).toBe('Bundle import');
        expect(await f.repository.readDocument(id, 'one.json')).toBe('{"round":1}');
    });

    it('projects one current Task summary without loading history', async () => {
        const f = await setup();
        expect(await f.browser.fs.driver.getChildren(`/${f.b}/tasks`)).toEqual([]);
        expect((await f.browser.fs.driver.getChildren(`/${f.a}/tasks`))[0].path).toBe(`/${f.a}/tasks/t`);
        const history = await f.browser.fs.driver.readContent(`/${f.a}/tasks/t`, { encoding: 'utf-8' });
        expect(JSON.parse(history)).toMatchObject({ id: 't', status: 'succeeded', input: 'hello', output: 'done' });
        expect(f.kernel.taskHistory).not.toHaveBeenCalled();
        expect(history).not.toContain('private-token');
        expect(JSON.parse(history)).toMatchObject({ control: { requested: 'run', acknowledged: true }, activeOperations: 0 });
        await expect(f.browser.fs.driver.readContent(`/${f.b}/tasks/t`)).rejects.toThrow();
    });

    it('exposes whether an accepted cancel is still waiting for the external stop', async () => {
        const f = await setup();
        const task = await f.kernel.task(f.a, 't') as { status: string; effects: Record<string, unknown> };
        task.status = 'cancelled';
        task.effects = { e: { id: 'e', status: 'cancelled', cleanupPending: true } };
        const pending = JSON.parse(await f.browser.fs.driver.readContent(`/${f.a}/tasks/t`, { encoding: 'utf-8' }));
        expect(pending).toMatchObject({ status: 'cancelled', control: { requested: 'cancel', acknowledged: false }, activeOperations: 1 });

        task.effects = { e: { id: 'e', status: 'cancelled', cleanupPending: false } };
        const stopped = JSON.parse(await f.browser.fs.driver.readContent(`/${f.a}/tasks/t`, { encoding: 'utf-8' }));
        expect(stopped).toMatchObject({ control: { requested: 'cancel', acknowledged: true }, activeOperations: 0 });
    });
});
