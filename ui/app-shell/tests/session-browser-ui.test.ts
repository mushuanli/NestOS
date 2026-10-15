import { createTestWorkbench } from './helpers/application';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import { DirectoryMountService, SessionFilesService } from '@itookit/app-core';
import { createSessionAttachmentMounts } from '@itookit/app-core';

it('routes a real vfs-ui tree to chat, Task history and the Session mapped file context', async () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const createURL = vi.fn(() => 'blob:test-preview'), revokeURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = createURL; static revokeObjectURL = revokeURL; });
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const id = await repository.createSession('Session title');
    const intrinsic = createSessionAttachmentMounts(repository);
    const files = new SessionFilesService(root, id => intrinsic.forSession(id)); await files.initialize();
    const home = await manager.openFileSystem('/home/admin'); files.registerSource('home', home); files.registerSource('admin-home', home);
    await home.driver.createFile({ parentPath: '/project', recursive: true, name: 'note.md', content: 'mapped text' });
    await home.driver.createFile({ parentPath: '/project', recursive: true, name: 'document.pdf', content: '%PDF-1.4 pure ASCII binary document' });
    await files.configure(id, { mounts: [{ mountId: 'home', sourceId: 'home', at: '/workspace', root: '/project', access: 'rw' }], cwd: '/workspace' }, 0);
    const task = { id: 'task-one', sessionId: id, program: { kind: 'test' }, status: 'succeeded', version: 1, createdAt: 1, updatedAt: 2,
        output: 'task output', effects: {} as Record<string, unknown> };
    const kernel = { onChanged: () => () => {}, async *listSessions() { yield { id }; }, listSessionTasks: async () => [task],
        listSessionTaskPage: vi.fn(async (_session: string, query?: { afterIndex: number; throughIndex: number }) => query
            ? { items: [{ ...task, id: 'task-two' }], throughIndex: 2, nextAfterIndex: undefined }
            : { items: [task], throughIndex: 2, nextAfterIndex: 1 }),
        task: async () => task, taskHistory: async () => [task], taskHistoryPage: vi.fn(async (_session: string, _task: string, query?: { afterVersion: number; throughVersion: number }) => query
            ? { items: [{ ...task, version: 2, output: 'later version' }], throughVersion: 2, nextAfterVersion: undefined }
            : { items: [task], throughVersion: 2, nextAfterVersion: 1 }),
        taskEventPage: vi.fn(async (_session: string, _task: string, query?: { afterIndex: number; throughIndex: number }) => query
            ? { items: [{ taskId: task.id, sequence: 5, occurredAt: 3, type: 'effect.failed', payload: { message: 'provider failed' } }], throughIndex: 2, nextAfterIndex: undefined }
            : { items: [{ taskId: task.id, sequence: 2, occurredAt: 2, type: 'agent.event', payload: { type: 'stream:content', delta: 'hidden delta' } }], throughIndex: 2, nextAfterIndex: 1, firstAvailableIndex: 7 }),
        eventList: vi.fn(async () => []) };
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const chat = vi.fn(async () => ({ destroy: vi.fn() }));
    const file = vi.fn(async () => ({ destroy: vi.fn() }));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const sessionSkills = { mountByGlob: vi.fn(async () => {}), unmountByGlob: vi.fn(async () => {}), list: vi.fn(), load: vi.fn(), listLoaded: vi.fn(), unload: vi.fn() };
    const restored = { activeId: '/' + id, expandedFolderIds: ['/' + id, `/${id}/files`, `/${id}/files/workspace`], selectedItemIds: [] };
    const workbench = createTestWorkbench({  sidebar: sidebar, container: main, repository: repository, files: files, factory: chat as any, onSelect: () => {}, hostContext: undefined, kernel: kernel as any, fileFactory: file as any, directoryMounts: mounts, sessionSkills: sessionSkills as any, uiPersistence: { load: () => restored } });
    const listMountedFiles = vi.spyOn(home.driver, 'getChildren');
    try {
        await workbench.start();
        expect(chat).not.toHaveBeenCalled();
        await workbench.openResource('/' + id);
        expect(chat).toHaveBeenCalledOnce();
        expect(listMountedFiles).not.toHaveBeenCalled();
        expect(kernel.listSessionTaskPage).not.toHaveBeenCalled();
        expect(sidebar.querySelector(`[data-item-id="/${id}/files"]`)).toBeNull();
        await workbench.openResource(`/${id}/tasks`);
        expect(main.textContent).toContain('task-one');
        const moreTasks = [...main.querySelectorAll('button')].find(button => button.textContent === '加载更多任务')!;
        moreTasks.click(); moreTasks.click();
        await vi.waitFor(() => expect(main.textContent).toContain('task-two'));
        expect(kernel.listSessionTaskPage).toHaveBeenLastCalledWith(id, { afterIndex: 1, throughIndex: 2 });
        expect(moreTasks.hidden).toBe(true);
        await workbench.openResource(`/${id}/tasks/@more`);
        expect(main.textContent).toContain('task-one');
        await workbench.openResource(`/${id}/tasks/task-one`);
        expect(main.textContent).toContain('task output');
        expect(kernel.taskHistoryPage).not.toHaveBeenCalled();
        expect(main.textContent).not.toContain('agent.event');
        expect(main.textContent).not.toContain('hidden delta');
        expect(main.textContent?.match(/task output/g)).toHaveLength(1);
        // Retention watermark from the first page stays visible after paging forward.
        const trimmed = main.querySelector<HTMLElement>('[data-events-trimmed]')!;
        expect(trimmed.hidden).toBe(false);
        expect(trimmed.dataset.eventsTrimmedFrom).toBe('7');
        const moreEvents = [...main.querySelectorAll('button')].find(button => button.textContent === '继续查找关键事件')!;
        moreEvents.click(); moreEvents.click();
        await vi.waitFor(() => expect(main.textContent).toContain('provider failed'));
        expect(kernel.taskEventPage).toHaveBeenLastCalledWith(id, 'task-one', { afterIndex: 1, throughIndex: 2 });
        expect(kernel.taskEventPage).toHaveBeenCalledTimes(2);
        expect(kernel.eventList).not.toHaveBeenCalled();
        expect(moreEvents.hidden).toBe(true);
        expect(trimmed.hidden).toBe(false);
        // Invariant: "cancel requested" and "external stop confirmed" must be distinguishable.
        const stop = main.querySelector<HTMLElement>('[data-stop-state]')!;
        expect(stop.dataset.stopState).toBe('none');
        expect(stop.hidden).toBe(true);
        task.status = 'cancelled';
        task.effects = { e: { id: 'e', status: 'cancelled', cleanupPending: true } };
        await workbench.openResource(`/${id}/tasks`);
        await workbench.openResource(`/${id}/tasks/task-one`);
        await vi.waitFor(() => expect(main.querySelector<HTMLElement>('[data-stop-state]')!.dataset.stopState).toBe('pending'));
        const pending = main.querySelector<HTMLElement>('[data-stop-state]')!;
        expect(pending.hidden).toBe(false);
        expect(pending.textContent).toContain('1');
        task.effects = { e: { id: 'e', status: 'cancelled', cleanupPending: false } };
        await workbench.openResource(`/${id}/tasks`);
        await workbench.openResource(`/${id}/tasks/task-one`);
        await vi.waitFor(() => expect(main.querySelector<HTMLElement>('[data-stop-state]')!.dataset.stopState).toBe('stopped'));
        expect(main.querySelector<HTMLElement>('[data-stop-state]')!.textContent).not.toBe(pending.textContent);
        // Pause is projected the same way, so a task held by a Flow or another host is not
        // silently rendered as having no state at all.
        task.status = 'running';
        task.control = { mode: 'pause', acknowledged: false, epoch: 1, requestId: 'p1' } as never;
        task.effects = { e: { id: 'e', status: 'leased' } };
        await workbench.openResource(`/${id}/tasks`);
        await workbench.openResource(`/${id}/tasks/task-one`);
        await vi.waitFor(() => expect(main.querySelector<HTMLElement>('[data-stop-state]')!.dataset.stopState).toBe('pause-pending'));
        const pausePending = main.querySelector<HTMLElement>('[data-stop-state]')!;
        expect(pausePending.hidden).toBe(false);
        expect(pausePending.textContent).toContain('1');
        task.control = { mode: 'pause', acknowledged: true, epoch: 2, requestId: 'p1' } as never;
        await workbench.openResource(`/${id}/tasks`);
        await workbench.openResource(`/${id}/tasks/task-one`);
        await vi.waitFor(() => expect(main.querySelector<HTMLElement>('[data-stop-state]')!.dataset.stopState).toBe('paused'));
        expect(main.querySelector<HTMLElement>('[data-stop-state]')!.textContent).not.toBe(pausePending.textContent);
        task.control = { mode: 'run', acknowledged: true, epoch: 3 } as never;
        await workbench.openResource(`/${id}/tasks`);
        await workbench.openResource(`/${id}/tasks/task-one`);
        await vi.waitFor(() => expect(main.querySelector<HTMLElement>('[data-stop-state]')!.dataset.stopState).toBe('none'));
        expect(main.querySelector<HTMLElement>('[data-stop-state]')!.hidden).toBe(true);
        await workbench.openResource(`/${id}/files/workspace/note.md`);
        const options = (file.mock.calls as unknown as Array<[HTMLElement, any]>)[0][1];
        expect(options.target).toEqual({ kind: 'file', path: '/workspace/note.md' });
        expect(options.files.cwd).toBe('/workspace'); expect(options.initialContent).toBe('mapped text');
        // L4 wiring: opening a file mounts matching Skill globs for this Session only.
        expect(sessionSkills.mountByGlob).toHaveBeenCalledWith(id, '/workspace/note.md');
        expect(sessionSkills.unmountByGlob).not.toHaveBeenCalled();
        await options.hostContext.saveContent('/wrong', 'saved through mapping');
        expect(await home.driver.readContent('/project/note.md', { encoding: 'utf-8' })).toBe('saved through mapping');
        // A failed write must be visible instead of looking like a successful save.
        const driver = options.files.fs.driver;
        const writeContent = driver.writeContent.bind(driver);
        driver.writeContent = async () => { throw new Error('EROFS: mount is read-only'); };
        await expect(options.hostContext.saveContent('/wrong', 'lost')).rejects.toThrow('EROFS');
        driver.writeContent = writeContent;
        expect([...main.querySelectorAll<HTMLElement>('[role="alert"]')].map(node => node.textContent))
            .toContain('EROFS: mount is read-only');
        await workbench.openResource(id); expect(chat).toHaveBeenCalledTimes(1);
        // Leaving the file editor releases the glob mount.
        expect(sessionSkills.unmountByGlob).toHaveBeenCalledWith(id, '/workspace/note.md');
        await Promise.all([workbench.openResource(`/${id}/tasks`), workbench.openResource(`/${id}/tasks/task-one`)]);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(workbench.getActiveResourceId()).toBe(`/${id}/tasks/task-one`);
        expect(chat).toHaveBeenCalledTimes(1);
        await workbench.openResource(`/${id}/files/workspace/document.pdf`);
        expect(file).toHaveBeenCalledOnce();
        expect(main.querySelector<HTMLAnchorElement>('a[download]')?.download).toBe('document.pdf');
        expect(createURL).toHaveBeenCalledOnce();
        await workbench.openResource(id); expect(revokeURL).not.toHaveBeenCalled();
        main.querySelector<HTMLButtonElement>(`[data-tab-id="/${id}/files/workspace/document.pdf"] .workbench-tabs__close`)!.click();
        await vi.waitFor(() => expect(revokeURL).toHaveBeenCalledWith('blob:test-preview'));
        await root.driver.createDirectory({ parentPath: '/home/admin', name: 'extra' });
        await repository.updateManifest(id, { currentBranch: 'experiment' });
        const chatOptions = (chat.mock.calls as unknown as Array<[HTMLElement, any]>).at(-1)![1];
        await chatOptions.hostContext.directoryCommands.addDirectory('~/extra', 'ro');
        const rebound = (chat.mock.calls as unknown as Array<[HTMLElement, any]>).at(-1)![1];
        expect(rebound.target.branch).toBe('experiment');
        expect((await rebound.files.fs.driver.getChildren('/')).map((n: any) => n.name)).toContain('extra');
        await expect(chatOptions.files.fs.driver.getChildren('/')).rejects.toMatchObject({ code: 'EACCES' });
        await rebound.hostContext.directoryCommands.setHome('~/extra');
        expect(mounts.getHome()).toBe('/home/admin/extra');
    } finally {
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await intrinsic.dispose(); await repository.dispose(); await manager.dispose();
        document.body.replaceChildren(); vi.unstubAllGlobals();
    }
});
