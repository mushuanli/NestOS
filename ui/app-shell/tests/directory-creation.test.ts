// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, ProjectService, SessionFilesService } from '@itookit/app-core';
import { folderBrowserPath, projectConversationsPath } from '@itookit/app-contracts';
import { createTestWorkbench } from './helpers/application';

it('creates files and conversations with styled icon buttons on fixed directory and empty conversation pages', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const project = await projects.create('Empty'), path = folderBrowserPath(project.path);
    const sidebar = document.createElement('aside'), main = document.createElement('main'), style = document.createElement('style');
    style.textContent = readFileSync('src/styles/workspace.css', 'utf8'); document.head.append(style); document.body.append(sidebar, main);
    const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'), close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value() {this.open = true;}});
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value() {this.open = false;}});
    const factory = vi.fn(async () => ({destroy() {}, commands: {}}) as never);
    const workbench = createTestWorkbench({sidebar, container: main, repository, files, projects, directoryMounts: mounts,
        kernel: {onChanged: () => () => {}, async *listSessions() {}} as never, factory, onSelect() {}});
    const panel = () => main.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')!;
    try {
        await workbench.start(); await workbench.openResource(path + '/@files');
        expect(getComputedStyle(panel().querySelector<HTMLElement>('.workbench-directory__heading')!).display).toBe('none');
        expect(panel().textContent).not.toContain('搜索目录及子目录');
        expect(panel().querySelector('[data-action="directory-menu"]')).not.toBeNull();
        for (const [action, name] of [['create-file', 'created.md'], ['create-folder', 'child']] as const) {
            const button = panel().querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
            expect(button.disabled).toBe(false); expect(button.getAttribute('aria-label')).toBeTruthy(); expect(button.children).toHaveLength(1);
            expect(button.querySelector('svg')).not.toBeNull(); expect(getComputedStyle(button).display).toBe('inline-flex');
            button.click(); await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
            document.querySelector<HTMLInputElement>('dialog input')!.value = name;
            document.querySelector('dialog form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
            await vi.waitFor(() => expect(document.querySelector('dialog')).toBeNull());
            expect(panel().querySelector(`[data-resource-id="${path}/@files/${name}"]`)).not.toBeNull();
        }
        const more = panel().querySelector<HTMLButtonElement>('.workbench-directory__row-action')!;
        expect(getComputedStyle(more).opacity).toBe('1');
        await workbench.openResource(projectConversationsPath(project.path));
        const create = panel().querySelector<HTMLButtonElement>('[data-action="create-session"]')!;
        expect(create.disabled).toBe(false); expect(create.children).toHaveLength(1); create.click();
        await vi.waitFor(() => expect(workbench.getActiveResourceId()).toBe('draft:' + project.project.id));
        expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({sessionDraft: expect.any(Object)});
        expect(await repository.listSummariesInFolder(await projects.sessionFolder(project))).toEqual([]);
    } finally {
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        sidebar.remove(); main.remove(); style.remove(); document.querySelectorAll('dialog').forEach(dialog => dialog.remove());
        if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
        if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    }
});
