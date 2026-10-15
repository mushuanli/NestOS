import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, SessionFilesService, ProjectService, folderBrowserPath } from '@itookit/app-core';

it('follows a renamed project by identity without expanding its obsolete path', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const project = await projects.create('原项目文档');
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const report = vi.spyOn(console, 'error');
    const previousShow = HTMLDialogElement.prototype.showModal, previousClose = HTMLDialogElement.prototype.close;
    HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
    const kernel = { onChanged: () => () => {}, async *listSessions() {}, listSessionTasks: async () => [] };
    const workbench = createTestWorkbench({  sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        factory: async () => ({ destroy() {} }) as never, onSelect() {}, kernel: kernel as never });
    try {
        await workbench.start(); await workbench.openResource(folderBrowserPath(project.path));
        report.mockClear();
        const rename = (workbench as unknown as { renameProjectDialog(id: string): Promise<void> }).renameProjectDialog(project.project.id);
        await vi.waitFor(() => expect(document.querySelector('dialog input')).not.toBeNull());
        const input = document.querySelector<HTMLInputElement>('dialog input')!;
        expect(input.value).toBe('原项目文档'); input.value = '新项目文档';
        document.querySelector('dialog form')!.dispatchEvent(new Event('submit', { cancelable:true }));
        await rename;
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(folderBrowserPath('/新项目文档')));
        expect(sidebar.textContent).toContain('新项目文档');
        expect(report.mock.calls.some(call => String(call[0]).includes('expandDirectory failed'))).toBe(false);
    } finally { await workbench.destroy(); report.mockRestore(); HTMLDialogElement.prototype.showModal = previousShow; HTMLDialogElement.prototype.close = previousClose; sidebar.remove(); main.remove(); await mounts.dispose(); await files.dispose(); await manager.dispose(); }
});

it('removes a deleted project directory from navigation and allows an explicit new project', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const project = (await projects.current())!;
    await root.driver.delete([project.project.directory], { recursive: true });
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const report = vi.spyOn(console, 'error');
    const kernel = { onChanged: () => () => {}, async *listSessions() {}, listSessionTasks: async () => [] };
    const workbench = createTestWorkbench({  sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        factory: async () => ({ destroy() {} }) as never, onSelect() {}, kernel: kernel as never });
    const prefix = folderBrowserPath(project.path);
    try {
        await workbench.start();
        expect(await projects.list()).toEqual([]);
        expect(sidebar.querySelector(`[data-item-id="${prefix}"]`)).toBeNull();
        expect(await root.driver.exists(project.project.directory)).toBe(false);
        const replacement = await projects.create(project.name);
        await workbench.refresh(); await workbench.openResource(folderBrowserPath(replacement.path));
        expect(replacement.project.id).not.toBe(project.project.id);
        expect(await root.driver.exists(replacement.project.directory + '/.mindos/info.seq')).toBe(true);
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${prefix}/@files"]`)).not.toBeNull());
        expect(sidebar.querySelector(`[data-item-id="${prefix}/@files"]`)!.getAttribute('aria-disabled')).toBe('false');
    } finally { await workbench.destroy(); report.mockRestore(); sidebar.remove(); main.remove(); await mounts.dispose(); await files.dispose(); await manager.dispose(); }
});
