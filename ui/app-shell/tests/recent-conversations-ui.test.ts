// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, ProjectService, SessionFilesService } from '@itookit/app-core';
import { conversationResourcePath, folderBrowserPath, projectConversationsPath, resolveBrowserTarget } from '@itookit/app-contracts';
import { createTestWorkbench } from './helpers/application';

it('keeps fifteen sidebar sessions and opens a larger paged view when More is clicked', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const project = await projects.create('Many'), group = await projects.sessionFolder(project);
    for (let i = 0; i < 70; i++) {const id = await projects.sessions.create(`Session ${i}`, group); await repository.updateManifest(id, {updatedAt: 10000 + i});}
    const sidebar = document.createElement('aside'), main = document.createElement('main'); document.body.append(sidebar, main);
    const path = folderBrowserPath(project.path), kernel = {onChanged: () => () => {}, async *listSessions() {}};
    const workbench = createTestWorkbench({sidebar, container: main, repository, files, projects, directoryMounts: mounts, kernel: kernel as never,
        uiPersistence: {load: () => ({expandedFolderIds: [path]}), save() {}}, factory: async () => ({destroy() {}}) as never, onSelect() {}});
    const sessionRows = () => [...sidebar.querySelectorAll<HTMLElement>('[data-item-id]')].filter(row => resolveBrowserTarget(row.dataset.itemId!).kind === 'session');
    const panel = () => main.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')!;
    try {
        await workbench.start(); await vi.waitFor(() => expect(sessionRows()).toHaveLength(15));
        const more = [...sidebar.querySelectorAll<HTMLElement>('[data-item-id]')].find(row => resolveBrowserTarget(row.dataset.itemId!).kind === 'project-conversations' && row.textContent?.includes('更多会话'))!;
        expect(more).toBeDefined(); more.querySelector<HTMLElement>('.vfs-node-item__title')!.click();
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(projectConversationsPath(project.path)));
        await vi.waitFor(() => expect(panel().querySelectorAll('[data-resource-id]')).toHaveLength(51));
        expect(sessionRows()).toHaveLength(15); expect(sidebar.textContent).toContain('Session 69'); expect(sidebar.textContent).not.toContain('Session 0');
        const older = panel().querySelectorAll<HTMLElement>('[data-resource-id]')[20]!;
        older.querySelector<HTMLButtonElement>('[data-action="favorite-toggle"]')!.click();
        await vi.waitFor(async () => expect(await projects.favorites.list(project.project.id)).toHaveLength(1));
        await workbench.refresh();
        panel().querySelector<HTMLElement>(`[data-resource-id="${older.dataset.resourceId}"]`)!.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
        await vi.waitFor(() => expect(document.querySelector('.vfs-context-menu')?.textContent).toContain('取消收藏'));
        expect(sessionRows()).toHaveLength(15); document.body.click();
        const next = [...panel().querySelectorAll<HTMLElement>('[data-resource-id]')].find(row => resolveBrowserTarget(row.dataset.resourceId!).kind === 'project-conversations')!;
        const nextPath = conversationResourcePath(next.dataset.resourceId!); next.querySelector<HTMLButtonElement>('.workbench-directory__name')!.click();
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(nextPath));
        await vi.waitFor(() => expect(panel().querySelectorAll('[data-resource-id]')).toHaveLength(20));
        expect(sessionRows()).toHaveLength(15); expect(panel().textContent).toContain('Session 0');
    } finally {await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose(); sidebar.remove(); main.remove();}
});
