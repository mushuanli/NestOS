import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, SessionFilesService, ProjectService, folderBrowserPath } from '@itookit/app-core';

it('creates project Sessions from the selected project and edits its files in the same tree', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root, async id => { await projects.initializeSession(id); }); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const other = await projects.create('Research');
    const projectPath = folderBrowserPath(other.path);
    const owner = await projects.openFiles(other.path);
    await owner.fs.driver.createFile({ parentPath: '/', name: 'notes.md', content: 'research notes' }); await owner.dispose();
    const kernel = { onChanged: () => () => {}, async *listSessions() {},
        closeSession: vi.fn(async () => {}), sessionStat: vi.fn(async () => ({ phase: 'closed' })), removeSession: vi.fn(async () => {}) };
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const chat = vi.fn(async (element: HTMLElement, _options: any) => { element.textContent = 'chat'; return { destroy: vi.fn() }; });
    const file = vi.fn(async (element: HTMLElement, options: any) => { element.textContent = 'file'; return {
        destroy: vi.fn(), setTitle: vi.fn(), navigateTo: vi.fn(async () => {}), updateNodeId: (path: string) => { options.target.path = path; },
    }; });
    const chatFromFile = vi.fn(async () => {});
    const workbench = createTestWorkbench({  sidebar: sidebar, container: main, repository: repository, files: files, factory: chat as any, onSelect: () => {}, hostContext: { chatFromFile, toggleSidebar() {}, navigate: async () => {} }, kernel: kernel as any, fileFactory: file as any, directoryMounts: mounts, sessionSkills: undefined, manageMemory: undefined, flows: undefined, projects: projects });
    try {
        await workbench.start();
        await expect(workbench.createResource({ parentPath: '/' })).rejects.toThrow('请在项目内创建会话');
        await workbench.openResource('/');
        const selector = sidebar.querySelector<HTMLSelectElement>('.workbench-project-navigation select')!;
        expect(selector.value).toBe('/');
        const projectHeader = sidebar.querySelector<HTMLElement>(`[data-item-id="${projectPath}"] .vfs-directory-item__header`)!;
        expect(projectHeader).not.toBeNull(); projectHeader.click();
        expect(workbench.getActiveResourceId()).toBe('/');
        projectHeader.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe(projectPath));
        const projectPanel = main.querySelector('.workbench-tabs__panel:not([hidden])')!;
        await vi.waitFor(() => expect(projectPanel.querySelector(`[data-resource-id="${projectPath}/@files"]`)).not.toBeNull());
        expect(selector.value).toBe(projectPath);
        const initialSessions = (await repository.listSummaries()).length;
        expect(projectPanel.querySelector(`[data-resource-id="${projectPath}/@new"]`)).not.toBeNull();
        await workbench.openResource(projectPath + '/@new');
        expect(chat.mock.calls.at(-1)![1].sessionDraft).toBeDefined();
        expect((await repository.listSummaries()).length).toBe(initialSessions);
        await workbench.openResource(projectPath);
        expect(sidebar.querySelector(`[data-item-id="${folderBrowserPath((await projects.personal()).path)}"]`)).toBeNull();
        selector.value = '/'; selector.dispatchEvent(new Event('change', {bubbles: true}));
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('/'));
        await workbench.startSessionDraft(projectPath);
        expect(selector.value).toBe('/');
        expect(sidebar.querySelector(`[data-item-id="${folderBrowserPath((await projects.personal()).path)}"]`)).not.toBeNull();
        selector.value = projectPath; selector.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(selector.value).toBe(projectPath));
        await workbench.openResource(projectPath);
        const navigation = sidebar.querySelector('.workbench-sidebar__navigation')!;
        expect(navigation.textContent).toContain('Research');
        const header = navigation.querySelector('.workbench-project-navigation')!;
        expect([...header.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.closest('[hidden], details')).map(button => button.title))
            .toEqual(['新会话', t('action.refresh')]);
        expect([...header.querySelectorAll<HTMLElement>('[data-action]')].map(button => button.dataset.action))
            .toEqual(['create-project', 'refresh', 'import', 'export']);
        const createdProject = vi.spyOn(workbench as any, 'createProject').mockResolvedValue(undefined);
        header.querySelector<HTMLButtonElement>('[data-action="create-project"]')!.click();
        await new Promise(resolve => setTimeout(resolve, 0)); expect(createdProject).not.toHaveBeenCalled(); createdProject.mockRestore();
        expect(navigation.querySelector('[data-directory-action]')).toBeNull();
        expect(navigation.querySelectorAll('[data-action="import"]')).toHaveLength(1);
        expect(navigation.querySelector('[data-action="import"]')?.closest('.workbench-project-navigation')).toBe(header);
        const imported = vi.spyOn(workbench as any, 'importSelection').mockResolvedValue(undefined);
        const exported = vi.spyOn(workbench as any, 'exportSelection').mockResolvedValue(undefined);
        const more = header.querySelector<HTMLElement>('details > summary')!;
        for (const [action, command] of [['import', imported], ['export', exported]] as const) {
            more.click();
            const button = header.querySelector<HTMLButtonElement>(`details [data-project-action="${action}"]`)!;
            expect(button.querySelector('svg')).not.toBeNull();
            button.click();
            await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ selectedIds: [projectPath], activeId: projectPath, parentPath: projectPath }));
        }
        imported.mockRestore(); exported.mockRestore();

        expect(sidebar.querySelector('.vfs-columns')).toBeNull();
        // File children load only after their directory is explicitly expanded.
        const ui = (workbench as unknown as { sidebarUI: VFSUIShell }).sidebarUI;
        await ui.expandPath(projectPath + '/@files');
        expect(navigation.textContent).toContain('notes.md');
        const beforeDraft = (await repository.listSummaries()).length;
        await workbench.startSessionDraft(projectPath);
        expect((await repository.listSummaries()).length).toBe(beforeDraft);
        expect(chat.mock.calls.at(-1)![1].sessionDraft).toBeDefined();
        expect(navigation.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('新会话');
        await chat.mock.calls.at(-1)![1].sessionDraft.save('persisted composer');
        const personal = await projects.personal();
        await workbench.startSessionDraft(folderBrowserPath(personal.path));
        expect(selector.value).toBe(projectPath);
        const personalSession = await workbench.createResource();
        expect((await repository.getManifest(personalSession)).folder).toBe(await projects.sessionFolder(personal));
        expect(selector.value).toBe(projectPath);
        await workbench.openResource(projectPath);
        const openedDrafts = chat.mock.calls.length;
        await workbench.restoreResource(`draft:${other.project.id}`);
        expect(chat).toHaveBeenCalledTimes(openedDrafts);
        expect(workbench.getActiveResourceId()).toBe(`draft:${other.project.id}`);
        const session = await workbench.createResource();
        expect((await repository.getManifest(session)).folder).toBe(other.path + '/@sessions');
        await workbench.openResource(projectPath + '/@files');
        const activePanel = () => main.querySelector('.workbench-tabs__panel:not([hidden])')!;
        expect(activePanel().querySelector('.workbench-directory__table')?.textContent).toContain('notes.md');
        expect(activePanel().textContent).toContain('修改时间');
        expect(activePanel().querySelector<HTMLButtonElement>('.workbench-directory__name')?.title).toContain('创建时间');
        await vi.waitFor(() => expect(navigation.querySelector(`[data-item-id="${projectPath}/@files/notes.md"]`)).not.toBeNull());
        await workbench.openResource(projectPath + '/@files/notes.md');
        expect(file.mock.calls.at(-1)![1].initialContent).toBe('research notes');
        const options = file.mock.calls.at(-1)![1];
        const activeBeforeRefresh = workbench.getActiveResourceId();
        const filePanel = main.querySelector('.workbench-tabs__panel:not([hidden])');
        const refreshButton = header.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
        const refreshed = vi.spyOn(workbench as any, 'refresh');
        refreshButton.click(); refreshButton.click();
        await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(refreshButton.disabled).toBe(false)); refreshed.mockRestore();
        expect(workbench.getActiveResourceId()).toBe(activeBeforeRefresh);
        expect(main.querySelector('.workbench-tabs__panel:not([hidden])')).toBe(filePanel);
        expect(options.signal.aborted).toBe(false); expect(file).toHaveBeenCalledOnce();
        await options.hostContext.saveContent('/workspace/notes.md', 'edited in workbench');
        const quote = { path: '/workspace/notes.md', content: 'selected', selection: true };
        await options.hostContext.chatFromFile(quote);
        expect(chatFromFile).toHaveBeenCalledWith(quote, { projectFolder: other.path });
        const fileTab = () => main.querySelector<HTMLElement>(`[data-tab-id="${projectPath}/@files/notes.md"]`)!;
        fileTab().querySelector<HTMLButtonElement>('.workbench-tabs__pin')!.click();
        await workbench.openResource(projectPath);
        expect(options.signal.aborted).toBe(false);
        await options.files.fs.driver.rename('/workspace/notes.md', 'renamed.txt');
        await vi.waitFor(() => expect(options.target.path).toBe('/workspace/renamed.txt'));
        await workbench.openResource(projectPath + '/@files/renamed.txt');
        expect(file).toHaveBeenCalledOnce();
        await options.hostContext.saveContent(options.target.path, 'saved after rename');
        expect(await options.files.fs.driver.readContent('/workspace/renamed.txt', { encoding: 'utf-8' })).toBe('saved after rename');
        expect(await options.files.fs.driver.exists('/workspace/notes.md')).toBe(false);
        await workbench.openResource(projectPath + '/@files');
        const favoriteButton = () => activePanel().querySelector<HTMLButtonElement>(`[data-resource-id="${projectPath}/@files/renamed.txt"] [data-action="favorite-toggle"]`);
        await vi.waitFor(() => expect(favoriteButton()?.getAttribute('aria-label')).toBe('收藏'));
        favoriteButton()!.click();
        await vi.waitFor(async () => expect(await projects.favorites.list(other.project.id)).toHaveLength(1));
        const favorite = (await projects.favorites.list(other.project.id))[0];
        await workbench.openResource(projectPath + '/@favorites');
        expect(activePanel().textContent).toContain('收藏夹');
        await workbench.openResource(projectPath + '/@favorites/' + favorite.id);
        expect(workbench.getActiveResourceId()).toBe(projectPath + '/@files/renamed.txt');
        expect(file).toHaveBeenCalledOnce();
        const child = await workbench.createChild(session);
        const sibling = await workbench.createChild(session);
        expect((await repository.getManifest(child)).parentSessionId).toBe(session);
        expect((await repository.getManifest(sibling)).parentSessionId).toBe(session);
        expect(sidebar.querySelector('.vfs-columns')).toBeNull();
        await workbench.openResource('/');
        expect(sidebar.querySelector('.workbench-project-navigation select')?.value).toBe('/');
        expect(navigation.textContent).toContain('Research');
        await workbench.openResource(projectPath + '/@files/renamed.txt');
        expect(sidebar.querySelector('.workbench-project-navigation select')?.value).toBe('/');
        expect(file).toHaveBeenCalledOnce();
        const linked = await projects.openFiles(other.path);
        await linked.fs.driver.createFile({ parentPath: '/', name: 'linked.md', content: '# Intro\nLinked content' }); await linked.dispose();
        await workbench.openResource(projectPath + '/@favorites/' + favorite.id);
        await options.hostContext.openFile('/workspace/linked.md', 'intro');
        expect(workbench.getActiveResourceId()).toBe(projectPath + '/@files/linked.md');
        expect(file.mock.calls.at(-1)![1].initialContent).toContain('Linked content');
        expect(file.mock.results.at(-1)!.value && (await file.mock.results.at(-1)!.value).navigateTo).toHaveBeenCalledWith({ elementId: 'intro' });
    } finally {
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        document.body.replaceChildren(); vi.unstubAllGlobals();
    }
});

it('restores a bookmark inside an unreachable remote project without aborting bootstrap', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root, async id => { await projects.initializeSession(id); }); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const remote = await projects.create('Remote');
    const existing = await repository.createSession('Existing history', await projects.sessionFolder(remote));
    // Only the affected project is offline; the rest of the workbench must keep working.
    projects.remoteMounts = {
        onChange: () => () => {}, async compose(_id: string, owner: unknown) { return owner; }, async checkConnections() {}, projectOffline: () => true, degraded: () => true,
        list: () => [], status: () => 'offline', connectionStatus: () => 'offline', connection: () => { throw new Error('none'); },
        connections: () => [], assertUnmountable: async () => {}, forgetProject: async () => {}, dispose: async () => {},
    } as never;
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const workbench = createTestWorkbench({  sidebar, container: main, repository, files, factory: (async () => ({ destroy: vi.fn() })) as never,
        onSelect: () => {}, hostContext: { chatFromFile: async () => {}, toggleSidebar() {}, navigate: async () => {} }, kernel: { onChanged: () => () => {}, async *listSessions() {} } as never,
        fileFactory: (async () => ({ destroy: vi.fn() })) as never, directoryMounts: mounts, sessionSkills: undefined, manageMemory: undefined, flows: undefined, projects });
    try {
        await workbench.start();
        await expect(workbench.restoreResource(folderBrowserPath(remote.path))).resolves.toBeUndefined();
        expect(main.inert).not.toBe(true);
        const create = sidebar.querySelector<HTMLButtonElement>('.workbench-project-navigation__create');
        expect(create?.disabled).toBe(true);
        await expect(workbench.createResource({ parentPath: folderBrowserPath(remote.path) })).rejects.toThrow();
        await workbench.openResource(folderBrowserPath(remote.path) + '/@files');
        expect(main.inert).toBe(true);
        expect(workbench.getActiveResourceId()).toBe(folderBrowserPath(remote.path) + '/@files');
        expect(main.textContent).toContain('远程文件无法连接');
        await workbench.openResource(`${folderBrowserPath(await projects.sessionFolder(remote))}/${existing}`);
        expect(main.inert).toBe(false);
        expect(workbench.getActiveResourceId()).toContain(existing);
    } finally {
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        document.body.replaceChildren(); vi.unstubAllGlobals();
    }
});
