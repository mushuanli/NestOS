import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createVFS, MemoryBackend, type IFileSystem } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, ProjectService, SessionFilesService, folderBrowserPath } from '@itookit/app-core';
import { ProjectNavigation } from '../src/projects/ProjectNavigation';
import { projectItems } from '../src/projects/navigation-policy';
import { refreshDirectoryList } from '../src/workbench/directory-list';
import { conversationResourcePath } from '@itookit/app-contracts';

function actions() {
    return { createProject: vi.fn(), createSession: vi.fn(), createChild: vi.fn(), importItems: vi.fn(),
        exportItems: vi.fn(), report: vi.fn(), retryDeletions: vi.fn(), contentChanged: vi.fn() };
}

async function projectServices(root: IFileSystem, repository: SessionRepository) {
    const files = new SessionFilesService(root); await files.initialize();
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    return { files, mounts, projects: new ProjectService(root, repository, mounts, files) };
}

it('keeps all-project sidebar sessions after refresh and shares project rows with the directory', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }), root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const { projects, mounts, files } = await projectServices(root, repository); await projects.ensureStartup();
    const project = await projects.create('Visible'), hidden = await projects.create('Collapsed');
    await projects.sessions.create('Visible conversation', await projects.sessionFolder(project));
    await projects.sessions.create('Collapsed conversation', await projects.sessionFolder(hidden));
    const path = folderBrowserPath(project.path), sidebar = document.createElement('aside'), main = document.createElement('main');
    document.body.append(sidebar, main);
    const workbench = createTestWorkbench({ sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        kernel: { onChanged: () => () => {}, async *listSessions() {} } as never, factory: async () => ({ destroy() {} }) as never, onSelect() {} });
    try {
        await workbench.start();
        const ui = (workbench as unknown as { sidebarUI: import('@itookit/vfs-ui').VFSUIShell }).sidebarUI;
        await ui.expandPath(path); await workbench.refresh();
        expect(sidebar.textContent).toContain('Visible conversation');
        expect(sidebar.querySelector<HTMLSelectElement>('.workbench-project-navigation select')!.value).toBe('/');
        await workbench.openResource(path); await (workbench as unknown as { fileNavigation: Promise<void> }).fileNavigation;
        const panel = main.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')!;
        await projects.sessions.create('Fresh conversation', await projects.sessionFolder(project));
        await refreshDirectoryList(panel);
        const expected = projectItems(ui.getNode(path)!.children ?? []).map(node => conversationResourcePath(node.id)).sort();
        expect([...panel.querySelectorAll<HTMLElement>('[data-resource-id]')].map(row => conversationResourcePath(row.dataset.resourceId!)).sort()).toEqual(expected);
        expect(panel.textContent).toContain('Visible conversation');
        expect(panel.textContent).toContain('Fresh conversation');
        expect(sidebar.textContent).toContain('Fresh conversation');
    } finally { await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose(); sidebar.remove(); main.remove(); }
});

it('resolves project folders from one organization snapshot per sync and refresh', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const { projects, mounts, files } = await projectServices(root, repository);
    let navigation: ProjectNavigation | undefined;
    try {
        const project = await projects.create('Demo');
        const commands = actions(); commands.createProject.mockResolvedValue(undefined);
        navigation = new ProjectNavigation(projects, () => undefined, commands);
        expect(navigation.header.querySelector('[data-action="create-project"]')).toBeNull();
        expect(navigation.toolbarContainer.hidden).toBe(false);

        const list = vi.spyOn(repository, 'listSummaries'), folders = vi.spyOn(repository, 'listFolders');
        list.mockClear(); folders.mockClear();
        await navigation.sync(folderBrowserPath(project.path));
        expect(list).not.toHaveBeenCalled();
        expect(folders).toHaveBeenCalledTimes(1);
        expect(navigation.currentProject()?.path).toBe('/Demo');
        expect(navigation.toolbarContainer.hidden).toBe(false);
        expect(navigation.header.querySelectorAll(':scope > button')).toHaveLength(2);
        const selector = navigation.header.querySelector('select')!;
        expect(selector.querySelector('option[value="/"]')?.textContent).toBe('所有项目');
        expect(selector.querySelector('option[value="@new-project"]')).toBeNull();
        await navigation.refresh();
        expect(list).not.toHaveBeenCalled();
        expect(folders).toHaveBeenCalledTimes(2);
        expect(navigation.currentProject()?.path).toBe('/Demo');
        list.mockClear();
        await navigation.sync(folderBrowserPath(project.path) + '/@files/notes.md');
        await navigation.refresh();
        expect(list).not.toHaveBeenCalled();
        expect(navigation.currentProject()?.path).toBe('/Demo');
        const unrelated = await projects.create('Unrelated');
        const navigationReads = vi.spyOn(projects.sessions, 'navigation');
        navigationReads.mockClear();
        navigation.showDraft(unrelated);
        expect(navigation.currentProject()?.path).toBe('/Demo');
        expect(selector.value).toBe(folderBrowserPath('/Demo'));
        expect(navigationReads).not.toHaveBeenCalled();
        expect(navigation.header.querySelector('.workbench-project-navigation__create')?.getAttribute('aria-current')).toBe('false');
        navigation.showDraft(project);
        expect(navigation.header.querySelector('.workbench-project-navigation__create')?.getAttribute('aria-current')).toBe('page');
        expect(navigationReads).not.toHaveBeenCalled();
    } finally { navigation?.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose(); }
});

it('boots when the persisted selection names a route this build no longer serves', async () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    // `/@flows` was only a route while Flows were mounted at the root without a project service.
    const restored = { activeId: '/@flows', expandedFolderIds: ['/@flows'], selectedItemIds: [] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async () => ({ destroy: vi.fn() }));
    const kernel = { onChanged: () => () => {}, async *listSessions() {} };
    const workbench = createTestWorkbench({  sidebar: sidebar, container: main, repository: repository, files: files,
        factory: factory as never, onSelect: () => {}, hostContext: undefined, kernel: kernel as never,
        fileFactory: factory as never, directoryMounts: mounts, projects: projects, uiPersistence: { load: () => restored } });
    try {
        await workbench.start();
        expect(sidebar.querySelector('.workbench-sidebar__navigation')).toBeTruthy();
        expect(sidebar.querySelector('.vfs-columns')).toBeNull();
        expect(workbench.getActiveResourceId()).not.toBe('/@flows');
    } finally {
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        document.body.replaceChildren(); warn.mockRestore(); vi.unstubAllGlobals();
    }
});

it('opens project files before blocked navigation and discards stale navigation on another route', async () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const startupProject = (await projects.current())!;
    const startupPath = folderBrowserPath(startupProject.path);
    const restored = { expandedFolderIds: [startupPath, startupPath + '/@files', startupPath + '/@files/old'], selectedItemIds: [] };
    const openFiles = vi.spyOn(projects, 'openFiles');
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async () => ({ destroy: vi.fn() }));
    const kernel = { onChanged: () => () => {}, async *listSessions() {} };
    const sync = vi.spyOn(ProjectNavigation.prototype, 'sync');
    let releaseNavigation = () => {};
    const blocked = new Promise<void>(resolve => { releaseNavigation = resolve; });
    const workbench = createTestWorkbench({  sidebar: sidebar, container: main, repository: repository, files: files,
        factory: factory as never, onSelect: () => {}, hostContext: undefined, kernel: kernel as never,
        fileFactory: factory as never, directoryMounts: mounts, projects: projects, uiPersistence: { load: () => restored } });
    try {
        await workbench.start();
        expect(openFiles).not.toHaveBeenCalled();
        await workbench.openResource(startupPath);
        // Expand remembered descendants only after the user enters a project.
        await (workbench as unknown as {fileNavigation: Promise<void>}).fileNavigation;
        expect(openFiles).toHaveBeenCalled();
        const startup = await projects.current();
        expect(startup).toBeDefined();
        expect(sync).toHaveBeenCalledWith(folderBrowserPath(startup!.path), { reveal: true });
        const owner = await projects.openFiles(startup!.path);
        await owner.fs.driver.createFile({ parentPath: '/', name: 'notes.md', content: 'body before navigation' });
        await owner.dispose();
        const originalNavigation = projects.sessions.navigation.bind(projects.sessions);
        const navigation = vi.spyOn(projects.sessions, 'navigation');
        navigation.mockImplementationOnce(async options => {
            const snapshot = await originalNavigation(options);
            await blocked; return snapshot;
        });
        const filePath = folderBrowserPath(startup!.path) + '/@files/notes.md';
        let ready = false;
        const opening = workbench.openResource(filePath).then(() => { ready = true; });
        await vi.waitFor(() => expect(ready).toBe(true));
        await opening;
        expect(factory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialContent: 'body before navigation' }));
        expect(workbench.getActiveResourceId()).toBe(filePath);
        await vi.waitFor(() => expect(navigation).toHaveBeenCalled());
        await workbench.openResource(folderBrowserPath(startup!.path));
        releaseNavigation();
        await sync.mock.results[1]!.value;
        expect(workbench.getActiveResourceId()).toBe(folderBrowserPath(startup!.path));
        expect(sidebar.querySelector('.vfs-columns')).toBeNull();
        await projects.favorites.toggle(startup!.project.id, { kind: 'file', path: '/workspace/notes.md', nodeType: 'file' }, 'Notes');
        const favorite = (await projects.favorites.list(startup!.project.id))[0];
        let releaseFavorite!: () => void, started!: () => void;
        const favoriteReady = new Promise<void>(resolve => { started = resolve; });
        const gate = new Promise<void>(resolve => { releaseFavorite = resolve; });
        const listFavorites = projects.favorites.list.bind(projects.favorites);
        const listSpy = vi.spyOn(projects.favorites, 'list').mockImplementationOnce(async id => {
            started(); await gate; return listFavorites(id);
        });
        const favoriteOpen = workbench.openResource(startupPath + '/@favorites/' + favorite.id);
        try {
            await favoriteReady;
            await workbench.openResource('/');
        } finally { releaseFavorite(); }
        await favoriteOpen; listSpy.mockRestore();
        expect(workbench.getActiveResourceId()).toBe('/');

    } finally {
        releaseNavigation();
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        document.body.replaceChildren(); vi.unstubAllGlobals(); sync.mockRestore();
    }
});

it('shows session cleanup only while a deletion is pending, including its rendered visibility', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const style = document.createElement('style');
    style.textContent = readFileSync('src/styles/workspace.css', 'utf8'); document.head.append(style);
    const { projects, mounts, files } = await projectServices(root, repository);
    const navigation = new ProjectNavigation(projects, () => undefined, actions());
    document.body.append(navigation.header);
    try {
        await navigation.sync('/');
        const cleanup = [...navigation.header.querySelectorAll('button')].find(button => button.textContent?.startsWith('会话清理'))!;
        expect(cleanup.hidden).toBe(true); expect(getComputedStyle(cleanup).display).toBe('none');
        const session = await repository.createSession('Pending'); await repository.prepareSessionDeletion(session);
        await navigation.refresh();
        expect(cleanup.textContent).toBe('会话清理（1）'); expect(cleanup.hidden).toBe(false);
        expect(getComputedStyle(cleanup).display).not.toBe('none');
        await repository.deleteSession(session); await navigation.refresh();
        expect(cleanup.hidden).toBe(true); expect(getComputedStyle(cleanup).display).toBe('none');
    } finally { navigation.destroy(); navigation.header.remove(); style.remove(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose(); }
});

it('renders directory entries before blocked sidebar navigation and ignores its late result after another route opens', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/'), repository = new SessionRepository(root); await repository.init();
    const { projects, mounts, files } = await projectServices(root, repository);
    files.registerSource('home', await manager.openFileSystem('/home/admin')); await projects.ensureStartup();
    const project = (await projects.current())!, path = folderBrowserPath(project.path);
    const source = await projects.openFiles(project.path);
    await source.fs.driver.createDirectory({parentPath: '/', name: 'docs'});
    await source.fs.driver.createFile({parentPath: '/docs', name: 'ready.md', content: 'Ready'}); await source.dispose();
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const kernel = {onChanged: () => () => {}, async *listSessions() {}};
    const workbench = createTestWorkbench({ sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        kernel: kernel as never, factory: async () => ({destroy() {}}) as never, onSelect() {}});
    let release = () => {};
    const gate = new Promise<void>(resolve => {release = resolve;});
    try {
        await workbench.start(); await (workbench as unknown as {fileNavigation: Promise<void>}).fileNavigation;
        const original = projects.sessions.navigation.bind(projects.sessions);
        const navigation = vi.spyOn(projects.sessions, 'navigation').mockImplementationOnce(async options => {await gate; return original(options);});
        const directory = path + '/@files/docs';
        const opening = workbench.openResource(directory);
        await vi.waitFor(() => expect(main.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toContain('ready.md'));
        await opening; expect(workbench.getActiveResourceId()).toBe(directory);
        await vi.waitFor(() => expect(navigation).toHaveBeenCalled());
        await workbench.openResource('/'); release();
        await (workbench as unknown as {fileNavigation: Promise<void>}).fileNavigation;
        expect(workbench.getActiveResourceId()).toBe('/');
        expect(sidebar.querySelector<HTMLSelectElement>('.workbench-project-navigation select')!.value).toBe('/'); navigation.mockRestore();
        const ui = (workbench as unknown as {sidebarUI: import('@itookit/vfs-ui').VFSUIShell}).sidebarUI;
        await ui.selectPath(directory); await ui.refresh();
        expect(workbench.getActiveResourceId()).toBe('/');
    } finally {
        release(); await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        sidebar.remove(); main.remove();
    }
});

it('keeps project selection separate from entry and exposes creation only in its proper scope', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/'), repository = new SessionRepository(root); await repository.init();
    const { projects, mounts, files } = await projectServices(root, repository); await projects.ensureStartup();
    const project = (await projects.current())!, path = folderBrowserPath(project.path);
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const workbench = createTestWorkbench({ sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        kernel: { onChanged: () => () => {}, async *listSessions() {} } as never,
        factory: async () => ({ destroy() {} }) as never, onSelect() {} });
    try {
        await workbench.start();
        const selector = sidebar.querySelector<HTMLSelectElement>('.workbench-project-navigation select')!;
        const createProject = () => sidebar.querySelector<HTMLButtonElement>('[data-action="create-project"]')!;
        const createSession = () => sidebar.querySelector<HTMLButtonElement>('.workbench-project-navigation__create')!;
        expect(selector.value).toBe('/'); expect(createProject().hidden).toBe(false); expect(createSession().hidden).toBe(true);
        const row = () => sidebar.querySelector<HTMLElement>(`[data-item-id="${path}"] .vfs-directory-item__header`)!;
        row().click(); await Promise.resolve(); expect(selector.value).toBe('/'); expect(workbench.getActiveResourceId()).toBeNull();
        await workbench.refresh(); expect(selector.value).toBe('/');
        row().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(path));
        expect(selector.value).toBe(path); expect(createProject().hidden).toBe(true); expect(createSession().hidden).toBe(false);
        expect(selector.querySelector('[value="@new-project"]')).toBeNull();
        await workbench.openResource('/'); expect(selector.value).toBe('/');
        expect(createProject().hidden).toBe(false); expect(createSession().hidden).toBe(true);
        await expect(workbench.createResource()).rejects.toThrow('请在项目内创建会话');
    } finally {
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        sidebar.remove(); main.remove();
    }
});

it('runs transfer actions from the more menu without navigating or changing the selection', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/'), repository = new SessionRepository(root); await repository.init();
    const { projects, mounts, files } = await projectServices(root, repository), commands = { ...actions(), navigate: vi.fn() };
    const selectedIds = ['/project/session'], ui = { getSnapshot: () => ({ selectedIds, activeId: null }), refreshList() {}, setTitle() {} };
    const navigation = new ProjectNavigation(projects, () => ui as never, commands); document.body.append(navigation.header);
    try {
        const menu = navigation.header.querySelector('details')!, button = menu.querySelector<HTMLButtonElement>('[data-project-action="export"]')!;
        menu.open = true; button.click();
        await vi.waitFor(() => expect(commands.exportItems).toHaveBeenCalledWith({ selectedIds, activeId: null, parentPath: '/' }));
        expect(menu.open).toBe(false); expect(commands.navigate).not.toHaveBeenCalled(); expect(selectedIds).toEqual(['/project/session']);
        menu.open = true; document.body.click(); expect(menu.open).toBe(false);
    } finally {
        navigation.destroy(); navigation.header.remove(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
    }
});

it('ignores a delayed project choice after its navigation intent has been cancelled', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/'), repository = new SessionRepository(root); await repository.init();
    const { projects, mounts, files } = await projectServices(root, repository), commands = { ...actions(), navigate: vi.fn() };
    const project = await projects.create('Demo'), navigation = new ProjectNavigation(projects, () => undefined, commands);
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    try {
        await navigation.refresh(); const original = projects.forFolder.bind(projects);
        const lookup = vi.spyOn(projects, 'forFolder').mockImplementationOnce(async (...args) => { await pending; return original(...args); });
        const selector = navigation.header.querySelector('select')!; selector.value = folderBrowserPath(project.path);
        selector.dispatchEvent(new Event('change')); await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
        navigation.cancelPending(); release(); await vi.waitFor(() => expect(selector.disabled).toBe(false));
        expect(commands.navigate).not.toHaveBeenCalled(); expect(navigation.currentProject()).toBeUndefined(); expect(selector.value).toBe('/');
        lookup.mockRestore();
    } finally {
        release(); navigation.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
    }
});
