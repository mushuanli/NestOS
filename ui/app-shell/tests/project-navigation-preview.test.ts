// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {SessionRepository} from '@itookit/llm-session';
import {DirectoryMountService, SessionFilesService, ProjectService, folderBrowserPath} from '@itookit/app-core';
import {createTestWorkbench} from './helpers/application';

it('limits sidebar files and favorites to 15 and opens complete canonical directories in the main pane', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value)});
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root, async id => {await projects.initializeSession(id);}); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const project = await projects.create('Research'), path = folderBrowserPath(project.path);
    const owner = await projects.openFiles(project.path);
    for (let i = 0; i < 17; i++) {
        const name = `item-${i}.md`;
        await owner.fs.driver.createFile({parentPath: '/', name, content: `File ${i}`});
        await projects.favorites.toggle(project.project.id, {kind: 'file', path: `/workspace/${name}`, nodeType: 'file'}, name);
    }
    await owner.dispose();
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const kernel = {onChanged: () => () => {}, async *listSessions() {}, closeSession: vi.fn(async () => {}),
        sessionStat: vi.fn(async () => ({phase: 'closed'})), removeSession: vi.fn(async () => {})};
    const workbench = createTestWorkbench({sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        kernel: kernel as any, factory: vi.fn(async () => ({destroy() {}})) as any, onSelect() {}});
    try {
        await workbench.start(); await workbench.openResource(path);
        for (const [segment, label] of [['@files', 'project.moreFiles'], ['@favorites', 'project.moreFavorites']] as const) {
            const directory = path + '/' + segment;
            const rows = () => sidebar.querySelectorAll(`[data-item-id="${directory}"] [data-item-type="file"]`);
            sidebar.querySelector<HTMLElement>(`[data-item-id="${directory}"] [data-action="toggle-folder"]`)!.click();
            await vi.waitFor(() => expect(rows()).toHaveLength(15));
            const more = sidebar.querySelector<HTMLButtonElement>(`[data-preview-id="${directory}"]`)!;
            expect(more.textContent).toBe('… ' + t(label)); more.click();
            await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(directory));
            const panel = main.querySelector('.workbench-tabs__panel:not([hidden])')!;
            await vi.waitFor(() => expect(panel.querySelectorAll('tbody tr[data-resource-id]')).toHaveLength(17));
            expect(rows()).toHaveLength(15);
            expect([...panel.querySelectorAll<HTMLElement>('tbody tr[data-resource-id]')]
                .every(row => row.dataset.resourceId?.startsWith(directory + '/'))).toBe(true);
        }
        expect(await projects.favorites.list(project.project.id)).toHaveLength(17);
    } finally {
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        document.body.replaceChildren(); vi.unstubAllGlobals();
    }
});
