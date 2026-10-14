import { createLocalBackendPort } from '@itookit/app-core/host';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, SessionFilesService, ProjectService, folderBrowserPath } from '@itookit/app-core';
import { directoryPathLabel } from '../src/projects/directory-label';
import { SessionWorkbench } from '../src/projects/SessionWorkbench';

/**
 * The project Files view shows the built-in create controls. Activating a row drops the
 * single-item selection, so the destination used to fall back to the Files root instead of
 * the folder the user had just opened.
 */
it('creates a project file beside the activated file, not at the Files root', async () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const project = await projects.create('原项目文档');
    const projectPath = folderBrowserPath(project.path);
    const seed = await projects.openFiles(project.path);
    await seed.fs.driver.createDirectory({ parentPath: '/', name: 'sub', recursive: true });
    await seed.fs.driver.createFile({ parentPath: '/sub', name: 'deep.md', content: 'deep' });
    await seed.dispose();

    const kernel = { onChanged: () => () => {}, async *listSessions() {} };
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async (element: HTMLElement) => { element.textContent = 'editor'; return { destroy: vi.fn() }; });
    const workbench = new SessionWorkbench({ backend: createLocalBackendPort(),  sidebar, container: main, repository, files, factory: factory as never,
        onSelect: () => {}, hostContext: undefined, kernel: kernel as never, fileFactory: factory as never, directoryMounts: mounts, projects });
    try {
        await workbench.start();
        await workbench.openResource(projectPath + '/@files');
        await workbench.openResource(projectPath + '/@files/sub');
        const panel = main.querySelector('.workbench-tabs__panel:not([hidden])')!;
        expect(panel.textContent).toContain('deep.md');
        expect(panel.querySelector('h2')?.textContent).toBe('sub');
        expect(panel.querySelector('.workbench-directory__path')?.textContent).toBe('原项目文档 / 文件 / sub');
        expect([...panel.querySelectorAll<HTMLButtonElement>('.workbench-directory__toolbar button')].map(button => button.title)).toEqual(['上一级', '刷新列表', '新建文件', '新建目录']);
        expect(panel.querySelector('.workbench-directory__heading button')).toBeNull();
        const previousShow = HTMLDialogElement.prototype.showModal, previousClose = HTMLDialogElement.prototype.close;
        HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
        panel.querySelector<HTMLButtonElement>('.workbench-directory__toolbar [aria-label="新建文件"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('.project-dialog input')).not.toBeNull());
        const input = document.querySelector<HTMLInputElement>('.project-dialog input')!; input.value = 'made.md';
        document.querySelector<HTMLFormElement>('.project-dialog form')!.dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() => expect(document.querySelector('.project-dialog')).toBeNull());
        HTMLDialogElement.prototype.showModal = previousShow; HTMLDialogElement.prototype.close = previousClose;

        const check = await projects.openFiles(project.path);
        try {
            await vi.waitFor(async () => expect(await check.fs.driver.exists('/sub/made.md')).toBe(true));
            expect(await check.fs.driver.exists('/made.md')).toBe(false);
        } finally { await check.dispose(); }
        const readonlyOwner = await projects.openFiles(project.path);
        await readonlyOwner.fs.driver.createDirectory({ parentPath: '/', name: 'readonly' });
        await readonlyOwner.fs.driver.updateMetadata('/readonly', { _readOnly: true }); await readonlyOwner.dispose();
        await workbench.openResource(projectPath + '/@files/readonly');
        const readonlyPanel = main.querySelector('.workbench-tabs__panel:not([hidden])')!;
        expect(readonlyPanel.querySelector('[aria-label="新建文件"]')).toBeNull();
        expect(readonlyPanel.querySelector('[aria-label="新建目录"]')).toBeNull();
        expect(readonlyPanel.querySelector('[aria-label="刷新列表"]')).not.toBeNull();
        await workbench.openResource('/');
        const allProjects = main.querySelector('.workbench-tabs__panel:not([hidden])')!;
        expect(allProjects.querySelector('h2')?.textContent).toBe('所有项目');
        expect(allProjects.querySelector('.workbench-directory__path')?.textContent).toBe('所有项目');
        expect(allProjects.querySelector('.workbench-directory__table')?.textContent).toContain('原项目文档');
        expect(allProjects.querySelector('.workbench-directory__table')?.textContent).not.toContain('folder:');
    } finally { await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose(); }
});

it('presents an encoded project route as names while retaining the actual directory identifier', () => {
    const id = '7ebbd424-717f-4f68-9e9c-b465a78586cc';
    expect(directoryPathLabel('/folder:%E5%8E%9F%E9%A1%B9%E7%9B%AE%E6%96%87%E6%A1%A3/@files/' + id)).toBe('原项目文档 / 文件 / ' + id);
    expect(directoryPathLabel('/folder:%E4%B8%AA%E4%BA%BA%E9%A1%B9%E7%9B%AE')).toBe('个人项目');
});
