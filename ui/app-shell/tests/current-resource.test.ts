// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {Workbench} from '../src/core/Workbench';
import {createTestWorkbench} from './helpers/application';
import {SessionRepository} from '@itookit/llm-session';
import {DirectoryMountService, ProjectService, SessionFilesService} from '@itookit/app-core';
import {bindApplicationBackend} from '@itookit/app-core/host';
import type {LocalApplicationServices} from '@itookit/app-contracts/services';
import {observeNavigationVisibility} from '../src/navigation/navigation-visibility';

const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => {for (const release of releases.splice(0).reverse()) await release(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

it('opens a file without listing its directory and retains its editor when navigation is loaded later', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); releases.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'); await fs.driver.createFile({name: 'note.txt', parentPath: '/', content: 'Saved'});
    let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;}); releases.push(() => finish());
    const listing = vi.spyOn(fs.driver, 'getChildren').mockImplementation(async () => {await gate; return [];});
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const field = document.createElement('textarea'); field.value = 'Unsaved document';
    const factory = vi.fn(async (mount: HTMLElement) => {mount.append(field); return {destroy: vi.fn()};});
    const workbench = new Workbench({files: {fs, cwd: '/'}, sidebarContainer: sidebar, editorContainer: main, editorFactory: factory as never, deferNavigation: true});
    await workbench.start(); await workbench.openFile('/note.txt');
    expect(listing).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledOnce(); expect(workbench.getActiveFilePath()).toBe('/note.txt');
    const navigation = workbench.setNavigationVisible(true); await vi.waitFor(() => expect(listing).toHaveBeenCalled());
    expect(field.value).toBe('Unsaved document'); finish(); await navigation;
    expect(main.contains(field)).toBe(true); expect(field.value).toBe('Unsaved document'); expect(factory).toHaveBeenCalledOnce(); await workbench.destroy();
});

it('prepares only current chat capabilities while project navigation is unavailable', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); releases.push(() => manager.dispose());
    const root = await manager.openFileSystem('/'), repository = new SessionRepository(root); await repository.init(); releases.push(() => repository.dispose());
    const files = new SessionFilesService(root); await files.initialize(); releases.push(() => files.dispose());
    const mounts = new DirectoryMountService(root, files); await mounts.init(); releases.push(() => mounts.dispose());
    const projects = new ProjectService(root, repository, mounts, files); const project = await projects.create('Current');
    const id = await repository.createSession('Only this conversation', project.path);
    const navigation = vi.spyOn(projects.sessions, 'navigation').mockRejectedValue(new Error('Navigation unavailable'));
    const kernel = {onChanged: () => () => {}, async *listSessions() {}};
    const backend = bindApplicationBackend({sessionRepository: repository, sessionFiles: files, projects, kernel: {kernel}} as unknown as LocalApplicationServices);
    const view = await backend.workbenchView({initialNavigation: false}); releases.push(() => view.browser.dispose());
    expect(view.navigation).toBeUndefined(); expect(navigation).not.toHaveBeenCalled();
    const sidebar = document.createElement('div'), container = document.createElement('div'); document.body.append(sidebar, container);
    const factory = vi.fn(async (mount: HTMLElement) => {mount.textContent = 'Current conversation ready'; return {destroy: vi.fn()};});
    const workbench = createTestWorkbench({sidebar, container, repository, files, projects, kernel: kernel as never, factory: factory as never, fileFactory: factory as never, onSelect() {}, hostContext: undefined, deferNavigation: true});
    releases.push(() => workbench.destroy()); await workbench.start(); await workbench.openResource(id);
    expect(container.textContent).toContain('Current conversation ready'); expect(navigation).not.toHaveBeenCalled();
    await expect(workbench.setNavigationVisible(true)).rejects.toThrow('Navigation unavailable');
    expect(container.textContent).toContain('Current conversation ready'); expect(factory).toHaveBeenCalledOnce();
});

it('reports navigation visibility only for visible surfaces and releases observers', async () => {
    let narrow = true; const media = {get matches() {return narrow;}, addEventListener: vi.fn(), removeEventListener: vi.fn()};
    vi.stubGlobal('matchMedia', () => media);
    document.body.innerHTML = '<section class="workspace-view active"><div class="mm-layout" data-mobile-view="detail"><aside class="mm-sidebar"></aside></div></section>';
    const layout = document.querySelector<HTMLElement>('.mm-layout')!, sidebar = document.querySelector<HTMLElement>('.mm-sidebar')!, changed = vi.fn();
    const close = observeNavigationVisibility(layout, sidebar, changed); expect(changed).toHaveBeenLastCalledWith(false);
    layout.dataset.mobileView = 'list'; await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
    const resourcePane = document.createElement('section'); resourcePane.className = 'workbench-sidebar__section';
    resourcePane.dataset.section = 'navigation'; sidebar.append(resourcePane); resourcePane.hidden = true;
    await Promise.resolve(); expect(changed).toHaveBeenLastCalledWith(true);
    sidebar.classList.add('is-collapsed'); await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(false));
    sidebar.classList.remove('is-collapsed'); narrow = false; layout.dataset.mobileView = 'detail';
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
    document.querySelector('.workspace-view')!.classList.remove('active'); await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(false));
    close(); expect(media.removeEventListener).toHaveBeenCalled();
});

it('shows another browser\'s persisted Sessions on a cold project listing and after manual refresh', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); releases.push(() => manager.dispose());
    const root = await manager.openFileSystem('/'), repository = new SessionRepository(root); await repository.init(); releases.push(() => repository.dispose());
    const files = new SessionFilesService(root); await files.initialize(); releases.push(() => files.dispose());
    const mounts = new DirectoryMountService(root, files); await mounts.init(); releases.push(() => mounts.dispose());
    const projects = new ProjectService(root, repository, mounts, files), project = await projects.create('Personal');
    const folder = await projects.sessionFolder(project);
    const writer = new SessionRepository(root); await writer.init(); releases.push(() => writer.dispose());
    await writer.createSession('Created on phone', folder);
    const sidebar = document.createElement('div'), container = document.createElement('div'); document.body.append(sidebar, container);
    const kernel = {onChanged: () => () => {}, async *listSessions() {}};
    const factory = vi.fn(async () => ({destroy: vi.fn()}));
    const workbench = createTestWorkbench({sidebar, container, repository, files, projects, kernel: kernel as never,
        factory: factory as never, fileFactory: factory as never, onSelect() {}, hostContext: undefined});
    releases.push(() => workbench.destroy()); await workbench.start();
    const path = '/folder:Personal'; await workbench.openResource(path);
    await vi.waitFor(() => expect(sidebar.querySelector('.workbench-sidebar__navigation')?.textContent).toContain('Created on phone'));
    await writer.createSession('Created on second browser', folder);
    sidebar.querySelector<HTMLButtonElement>('.workbench-project-navigation [data-action="refresh"]')!.click();
    await vi.waitFor(() => expect(sidebar.querySelector('.workbench-sidebar__navigation')?.textContent).toContain('Created on second browser'));
});
