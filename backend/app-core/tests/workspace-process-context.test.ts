import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionFilesService } from '../src/vfs/session-files';
import { acquireWorkspaceProcessContext } from '../src/vfs/workspace-process-context';
import type { SessionProcessFactory } from '../src/vfs/session-process-context';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    await root.driver.createFile({ parentPath: '/base', name: 'file', content: 'base', recursive: true });
    await root.driver.createFile({ parentPath: '/copy', name: 'file', content: 'copy', recursive: true });
    await root.driver.createFile({ parentPath: '/extra', name: 'file', content: 'base', recursive: true });
    const files = new SessionFilesService(root); await files.initialize(); cleanup.push(() => files.dispose());
    files.registerSource('admin-home', await manager.openFileSystem('/base'));
    files.registerSource('extra', await manager.openFileSystem('/extra'));
    await files.configure('s', { mounts: [{ mountId: 'work', at: '/workspace', sourceId: 'admin-home', access: 'rw' }], cwd: '/workspace' }, 0);
    const source = { mountId: 'work', fs: await manager.openFileSystem('/copy'), directory: '/native/copy' };
    const mounts = async () => [{ sourceId: 'admin-home', directory: '/home/admin/base', at: '/workspace', access: 'rw' as const }];
    return { files, source, mounts };
}
const shell = { capabilities: { ripgrep: false, fd: false }, exec: async () => ({ stdout: '', stderr: '', code: 0 }) };

it('attenuates every user mount for read-only files and processes without changing ordinary access', async () => {
    const { files, source, mounts } = await setup();
    const original = (await files.inspect('s'))!;
    await files.configure('s', { cwd: original.cwd, mounts: [...original.mounts,
        { mountId: 'extra', sourceId: 'extra', at: '/extra', access: 'rw' }] }, original.revision);
    const configured = await files.inspect('s');
    const processMounts = async () => [...await mounts(), { sourceId: 'extra', directory: '/native/extra', at: '/extra', access: 'rw' as const }];
    const context = await acquireWorkspaceProcessContext(files, 's', { ...source, access: 'ro' }, async (_id, view, grants) => {
        expect(grants.map(mount => [mount.at, mount.access])).toEqual([['/workspace', 'ro'], ['/extra', 'ro']]);
        expect(await view.vfs.readFile('/workspace/file')).toBe('copy');
        expect(await view.vfs.readFile('/extra/file')).toBe('base');
        for (const path of ['/workspace/file', '/extra/file']) await expect(view.vfs.writeFile(path, 'denied')).rejects.toMatchObject({ code: 'EROFS' });
        return { nativeShell: shell, release: async () => {} };
    }, processMounts);
    try {
        expect(await files.inspect('s')).toEqual(configured);
        const normal = await files.acquire('s');
        try { await normal.vfs.writeFile('/extra/file', 'ordinary'); } finally { await normal.release(); }
        expect(await context.vfs.readFile('/extra/file')).toBe('ordinary');
    } finally { await context.release(); }
});

it('accepts an existing read-only grant without permitting a writable copy', async () => {
    const { files, source, mounts } = await setup();
    const record = (await files.inspect('s'))!;
    await files.configure('s', { cwd: record.cwd, mounts: record.mounts.map(mount => ({ ...mount, access: 'ro' })) }, record.revision);
    const processMounts = async () => (await mounts()).map(mount => ({ ...mount, access: 'ro' as const }));
    const factory = vi.fn(async () => ({ nativeShell: shell, release: async () => {} }));
    await expect(acquireWorkspaceProcessContext(files, 's', source, factory, processMounts)).rejects.toMatchObject({ code: 'EROFS' });
    expect(factory).not.toHaveBeenCalled();
    const context = await acquireWorkspaceProcessContext(files, 's', { ...source, access: 'ro' }, factory, processMounts);
    try { await expect(context.vfs.writeFile('file', 'denied')).rejects.toMatchObject({ code: 'EROFS' }); }
    finally { await context.release(); }
});

it('pairs isolated files and native mounts without translating the copy as admin-home', async () => {
    const { files, source, mounts } = await setup();
    const original = await files.inspect('s');
    const release = vi.fn();
    const factory: SessionProcessFactory = async (id, view, grants) => {
        expect(id).toBe('s'); expect(view.cwd).toBe('/workspace');
        expect(grants).toEqual([{ sourceId: 'flow-workspace', directory: '/native/copy', at: '/workspace', access: 'rw' }]);
        expect(await view.vfs.readFile('file')).toBe('copy');
        return { nativeShell: shell, release: async () => { expect(await view.vfs.readFile('file')).toBe('changed'); release(); } };
    };
    const context = await acquireWorkspaceProcessContext(files, 's', source, factory, mounts);
    await context.vfs.writeFile('file', 'changed');
    const normal = await files.acquire('s'); cleanup.push(normal.release);
    expect(await normal.vfs.readFile('file')).toBe('base');
    expect(await files.inspect('s')).toEqual(original);
    await Promise.all([context.release(), context.release()]);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(context.vfs.readFile('file')).rejects.toMatchObject({ code: 'EACCES' });
});

it('releases the newly opened process scope if authorization changes during acquisition', async () => {
    const { files, source, mounts } = await setup();
    const release = vi.fn(async () => {});
    const factory: SessionProcessFactory = async () => {
        await files.disable('s', 1);
        return { nativeShell: shell, release };
    };
    await expect(acquireWorkspaceProcessContext(files, 's', source, factory, mounts)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(release).toHaveBeenCalledTimes(1);
});

it('rejects mismatched process grants before opening any shell', async () => {
    const { files, source, mounts } = await setup();
    const factory = vi.fn(async () => ({ nativeShell: shell, release: async () => {} }));
    for (const grants of [[], [{ ...(await mounts())[0], access: 'ro' as const }], [{ ...(await mounts())[0], sourceId: 'other' }]]) {
        await expect(acquireWorkspaceProcessContext(files, 's', source, factory, async () => grants)).rejects.toMatchObject({ code: 'EACCES' });
    }
    expect(factory).not.toHaveBeenCalled();
});

it('preserves initialization errors and revokes the file view when the platform factory fails', async () => {
    const { files, source, mounts } = await setup();
    let read!: () => Promise<string>;
    await expect(acquireWorkspaceProcessContext(files, 's', source, async (_id, view) => {
        read = () => view.vfs.readFile('file'); throw new Error('IPC unavailable');
    }, mounts)).rejects.toThrow('IPC unavailable');
    await expect(read()).rejects.toMatchObject({ code: 'EACCES' });
});
