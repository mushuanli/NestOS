import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { bindApplicationBackend } from '../../src/host/application-client';
import { restrictApplicationFiles } from '../../src/host/application-access';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    await root.driver.createDirectory({ parentPath: '/home/admin', name: 'notes', recursive: true });
    const fs = await manager.openFileSystem('/home/admin/notes');
    await fs.driver.createFile({ parentPath: '/', name: 'note.md', content: 'body' });
    const backend = bindApplicationBackend({ vfs: manager } as LocalApplicationServices);
    return { manager, fs, backend };
}
it('aggregates preferences and root metadata without reading file bodies and shares warm reads across clients', async () => {
    const f = await fixture();
    await f.backend.writeUiDocuments({ 'notes-workspace.ui': { version: 1 }, 'notes-workspace.workbench': { version: 1, tabs: [] } });
    const listing = vi.spyOn(f.fs.driver, 'getChildren'), read = vi.spyOn(f.fs.driver, 'readContent');
    await f.backend.warmNavigation(['/home/admin/notes']);
    const another = bindApplicationBackend({ vfs: f.manager } as LocalApplicationServices);
    const views = await Promise.all([f.backend.navigationView({ root: '/home/admin/notes', scope: 'notes-workspace' }),
        another.navigationView({ root: '/home/admin/notes', scope: 'notes-workspace' })]);
    expect(listing).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    expect(views[0].documents['notes-workspace.ui']).toEqual({ version: 1 });
    expect(views[0].directory.nodes.map(node => node.name)).toContain('note.md');
    views[0].directory.nodes.splice(0); expect(views[1].directory.nodes.length).toBeGreaterThan(0);
});
it('invalidates cached roots on mutation and expiration and never retains a failed read', async () => {
    const f = await fixture(), listing = vi.spyOn(f.fs.driver, 'getChildren');
    await f.backend.warmNavigation(['/home/admin/notes']);
    await f.fs.driver.createFile({ parentPath: '/', name: 'new.md', content: 'new' });
    let view = await f.backend.navigationView({ root: '/home/admin/notes', scope: 'notes' });
    expect(view.directory.nodes.map(node => node.name)).toContain('new.md'); expect(listing).toHaveBeenCalledTimes(2);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 16000);
    listing.mockRejectedValueOnce(new Error('temporary read failure'));
    await expect(f.backend.warmNavigation(['/home/admin/notes'])).rejects.toThrow('temporary read failure');
    view = await f.backend.navigationView({ root: '/home/admin/notes', scope: 'notes' });
    expect(view.directory.nodes.map(node => node.name)).toContain('new.md'); expect(listing).toHaveBeenCalledTimes(4);
});
it('checks permitted roots before cached navigation reads and prewarming', async () => {
    const f = await fixture();
    const allowed = restrictApplicationFiles({ services: { vfs: f.manager } as never, backend: f.backend }, ['/home/admin/notes', '/etc']);
    await expect(allowed.backend.navigationView({ root: '/var/lib/kernel', scope: 'notes' })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(allowed.backend.warmNavigation(['/home/admin/notes', '/var/lib/kernel'])).rejects.toMatchObject({ code: 'EACCES' });
    await expect(allowed.backend.warmNavigation(Array(3).fill('/home/admin/notes'))).rejects.toMatchObject({ code: 'EINVAL' });
    const etc = await allowed.backend.navigationView({ root: '/etc', scope: 'settings' });
    await expect(Promise.resolve().then(() => etc.files.fs.driver.createFile({ parentPath: '/', name: 'secret' }))).rejects.toMatchObject({ code: 'EACCES' });
});
it('marks a snapshot stale when a content event races the directory read', async () => {
    const f = await fixture(), original = f.fs.driver.getChildren.bind(f.fs.driver);
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const listing = vi.spyOn(f.fs.driver, 'getChildren').mockImplementationOnce(async (path, options) => {
        const nodes = await original(path, options); await blocked; return nodes;
    });
    const pending = f.backend.navigationView({ root: '/home/admin/notes', scope: 'notes' });
    await vi.waitFor(() => expect(listing).toHaveBeenCalledOnce());
    await f.fs.driver.createFile({ parentPath: '/', name: 'racing.md', content: 'racing' }); finish();
    expect((await pending).directory.stale).toBe(true);
    const current = await f.backend.navigationView({ root: '/home/admin/notes', scope: 'notes' });
    expect(current.directory.stale).not.toBe(true); expect(current.directory.nodes.map(node => node.name)).toContain('racing.md');
});

it('checks snapshot freshness again after waiting for presentation documents', async () => {
    const f = await fixture(); await f.backend.warmNavigation(['/home/admin/notes']);
    const etc = await f.manager.openFileSystem('/etc'), original = etc.driver.readContent.bind(etc.driver);
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const read = vi.spyOn(etc.driver, 'readContent').mockImplementationOnce(async (path, options) => { await blocked; return original(path, options); });
    const pending = f.backend.navigationView({ root: '/home/admin/notes', scope: 'notes' });
    await vi.waitFor(() => expect(read).toHaveBeenCalled()); await new Promise(resolve => setTimeout(resolve, 0));
    await f.fs.driver.createFile({ parentPath: '/', name: 'after-snapshot.md', content: 'new' }); finish();
    expect((await pending).directory.stale).toBe(true);
});
