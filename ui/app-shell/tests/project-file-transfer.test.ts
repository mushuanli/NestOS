import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, SessionFilesService, ProjectService, folderBrowserPath } from '@itookit/app-core';

it('copies and moves a selected file between project file roots using the shared picker', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const a = await projects.create('Source'), b = await projects.create('Target');
    const from = folderBrowserPath(a.path), to = folderBrowserPath(b.path);
    const source = await projects.openWorkspace(a.path);
    await source.fs.driver.createFile({ name: 'a.md', parentPath: '/workspace', content: 'project content' }); await source.dispose();
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const kernel = { onChanged: () => () => {}, async *listSessions() {}, listSessionTasks: async () => [] };
    const file = vi.fn(async (_mount: HTMLElement, _options: any) => ({ destroy() {}, navigateTo() {} }));
    const workbench = createTestWorkbench({  sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        factory: async () => ({ destroy() {} }) as never, fileFactory: file as never, onSelect() {}, kernel: kernel as never });
    try {
        await workbench.start(); await workbench.openResource(from + '/@files');
        await vi.waitFor(() => expect((workbench as any).sidebarUI.getSnapshot().activeId).toBe(from + '/@files'));
        const currentPanel = () => main.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')!;
        currentPanel().querySelector<HTMLInputElement>(`[data-selection-id="${from}/@files/a.md"]`)!.click();
        currentPanel().querySelector<HTMLButtonElement>('[data-action="bulk-copy"]')!.click();
        const modal = () => document.querySelector<HTMLElement>('.vfs-move-modal-overlay')!;
        await vi.waitFor(() => expect(modal().style.display).toBe('flex'));
        await vi.waitFor(() => expect(modal().querySelector(`[data-folder-id="${to}/@files"]`)).not.toBeNull());
        expect(modal().querySelector(`[data-folder-id="${to}"]`)).toBeNull();
        modal().querySelector<HTMLElement>(`[data-folder-id="${to}/@files"] .vfs-move-modal__folder-title`)!.click();
        modal().querySelector<HTMLElement>('[data-action="confirm-move"]')!.click();
        await vi.waitFor(() => expect(modal().style.display).toBe('none'));
        const target = await projects.openWorkspace(b.path);
        try { expect(await target.fs.driver.readContent('/workspace/a.md', { encoding: 'utf-8' })).toBe('project content'); }
        finally { await target.dispose(); }
        const selectedProject = sidebar.querySelector('select')!.value;
        await workbench.openResource(to + '/@files/a.md');
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(to + '/@files/a.md'));
        expect(file.mock.calls.at(-1)![1].initialContent).toBe('project content');
        expect(sidebar.querySelector('select')!.value).toBe(selectedProject);
        await workbench.openResource(from + '/@files');
        const selected = currentPanel().querySelector<HTMLInputElement>(`[data-selection-id="${from}/@files/a.md"]`)!;
        if (!selected.checked) selected.click();
        // The source remains selected; moving onto the copy must report a conflict.
        currentPanel().querySelector<HTMLButtonElement>('[data-action="bulk-move"]')!.click();
        await vi.waitFor(() => expect(modal().style.display).toBe('flex'));
        await vi.waitFor(() => expect(modal().querySelector(`[data-folder-id="${to}/@files"]`)).not.toBeNull());
        modal().querySelector<HTMLElement>(`[data-folder-id="${to}/@files"] .vfs-move-modal__folder-title`)!.click();
        modal().querySelector<HTMLElement>('[data-action="confirm-move"]')!.click();
        await vi.waitFor(() => expect(modal().querySelector('[role="alert"]')?.textContent).toContain('EEXIST'));
        modal().querySelector<HTMLElement>('[data-action="cancel-move"]')!.click();
        const removeCopy = await projects.openWorkspace(b.path);
        try { await removeCopy.fs.driver.delete(['/workspace/a.md']); } finally { await removeCopy.dispose(); }
        await (workbench as any).sidebarUI.runBulkAction('move', [from + '/@files/a.md']);
        await vi.waitFor(() => expect(modal().querySelector(`[data-folder-id="${to}/@files"]`)).not.toBeNull());
        modal().querySelector<HTMLElement>(`[data-folder-id="${to}/@files"] .vfs-move-modal__folder-title`)!.click();
        modal().querySelector<HTMLElement>('[data-action="confirm-move"]')!.click();
        await vi.waitFor(() => expect(modal().style.display).toBe('none'));
        const retained = await projects.openWorkspace(a.path);
        try {
            expect(await retained.fs.driver.exists('/workspace/a.md')).toBe(false);
            await retained.fs.driver.createFile({ parentPath: '/workspace/nested', name: 'b.md', content: 'nested', recursive: true });
        } finally { await retained.dispose(); }
        await (workbench as any).sidebarUI.refresh();
        await (workbench as any).sidebarUI.expandPath(from + '/@files');
        await workbench.openResource(from + '/@files/nested');
        (workbench as any).tabs.keep(from + '/@files/nested');
        const errors = vi.spyOn(console, 'error'); errors.mockClear();
        await (workbench as any).sidebarUI.runBulkAction('move', [from + '/@files/nested']);
        await vi.waitFor(() => expect(modal().querySelector(`[data-folder-id="${to}/@files"]`)).not.toBeNull());
        modal().querySelector<HTMLElement>(`[data-folder-id="${to}/@files"] .vfs-move-modal__folder-title`)!.click();
        modal().querySelector<HTMLElement>('[data-action="confirm-move"]')!.click();
        await vi.waitFor(() => expect(modal().style.display).toBe('none'));
        await vi.waitFor(() => expect(currentPanel().querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(false));
        expect(errors.mock.calls.filter(args => args[0] === '[Project transfer]')).toEqual([]);
        const moved = await projects.openWorkspace(b.path);
        try { expect(await moved.fs.driver.readContent('/workspace/nested/b.md', { encoding: 'utf-8' })).toBe('nested'); }
        finally { await moved.dispose(); errors.mockRestore(); }
    } finally { await workbench.destroy(); sidebar.remove(); main.remove(); await mounts.dispose(); await files.dispose(); await manager.dispose(); }
});
