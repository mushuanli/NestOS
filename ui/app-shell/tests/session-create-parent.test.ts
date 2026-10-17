import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { SessionFilesService, createSessionAttachmentMounts } from '@itookit/app-core';

it.each([null, '/group'] as const)('creates a sibling Session when the selected Session belongs to %s', async folder => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const alert = vi.fn(); vi.stubGlobal('alert', alert);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    if (folder) await repository.createFolder(folder);
    const id = await repository.createSession('Existing', folder);
    const intrinsic = createSessionAttachmentMounts(repository);
    const files = new SessionFilesService(root, id => intrinsic.forSession(id)); await files.initialize();
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async () => ({ destroy: vi.fn() }));
    const kernel = { onChanged: () => () => {}, listSessionTasks: async () => [] };
    const workbench = createTestWorkbench({  sidebar: sidebar, container: main, repository: repository, files: files, factory: factory as never, onSelect: () => {}, hostContext: undefined, kernel: kernel as never, fileFactory: factory as never });
    try {
        await workbench.start();
        await workbench.openResource(`${folder ? '/folder:group' : ''}/${id}`);
        await (workbench as any).fileNavigation;
        sidebar.querySelector<HTMLButtonElement>('[data-action="create-file"]')!.click();
        await vi.waitFor(() => { expect(alert.mock.calls).toEqual([]); expect(sidebar.querySelector('.vfs-node-list__item-creator-input')).not.toBeNull(); });
        const input = sidebar.querySelector<HTMLInputElement>('.vfs-node-list__item-creator-input')!;
        expect(input).not.toBeNull();
        expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(input.value.length);
        input.value = 'Sibling'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(async () => expect(await repository.list()).toHaveLength(2));
        const sibling = (await repository.list()).find(item => item.id !== id)!;
        expect(sibling).toMatchObject({ title: 'Sibling', folder });
        expect(alert).not.toHaveBeenCalled();
        expect(await repository.getManifest(id)).toMatchObject({ title: 'Existing' });
        // Real writable directories retain their target instead of creating another Session.
        await workbench.openResource(`${folder ? '/folder:group' : ''}/${id}/files/attachments`);
        await (workbench as any).fileNavigation;
        sidebar.querySelector<HTMLButtonElement>('[data-action="create-file"]')!.click();
        await vi.waitFor(() => { expect(alert.mock.calls).toEqual([]); expect(sidebar.querySelector('.vfs-node-list__item-creator-input')).not.toBeNull(); });
        const fileInput = sidebar.querySelector<HTMLInputElement>('.vfs-node-list__item-creator-input')!;
        fileInput.value = 'note.md'; fileInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const owner = await files.acquireFiles(id);
        try { await vi.waitFor(async () => expect(await owner.context.fs.driver.exists('/attachments/note.md')).toBe(true)); }
        finally { await owner.release(); }
        expect(await repository.list()).toHaveLength(2);
        expect(alert).not.toHaveBeenCalled();
    } finally {
        await workbench.destroy(); await files.dispose(); await repository.dispose(); await manager.dispose();
        sidebar.remove(); main.remove(); vi.unstubAllGlobals();
    }
});

it('maps Flow files into the chat sidebar and deletes through to the shared Flow directory', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const flowFiles = await manager.openFileSystem('/home/admin/flows');
    await flowFiles.driver.createFile({ parentPath: '/', name: 'essay-review-isolated.flow', content: '{}' });
    const repository = new SessionRepository(root); await repository.init();
    const intrinsic = createSessionAttachmentMounts(repository);
    const files = new SessionFilesService(root, id => intrinsic.forSession(id)); await files.initialize();
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async () => ({ destroy: vi.fn() })), navigate = vi.fn();
    const kernel = { onChanged: () => () => {}, listSessionTasks: async () => [] };
    const workbench = createTestWorkbench({  sidebar: sidebar, container: main, repository: repository, files: files, factory: factory as never, onSelect: () => {}, hostContext: { navigate } as never, kernel: kernel as never, fileFactory: factory as never, directoryMounts: undefined, sessionSkills: undefined, manageMemory: undefined, flows: { fs: flowFiles, menu: { items: (_item, defaults) => defaults } } });
    try {
        await workbench.start();
        const view = (workbench as any).navigationFiles;
        expect((await view.driver.getChildren('/')).map((node: any) => node.path)).toContain('/@flows');
        expect(sidebar.textContent).toMatch(/flows/i);
        expect((await view.driver.getChildren('/@flows')).map((node: any) => node.name)).toContain('essay-review-isolated.flow');
        await workbench.openResource('/@flows/essay-review-isolated.flow');
        expect(navigate).toHaveBeenCalledWith({ target: 'flows', resourceId: '/essay-review-isolated.flow' });
        await view.driver.delete(['/@flows/essay-review-isolated.flow']);
        expect(await flowFiles.driver.exists('/essay-review-isolated.flow')).toBe(false);
    } finally {
        await workbench.destroy(); await files.dispose(); await repository.dispose(); await manager.dispose();
        sidebar.remove(); main.remove();
        vi.unstubAllGlobals();
    }
});
