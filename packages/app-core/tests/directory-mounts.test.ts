import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, createFileSystemView, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { SessionFilesService } from '../src/vfs/session-files';
import { createSessionAttachmentMounts } from '../src/vfs/session-attachments';
import { DirectoryMountService } from '../src/vfs/directory-mounts';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(readOnlySource = false) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    const repo = new SessionRepository(root); await repo.init(); cleanup.push(() => repo.dispose());
    const a = await repo.createSession('A'), b = await repo.createSession('B');
    const attachments = createSessionAttachmentMounts(repo); cleanup.push(() => attachments.dispose());
    const files = new SessionFilesService(root, id => attachments.forSession(id)); await files.initialize(); cleanup.push(() => files.dispose());
    const home = await manager.openFileSystem('/home/admin');
    const source = readOnlySource ? createFileSystemView({ viewId: 'readonly-source', mounts: [{ mountId: 'home', at: '/', fs: home, access: 'ro' }] }) : home;
    if (readOnlySource) cleanup.push(() => source.dispose());
    files.registerSource('admin-home', source);
    await root.driver.createFile({ parentPath: '/home/admin/projects/demo', name: 'a.md', content: 'allowed', recursive: true });
    await root.driver.createFile({ parentPath: '/home/admin/notes', name: 'secret.md', content: 'unmounted', recursive: true });
    const after = vi.fn(async () => {}), before = vi.fn(async () => {});
    const mounts = new DirectoryMountService(root, files, undefined, before, after); await mounts.init();
    const acquire = async (id: string) => { const owner = await files.acquireFiles(id); cleanup.push(() => owner.release()); return owner.context; };
    return { root, files, mounts, a, b, acquire, after, before };
}
it('only grants attachments until the default directory is explicitly mounted', async () => {
    const f = await setup(); const empty = await f.acquire(f.a);
    expect((await empty.fs.driver.getChildren('/')).map(n => n.name)).toEqual(['attachments']);
    expect(empty.cwd).toBe('/');
    await f.mounts.setHome('~/projects/demo'); expect(await f.files.inspect(f.a)).toBeNull();
    const reopened = new DirectoryMountService(f.root, f.files); await reopened.init();
    expect(reopened.getHome()).toBe('/home/admin/projects/demo');
    await f.mounts.mountHome(f.a);
    const active = await f.acquire(f.a); expect(active.cwd).toBe('/workspace');
    expect(await active.fs.driver.readContent('/workspace/a.md', { encoding: 'utf-8' })).toBe('allowed');
    await expect(active.fs.driver.readContent('/home/admin/notes/secret.md')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await (await f.acquire(f.b)).fs.driver.getChildren('/')).map(n => n.name)).toEqual(['attachments']);
    await expect(empty.fs.driver.getChildren('/')).rejects.toMatchObject({ code: 'EACCES' });
});
it('defaults to read-write, attenuates explicit read-only, and removes grants without deleting data', async () => {
    const f = await setup(); await f.mounts.addDirectory(f.a, '~/projects/demo');
    expect((await f.files.inspect(f.a))?.mounts[0]).toMatchObject({ at: '/demo', access: 'rw' });
    const first = await f.acquire(f.a); await first.fs.driver.writeContent('/demo/a.md', 'changed');
    await f.mounts.addDirectory(f.a, '~/projects/demo', 'ro');
    const current = await f.acquire(f.a);
    await expect(first.fs.driver.readContent('/demo/a.md')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(current.fs.driver.writeContent('/demo/a.md', 'no')).rejects.toMatchObject({ code: 'EROFS' });
    // A read-only grant refuses every mutating verb, not just content writes.
    await expect(current.fs.driver.rename('/demo/a.md', 'renamed.md')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(current.fs.driver.move(['/demo/a.md'], '/')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(current.fs.driver.delete(['/demo/a.md'])).rejects.toMatchObject({ code: 'EROFS' });
    await expect(current.fs.driver.updateMetadata('/demo/a.md', { icon: 'locked' })).rejects.toMatchObject({ code: 'EROFS' });
    await expect(current.fs.meta.tags.setTags('/demo/a.md', ['blocked'])).rejects.toMatchObject({ code: 'EROFS' });
    await expect(current.fs.driver.createDirectory({ parentPath: '/demo', name: 'created' })).rejects.toMatchObject({ code: 'EROFS' });
    // The grant is the whole visible tree: absolute sibling paths and traversal stay out.
    expect((await current.fs.driver.getChildren('/')).map(node => node.name)).toEqual(['attachments', 'demo']);
    await expect(current.fs.driver.readContent('/home/admin/notes/secret.md')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(current.fs.driver.readContent('/demo/../notes/secret.md')).rejects.toBeDefined();
    const mount = (await f.files.inspect(f.a))!.mounts[0]; await f.mounts.remove(f.a, mount.mountId);
    expect(await f.root.driver.readContent('/home/admin/projects/demo/a.md', { encoding: 'utf-8' })).toBe('changed');
    expect((await (await f.acquire(f.a)).fs.driver.getChildren('/')).map(n => n.name)).toEqual(['attachments']);
});
it('keeps the same mount point name bound to each Session source independently', async () => {
    const f = await setup();
    await f.root.driver.createFile({ parentPath: '/home/admin/projects/other', name: 'b.md', content: 'other', recursive: true });
    await f.mounts.addDirectory(f.a, '~/projects/demo', 'rw', '/demo');
    await f.mounts.addDirectory(f.b, '~/projects/other', 'rw', '/demo');
    const a = await f.acquire(f.a), b = await f.acquire(f.b);
    // Same virtual path, different registered source: no cross-Session leakage.
    expect(await a.fs.driver.readContent('/demo/a.md', { encoding: 'utf-8' })).toBe('allowed');
    await expect(a.fs.driver.readContent('/demo/b.md')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await b.fs.driver.readContent('/demo/b.md', { encoding: 'utf-8' })).toBe('other');
    await expect(b.fs.driver.readContent('/demo/a.md')).rejects.toMatchObject({ code: 'ENOENT' });
    // Both Sessions record the same virtual path, each bound to its own source.
    expect((await f.files.inspect(f.a))?.mounts[0]).toMatchObject({ at: '/demo' });
    expect((await f.files.inspect(f.b))?.mounts[0]).toMatchObject({ at: '/demo' });
    // The source registered for one Session is not reachable from the other.
    expect((await b.fs.driver.getChildren('/')).map(node => node.name)).toEqual(['attachments', 'demo']);
    await expect(b.fs.driver.readContent('/home/admin/projects/other/b.md')).rejects.toBeDefined();
});

it('rejects reserved mount points, absent directories, and changes while the host guard refuses', async () => {
    const f = await setup();
    await expect(f.mounts.addDirectory(f.a, '~/projects/demo', 'rw', '/attachments')).rejects.toThrow('Reserved');
    await expect(f.mounts.addDirectory(f.a, '~/missing')).rejects.toThrow('不存在');
    f.before.mockRejectedValueOnce(new Error('Task active'));
    await expect(f.mounts.addDirectory(f.a, '~/projects/demo')).rejects.toThrow('Task active');
    expect(await f.files.inspect(f.a)).toBeNull(); expect(f.after).not.toHaveBeenCalled();
});
it('retains unavailable mounts, keeps attachments usable, and reconnects without changing the granted path', async () => {
    const f = await setup();
    await f.mounts.addDirectory(f.a, '~/projects/demo');
    const restarted = new SessionFilesService(f.root, async id => {
        const fs = (await f.acquire(id)).fs;
        return [{ mountId: 'attachments', at: '/attachments', root: '/attachments', fs, access: 'rw' }];
    });
    await restarted.initialize(); cleanup.push(() => restarted.dispose());
    const old = await restarted.acquireFiles(f.a); cleanup.push(() => old.release());
    expect((await old.context.fs.driver.getChildren('/')).map(n => n.name).sort()).toEqual(['attachments', 'demo']);
    await old.context.fs.driver.createFile({ parentPath: '/attachments', name: 'new.txt', content: 'own' });
    await expect(old.context.fs.driver.readContent('/demo/a.md')).rejects.toMatchObject({ code: 'EACCES' });
    // Registering the same identity restores the original config, not a different default directory.
    const { createFileSystemView } = await import('@itookit/vfs-core');
    const homeContext = createFileSystemView({ viewId: 'reconnected-home', mounts: [{ mountId: 'home', at: '/', root: '/home/admin', fs: f.root, access: 'rw' }] });
    cleanup.push(() => homeContext.dispose());
    restarted.registerSource('admin-home', homeContext);
    const current = await restarted.acquireFiles(f.a); cleanup.push(() => current.release());
    expect(await current.context.fs.driver.readContent('/demo/a.md', { encoding: 'utf-8' })).toBe('allowed');
    await expect(old.context.fs.driver.getChildren('/')).rejects.toMatchObject({ code: 'EACCES' });
});

it.each(['append', 'create-file', 'seq-write', 'seq-transaction'] as const)('keeps source data unchanged when a read-only grant rejects %s', async operation => {
    const f = await setup();
    const source = '/home/admin/projects/demo';
    await f.root.driver.createFile({ parentPath: source, name: 'state.seq', type: 'seqfile' });
    await f.root.meta.seq!.setEntry(`${source}/state.seq`, 'state', 'original');
    await f.mounts.addDirectory(f.a, '~/projects/demo', 'ro', '/demo');
    const view = (await f.acquire(f.a)).fs;
    const transaction = vi.fn(async (tx: import('@itookit/vfs-core').ISeqFileTransaction) => tx.setEntry('/demo/state.seq', 'state', 'changed'));
    const attempt = () => {
        if (operation === 'append') return view.driver.appendContent('/demo/a.md', 'changed');
        if (operation === 'create-file') return view.driver.createFile({ parentPath: '/demo', name: 'new.md', content: 'changed' });
        if (operation === 'seq-write') return view.meta.seq!.setEntry('/demo/state.seq', 'state', 'changed');
        return view.meta.seq!.transaction!(transaction);
    };
    await expect(attempt()).rejects.toMatchObject({ code: operation === 'seq-transaction' ? 'ECAPABILITY' : 'EROFS' });
    if (operation === 'seq-transaction') expect(transaction).not.toHaveBeenCalled();
    expect(await f.root.driver.readContent(`${source}/a.md`, { encoding: 'utf-8' })).toBe('allowed');
    expect(await f.root.driver.exists(`${source}/new.md`)).toBe(false);
    expect(await f.root.meta.seq!.getEntry(`${source}/state.seq`, 'state')).toBe('original');
});

it('cannot elevate a read-only registered source through a read-write Session mount', async () => {
    const f = await setup(true);
    await expect(f.mounts.addDirectory(f.a, '~/projects/demo', 'rw', '/demo')).rejects.toMatchObject({ code: 'EROFS' });
    expect(await f.files.inspect(f.a)).toBeNull();
    await f.mounts.addDirectory(f.a, '~/projects/demo', 'ro', '/demo');
    const view = (await f.acquire(f.a)).fs;
    expect(await view.driver.readContent('/demo/a.md', { encoding: 'utf-8' })).toBe('allowed');
    await expect(view.driver.writeContent('/demo/a.md', 'elevated')).rejects.toMatchObject({ code: 'EROFS' });
    expect(await f.root.driver.readContent('/home/admin/projects/demo/a.md', { encoding: 'utf-8' })).toBe('allowed');
});

it('replaces the workspace without moving data, preserves reference mounts and revokes old views', async () => {
    const f = await setup();
    await f.root.driver.createFile({ parentPath: '/home/admin/projects/second', name: 'a.md', content: 'second', recursive: true });
    await f.mounts.setWorkspace(f.a, '~/projects/demo');
    await f.mounts.addDirectory(f.a, '~/notes', 'ro', '/reference');
    const old = await f.acquire(f.a);
    await f.mounts.setWorkspace(f.a, '~/projects/second');
    const current = await f.files.acquire(f.a); cleanup.push(current.release);
    expect(current.cwd).toBe('/workspace');
    expect(await current.vfs.readFile('a.md')).toBe('second');
    expect(await current.vfs.readFile('/reference/secret.md')).toBe('unmounted');
    await expect(current.vfs.writeFile('/reference/secret.md', 'changed')).rejects.toMatchObject({ code: 'EROFS' });
    expect(await current.vfs.readFile('../reference/secret.md')).toBe('unmounted');
    expect(await current.vfs.readFile('/workspace/../reference/secret.md')).toBe('unmounted');
    for (const path of ['../notes/secret.md', 'host:/home/admin/notes/secret.md', '/home/admin/notes/secret.md']) {
        await expect(current.vfs.readFile(path)).rejects.toBeDefined();
    }
    await expect(old.fs.driver.readContent('/workspace/a.md')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await f.root.driver.readContent('/home/admin/projects/demo/a.md', { encoding: 'utf-8' })).toBe('allowed');
    expect((await f.files.inspect(f.a))!.mounts.map(m => m.at).sort()).toEqual(['/reference', '/workspace']);
});

it('moves the working directory with a renamed mount and leaves grants intact when changes are refused', async () => {
    const f = await setup();
    await f.mounts.setWorkspace(f.a, '~/projects/demo');
    await f.mounts.addDirectory(f.a, '~/projects/demo', 'rw', '/project');
    expect((await f.files.inspect(f.a))?.cwd).toBe('/project');
    f.before.mockRejectedValueOnce(new Error('Task active'));
    await expect(f.mounts.setWorkspace(f.a, '~/notes')).rejects.toThrow('Task active');
    expect((await f.files.inspect(f.a))?.cwd).toBe('/project');
});

it('distinguishes fixed host workspaces from virtual directories with the same visible path', async () => {
    const f = await setup();
    const fixed = new DirectoryMountService(f.root, f.files, {
        openDirectory: async () => f.root, selectDirectory: async () => null, dispose: async () => {},
    }, undefined, undefined, async () => 'host:/home/admin/projects/demo');
    await fixed.init(); cleanup.push(() => fixed.dispose());
    await fixed.setWorkspace(f.a, 'host:/home/admin/projects/demo');
    const before = await f.files.inspect(f.a);
    await expect(fixed.setWorkspace(f.a, '/home/admin/projects/demo')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await f.files.inspect(f.a)).toEqual(before);
});

it('opens saved host directories on first use instead of at startup', async () => {
    const f = await setup();
    const preferences = '/var/lib/kernel/local-sources/session-directories.json';
    await f.root.driver.createFile({ parentPath: '/var/lib/kernel/local-sources', name: 'session-directories.json',
        content: JSON.stringify({ version: 1, external: { 'directory-saved': '/srv/saved', 'directory-gone': '/srv/gone' } }), recursive: true });
    const openDirectory = vi.fn(async (path: string) => {
        if (path === '/srv/gone') throw new Error('source offline');
        return f.root;
    });
    const mounts = new DirectoryMountService(f.root, f.files,
        { openDirectory, selectDirectory: async () => null, dispose: async () => {} });
    cleanup.push(() => mounts.dispose());
    await mounts.init();
    // Startup must not open a sidecar for a bookmark nothing mounts yet.
    expect(openDirectory).not.toHaveBeenCalled();
    expect(f.files.source('directory-saved')).toBeUndefined();
    await expect(mounts.resolveSource('directory-saved')).resolves.toBe(f.root);
    expect(openDirectory).toHaveBeenCalledWith('/srv/saved');
    await expect(mounts.resolveSource('directory-saved')).resolves.toBe(f.root);
    expect(openDirectory).toHaveBeenCalledTimes(1);
    // An unreachable source stays unavailable instead of failing the Session view.
    await expect(mounts.resolveSource('directory-gone')).resolves.toBeUndefined();
    await expect(mounts.resolveSource('directory-unknown')).resolves.toBeUndefined();
    expect(await f.root.driver.exists(preferences)).toBe(true);
});

it('distinguishes missing project directories from paths occupied by a file', async () => {
    const f = await setup();
    await expect(f.mounts.openDirectory('/home/admin/not-found')).rejects.toMatchObject({ code: 'ENOENT', path: '/home/admin/not-found' });
    await expect(f.mounts.openDirectory('/home/admin/notes/secret.md')).rejects.toMatchObject({ code: 'ENOTDIR', path: '/home/admin/notes/secret.md' });
    expect(await f.root.driver.exists('/home/admin/not-found')).toBe(false);
});


it('reports unmounted host sources as unavailable while preserving internal directory inspection', async () => {
    const { mounts: dirs } = await setup();
    expect(dirs.canSelectHost).toBe(false);
    await expect(dirs.inspectDirectory('host:/Users/li/share/x1')).rejects.toMatchObject({ code: 'ENOENT' });
    const owner = await dirs.inspectDirectory('/home/admin/projects/demo');
    expect(await owner.fs.driver.exists('/a.md')).toBe(true); await owner.dispose();
});
