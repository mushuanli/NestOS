import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, createFileSystemView, type IFileSystem } from '@itookit/vfs-core';
import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { SessionFilesService } from '../src/vfs/session-files';
import { createSessionAttachmentMounts } from '../src/vfs/session-attachments';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const { manager } = await createVFS({ rootBackend: new IndexedDBBackend({ dbName: `session-files-${crypto.randomUUID()}` }) });
    cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    const store = await manager.openFileSystem('/');
    const home = await manager.openFileSystem('/home/admin');
    await home.driver.createFile({ name: 'same.md', parentPath: '/a', content: 'A', recursive: true });
    await home.driver.createFile({ name: 'same.md', parentPath: '/b', content: 'B', recursive: true });
    const make = async (resolveSource?: (sourceId: string) => Promise<IFileSystem | undefined>) => {
        const service = new SessionFilesService(store, async id => [{ mountId: 'attachments', at: '/attachments', fs: await manager.openFileSystem(`/var/lib/sessions/${id}/attachments`), access: 'rw' }], resolveSource);
        await service.initialize();
        service.registerSource('home', home);
        cleanup.push(() => service.dispose());
        return service;
    };
    return { root, home, store, service: await make(), make };
}
const mount = (root: string, access: 'ro' | 'rw' = 'rw') => [{ mountId: 'work', at: '/workspace', sourceId: 'home', root, access }];

describe('Session file contexts', () => {
    it('reads cwd and grants once per acquisition and observes the next revision', async () => {
        const { service } = await setup();
        await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 0);
        const inspect = vi.spyOn(service, 'inspect');
        const first = await service.acquireFiles('a'); cleanup.push(() => first.release());
        expect(inspect).toHaveBeenCalledTimes(1);
        expect(first.context.cwd).toBe('/workspace');
        await service.configure('a', { mounts: mount('/b'), cwd: '/' }, 1);
        inspect.mockClear();
        const second = await service.acquireFiles('a'); cleanup.push(() => second.release());
        expect(inspect).toHaveBeenCalledTimes(1);
        expect(second.context.cwd).toBe('/');
        expect(await second.context.fs.driver.readContent('/workspace/same.md', { encoding: 'utf-8' })).toBe('B');
        await expect(first.context.fs.driver.readContent('/workspace/same.md')).rejects.toMatchObject({ code: 'EACCES' });
    });
    it('isolates concurrent workspace views without replacing the Session grant or owning the source', async () => {
        const { service, home } = await setup();
        const configured = await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 0);
        const copy = createFileSystemView({ viewId: 'copy', mounts: [{ mountId: 'copy', at: '/', fs: home, root: '/b', access: 'rw' }] });
        cleanup.push(() => copy.dispose());
        const first = await service.acquireWorkspaceFiles('a', 'work', copy);
        const second = await service.acquireWorkspaceFiles('a', 'work', copy);
        const normal = await service.acquire('a');
        cleanup.push(() => normal.release());
        expect(first.context.cwd).toBe('/workspace');
        await first.context.fs.driver.writeContent('/workspace/same.md', 'isolated');
        expect(await normal.vfs.readFile('same.md')).toBe('A');
        expect(await second.context.fs.driver.readContent('/workspace/same.md', { encoding: 'utf-8' })).toBe('isolated');
        expect(await service.inspect('a')).toEqual(configured);
        expect((await first.context.fs.driver.getChildren('/')).map(node => node.name).sort()).toEqual(['attachments', 'workspace']);
        await expect(first.context.fs.driver.readContent('/var/lib/sessions/a/session.seq')).rejects.toMatchObject({ code: 'ENOENT' });
        await Promise.all([first.release(), first.release()]);
        await expect(first.context.fs.driver.readContent('/workspace/same.md', { encoding: 'utf-8' })).rejects.toMatchObject({ code: 'EACCES' });
        expect(await second.context.fs.driver.readContent('/workspace/same.md', { encoding: 'utf-8' })).toBe('isolated');
        await second.release();
        expect(await copy.driver.readContent('/same.md', { encoding: 'utf-8' })).toBe('isolated');
    });

    it.each(['configure', 'disable', 'dispose'] as const)('revokes isolated file handles on %s', async action => {
        const { service, home } = await setup();
        await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 0);
        const isolated = await service.acquireWorkspaceFiles('a', 'work', home);
        const file = isolated.context.fs.openFile('/workspace/b/same.md');
        expect(new TextDecoder().decode(await file.read())).toBe('B');
        if (action === 'configure') await service.configure('a', { mounts: mount('/a', 'ro'), cwd: '/workspace' }, 1);
        else if (action === 'disable') await service.disable('a', 1);
        else await service.dispose();
        await expect(file.read()).rejects.toMatchObject({ code: 'EACCES' });
        await isolated.release();
        expect(await home.driver.readContent('/a/same.md', { encoding: 'utf-8' })).toBe('A');
    });

    it('requires an active writable grant and rejects read-only replacement sources', async () => {
        const { service, home } = await setup();
        await expect(service.acquireWorkspaceFiles('a', 'work', home)).rejects.toMatchObject({ code: 'EACCES' });
        await service.configure('a', { mounts: mount('/a', 'ro'), cwd: '/workspace' }, 0);
        await expect(service.acquireWorkspaceFiles('a', 'work', home)).rejects.toMatchObject({ code: 'EROFS' });
        await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 1);
        await expect(service.acquireWorkspaceFiles('a', 'other', home)).rejects.toMatchObject({ code: 'EACCES' });
        const readonly = createFileSystemView({ viewId: 'readonly-copy', mounts: [{ mountId: 'copy', at: '/', fs: home, access: 'ro' }] });
        cleanup.push(() => readonly.dispose());
        await expect(service.acquireWorkspaceFiles('a', 'work', readonly)).rejects.toMatchObject({ code: 'EROFS' });
        await service.disable('a', 2);
        await expect(service.acquireWorkspaceFiles('a', 'work', home)).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('rejects invalid or exhausted revisions without publishing a draining record', async () => {
        const { service, store } = await setup();
        const current = { revision: Number.MAX_SAFE_INTEGER, state: 'active', mounts: mount('/a'), cwd: '/workspace' };
        await store.driver.createFile({ name: 'session.seq', parentPath: '/var/lib/sessions/a', type: 'seqfile', recursive: true });
        await store.meta.seq!.setEntry('/var/lib/sessions/a/session.seq', 'files', JSON.stringify(current));
        for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
            await expect(service.configure('a', { mounts: mount('/b'), cwd: '/workspace' }, revision)).rejects.toMatchObject({ code: 'EINVAL' });
            await expect(service.disable('a', revision)).rejects.toMatchObject({ code: 'EINVAL' });
            expect(await service.inspect('a')).toEqual(current);
        }
    });

    it('routes exact paths independently, persists revisions, and has no basename fallback', async () => {
        const { service, make } = await setup();
        await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 0);
        await service.configure('b', { mounts: mount('/b', 'ro'), cwd: '/workspace' }, 0);
        const a = await service.acquire('a'), b = await service.acquire('b');
        expect(await a.vfs.readFile('same.md')).toBe('A');
        expect(await b.vfs.readFile('same.md')).toBe('B');
        await expect(a.vfs.readFile('/missing/same.md')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(a.vfs.readFile('../b/same.md')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(b.vfs.writeFile('same.md', 'bad')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(service.configure('a', { mounts: mount('/b'), cwd: '/workspace' }, 0)).rejects.toMatchObject({ code: 'ECONFLICT' });
        await service.dispose();
        const reopened = await make();
        expect((await reopened.inspect('a'))?.revision).toBe(1);
        expect(await (await reopened.acquire('a')).vfs.readFile('same.md')).toBe('A');
    });

    it('revokes pinned file and tool handles, and closes released scopes', async () => {
        const { service, home } = await setup();
        await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 0);
        const tools = await service.acquire('a');
        const owner = await service.acquireFiles('a');
        const file = owner.context.fs.openFile('/workspace/same.md');
        await service.configure('a', { mounts: mount('/b'), cwd: '/workspace' }, 1);
        await expect(file.read()).rejects.toMatchObject({ code: 'EACCES' });
        await expect(tools.vfs.readFile('same.md')).rejects.toMatchObject({ code: 'EACCES' });
        expect(await (await service.acquire('a')).vfs.readFile('same.md')).toBe('B');
        await tools.release();
        await expect(tools.vfs.readFile('same.md')).rejects.toMatchObject({ code: 'EACCES' });
        await owner.release();
        const active = await service.acquire('a');
        await service.disable('a', 2);
        await expect(active.vfs.readFile('same.md')).rejects.toMatchObject({ code: 'EACCES' });
        expect(await home.driver.readContent('/b/same.md', { encoding: 'utf-8' })).toBe('B');
        await service.dispose();
        await expect(service.acquire('new')).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('exposes only attachments without system directories, kernel records, or another Session', async () => {
        const { service, root } = await setup();
        for (const [parentPath, name, content] of [
            ['/etc/public', 'app.json', 'public'], ['/etc/llm', 'secret.json', 'credential'],
            ['/var/lib/kernel', 'ipc.seq', 'private'],
        ]) await root.driver.createFile({ parentPath, name, content, recursive: true });
        for (const id of ['a', 'b']) {
            await root.driver.createFile({ parentPath: `/var/lib/sessions/${id}`, name: 'history.seq', type: 'seqfile', recursive: true });
            await root.meta.seq!.setEntry(`/var/lib/sessions/${id}/history.seq`, 'private', 'history');
        }
        const owner = await service.acquireFiles('a', '/');
        const fs = owner.context.fs;
        expect((await fs.driver.getChildren('/')).map(n => n.name).sort()).toEqual(['attachments']);
        await expect(fs.driver.readContent('/etc/public/app.json')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.driver.readContent('/var/lib/sessions/a/history.seq')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.driver.readContent('/etc/llm/secret.json')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.driver.readContent('/var/lib/sessions/b/history.seq')).rejects.toMatchObject({ code: 'ENOENT' });
        for (const id of ['a', 'b']) {
            await expect(fs.meta.seq!.getEntry(`/var/lib/sessions/${id}/history.seq`, 'private')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect((await fs.driver.search({ text: 'credential' })).nodes).toEqual([]);
        await expect(service.configure('a', { mounts: [{ ...mount('/a')[0], at: '//etc/public' }], cwd: '/workspace' }, 0)).rejects.toMatchObject({ code: 'EACCES' });
        await owner.release();
    });

    it('keeps interrupted reconfiguration disabled until explicitly recovered', async () => {
        const { service, store } = await setup();
        await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 0);
        await store.meta.seq!.setEntry('/var/lib/sessions/a/session.seq', 'files', JSON.stringify({ revision: 1, state: 'draining', mounts: mount('/a'), cwd: '/workspace' }));
        await expect(service.acquire('a')).rejects.toMatchObject({ code: 'EBUSY' });
        await service.configure('a', { mounts: mount('/b'), cwd: '/workspace' }, 1);
        expect(await (await service.acquire('a')).vfs.readFile('same.md')).toBe('B');
    });
});

it('maps granted Session attachments without history and revokes derived maps', async () => {
    const { SessionRepository } = await import('@itookit/llm-session');
    const { manager } = await createVFS({ rootBackend: new IndexedDBBackend({ dbName: crypto.randomUUID() }) });
    cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init(); cleanup.push(() => repository.dispose());
    const a = await repository.createSession('A'), b = await repository.createSession('B');
    const system = createSessionAttachmentMounts(repository); cleanup.push(() => system.dispose());
    const service = new SessionFilesService(root, id => system.forSession(id)); await service.initialize(); cleanup.push(() => service.dispose());
    await repository.writeDocument(a, 'round-a.json', '{"message":"A"}');
    await repository.writeAttachment(a, 'one.bin', new Uint8Array([0, 255]).buffer);
    const source = await service.acquireFiles(a, '/'); cleanup.push(() => source.release());
    const editorAssets = createFileSystemView({ viewId: 'editor-assets', mounts: [{ mountId: 'assets', at: '/', root: '/attachments', fs: source.context.fs, access: 'rw' }] });
    cleanup.push(() => editorAssets.dispose());
    service.registerSource('session-a', source.context.fs);
    await service.configure(b, { mounts: [{ mountId: 'other', at: '/other', sourceId: 'session-a', root: '/', access: 'ro' }], cwd: '/' }, 0);
    const target = await service.acquireFiles(b, '/'); cleanup.push(() => target.release());
    await expect(target.context.fs.driver.readContent('/other/history/round-a.json')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(new Uint8Array(await target.context.fs.driver.readContent('/other/attachments/one.bin', { encoding: 'binary' }))).toEqual(new Uint8Array([0, 255]));
    await expect(target.context.fs.driver.writeContent('/other/attachments/one.bin', 'no')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(target.context.fs.driver.readContent(`/var/lib/sessions/${a}/history.seq`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.configure(b, { mounts: [{ mountId: 'override', at: '/history', sourceId: 'session-a', access: 'rw' }], cwd: '/workspace' }, 1)).rejects.toMatchObject({ code: 'EACCES' });
    await repository.writeDocument(a, 'round-a.json', '{"message":"latest"}');
    await expect(target.context.fs.driver.readContent('/other/history/round-a.json')).rejects.toMatchObject({ code: 'ENOENT' });
    await service.disable(a, 0);
    await expect(editorAssets.driver.readContent('/one.bin')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(editorAssets.driver.createFile({ name: 'after.bin', parentPath: '/', content: 'no' })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(target.context.fs.driver.readContent('/other/attachments/one.bin')).rejects.toMatchObject({ code: 'EACCES' });
});

it.each(['configure', 'disable', 'dispose'] as const)('revokes the ordinary view before workspace draining during %s', async action => {
    const { service, home } = await setup();
    const record = await service.configure('a', { mounts: mount('/a'), cwd: '/workspace' }, 0);
    const ordinary = await service.acquireFiles('a'); cleanup.push(() => ordinary.release());
    const copy = createFileSystemView({ viewId: 'held-copy', mounts: [{ mountId: 'copy', at: '/', fs: home, root: '/b', access: 'rw' }] });
    cleanup.push(() => copy.dispose());
    const workspace = await service.acquireWorkspaceFiles('a', 'work', copy); cleanup.push(() => workspace.release());
    let release!: () => void, began!: () => void, revoking!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const revocation = new Promise<void>(resolve => { revoking = resolve; });
    const read = home.driver.readContent.bind(home.driver);
    const reading = vi.spyOn(home.driver, 'readContent').mockImplementation(async (...args: any[]) => { began(); await held; return read(...args as [string]); });
    const dispose = workspace.context.fs.dispose.bind(workspace.context.fs);
    const closing = vi.spyOn(workspace.context.fs, 'dispose').mockImplementation(() => { revoking(); return dispose(); });
    const pendingRead = expect(workspace.context.fs.driver.readContent('/workspace/same.md')).rejects.toMatchObject({ code: 'ECANCELLED' });
    await started;
    const changing = action === 'configure' ? service.configure('a', { mounts: mount('/a', 'ro'), cwd: '/workspace' }, record.revision)
        : action === 'disable' ? service.disable('a', record.revision) : service.dispose();
    try {
        await revocation;
        await expect(ordinary.context.fs.driver.writeContent('/workspace/same.md', 'late write')).rejects.toMatchObject({ code: 'EACCES' });
    } finally { release(); await pendingRead; await changing; reading.mockRestore(); closing.mockRestore(); }
    expect(await home.driver.readContent('/a/same.md', { encoding: 'utf-8' })).toBe('A');
});

describe('lazily resolved mount sources', () => {
    const saved = (root: string) => [{ mountId: 'work', at: '/workspace', sourceId: 'saved', root, access: 'rw' as const }];

    it('opens a configured but unregistered source through the resolver', async () => {
        const { home, make } = await setup();
        const resolveSource = vi.fn(async (id: string) => id === 'saved' ? home : undefined);
        const service = await make(resolveSource);
        await service.configure('lazy', { mounts: saved('/a'), cwd: '/workspace' }, 0);
        expect(resolveSource).toHaveBeenCalledWith('saved');
        const acquired = await service.acquireFiles('lazy'); cleanup.push(() => acquired.release());
        expect(await acquired.context.fs.driver.readContent('/workspace/same.md', { encoding: 'utf-8' })).toBe('A');
        const resolved = resolveSource.mock.calls.length;
        const again = await service.acquireFiles('lazy'); cleanup.push(() => again.release());
        expect(resolveSource.mock.calls.length).toBe(resolved);
    });

    it('fails closed when the resolver cannot open the source', async () => {
        const { make } = await setup();
        const service = await make(async () => undefined);
        await expect(service.configure('missing', { mounts: saved('/a'), cwd: '/workspace' }, 0))
            .rejects.toMatchObject({ code: 'EACCES' });
        expect(await service.inspect('missing')).toBeNull();
    });
});
