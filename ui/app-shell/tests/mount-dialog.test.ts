// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, SessionFilesService } from '@itookit/app-core';
import { showMountDialog } from '../src/files/mount-dialog';
it('sets a default without granting it, then mounts and unmounts through the shared dialog', async () => {
    const modalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const id = await repository.createSession('UI');
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    await root.driver.createDirectory({ parentPath: '/home/admin/projects', name: 'demo', recursive: true });
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const homeClosing = showMountDialog(mounts, files, id, 'home');
    const button = (text: string) => [...document.querySelectorAll('dialog button')].find(b => b.textContent === text) as HTMLButtonElement;
    try {
        await vi.waitFor(() => expect(button(t('mount.dialog.home')).disabled).toBe(false));
        (document.querySelector('[aria-label="来源目录"]') as HTMLInputElement).value = '~/projects/demo';
        button(t('mount.dialog.home')).click();
        await vi.waitFor(() => expect(mounts.getHome()).toBe('/home/admin/projects/demo'));
        expect(await files.inspect(id)).toBeNull();
        await vi.waitFor(() => expect(button(t('mount.dialog.close')).disabled).toBe(false));
        button(t('mount.dialog.close')).click(); expect(await homeClosing).toBe(true);
        const closing = showMountDialog(mounts, files, id, 'mount');
        await vi.waitFor(() => expect(button(t('mount.dialog.mountDefault')).disabled).toBe(false));
        button(t('mount.dialog.mountDefault')).click();
        await vi.waitFor(async () => expect((await files.inspect(id))?.cwd).toBe('/workspace'));
        await vi.waitFor(() => expect(button(t('mount.dialog.remove'))).toBeTruthy());
        await vi.waitFor(() => expect(button(t('mount.dialog.remove')).disabled).toBe(false));
        button(t('mount.dialog.remove')).click();
        await vi.waitFor(async () => expect((await files.inspect(id))?.mounts).toEqual([]));
        await vi.waitFor(() => expect(button(t('mount.dialog.remove'))).toBeUndefined());
        await vi.waitFor(() => expect(button(t('mount.dialog.close')).disabled).toBe(false));
        button(t('mount.dialog.close')).click(); expect(await closing).toBe(true);
    } finally { document.body.replaceChildren(); if (modalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modalDescriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); vi.restoreAllMocks(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose(); }
});
