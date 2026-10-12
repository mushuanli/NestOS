// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchTabs } from '../src/workbench/tabs';
import { WorkbenchSidebar } from '../src/workbench/sidebar';
import { createDirectoryList, refreshDirectoryList, refreshDirectorySelection } from '../src/workbench/directory-list';
import { readWorkbenchSnapshot, type WorkbenchSnapshot } from '../src/workbench/state';
import { connectEditorLifecycle } from '../src/browser/editor-connector';
import { LatestViewLoad } from '../src/lifecycle/view-load';
import { Workbench } from '../src/core/Workbench';
import { FILE_ICONS } from '@itookit/common';
import { createVFS, MemoryBackend, FSError } from '@itookit/vfs-core';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('clears a removed directory view, disables creation and recovers without hiding IO failures', async () => {
    const refresh = vi.fn(async () => [{ id: '/docs/a.md', name: 'a.md', type: 'file' }]);
    const list = createDirectoryList({ title: 'Docs', path: '/docs', entries: await refresh(), open() {}, refresh,
        actions: [{ label: 'Create', run() {} }] });
    refresh.mockRejectedValueOnce(new FSError('EIO', 'wrapped', undefined, undefined, new FSError('ENOENT', 'gone')));
    await refreshDirectoryList(list);
    expect(list.querySelector('[data-resource-id]')).toBeNull();
    expect(list.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(false);
    expect(list.querySelector<HTMLButtonElement>('[data-directory-action]')!.disabled).toBe(true);
    await refreshDirectoryList(list);
    expect(list.querySelector('[data-resource-id="/docs/a.md"]')).not.toBeNull();
    expect(list.querySelector<HTMLButtonElement>('[data-directory-action]')!.disabled).toBe(false);
    refresh.mockRejectedValueOnce(new FSError('EIO', 'offline'));
    await expect(refreshDirectoryList(list)).rejects.toMatchObject({ code: 'EIO' });
});

it('shares selection with its owner across select-all, sidebar changes and list recreation', () => {
    let ids: readonly string[] = ['/docs/a.md'];
    const options = { title: 'Docs', path: '/docs', entries: [
        { id: '/docs/a.md', name: 'a.md', type: 'file' }, { id: '/docs/b.md', name: 'b.md', type: 'file' },
    ], open() {}, select: (next: string[]) => { ids = next; }, selectedIds: () => ids };
    const list = createDirectoryList(options);
    document.body.append(list);
    const checked = () => [...list.querySelectorAll<HTMLInputElement>('[data-selection-id]')].filter(c => c.checked).map(c => c.dataset.selectionId);
    expect(checked()).toEqual(['/docs/a.md']);
    list.querySelector<HTMLInputElement>('thead input')!.click();
    expect(ids).toEqual(['/docs/a.md', '/docs/b.md']); expect(checked()).toEqual(ids);
    ids = ['/docs/b.md', '/other/file']; refreshDirectorySelection(list);
    expect(checked()).toEqual(['/docs/b.md']); expect(ids).toContain('/other/file');
    const restored = createDirectoryList(options);
    expect(restored.querySelector<HTMLInputElement>('[data-selection-id="/docs/b.md"]')!.checked).toBe(true);
});

function tabsFixture() {
    const container = document.createElement('div'); document.body.append(container);
    const dispose = vi.fn(async () => {}), empty = vi.fn(), error = vi.fn();
    const tabs = new WorkbenchTabs(container, { activate: async id => { tabs.activate(id); }, dispose, empty, error });
    return { tabs, container, dispose, empty, error };
}
it('promotes an edited preview, preserves its DOM and does not demote it after saving', async () => {
    const f = tabsFixture(), events = new Map<string, () => void>();
    const a = await f.tabs.open('/a.md', 'a.md'); a.panel.textContent = 'cursor and undo owner';
    f.tabs.bind(a, { on: (name: string, callback: () => void) => { events.set(name, callback); return () => {}; } } as never);
    events.get('interactiveChange')!(); expect(a.preview).toBe(false); expect(a.dirty).toBe(true);
    await f.tabs.open('/b.md', 'b.md'); expect(a.panel.isConnected).toBe(true); expect(a.panel.hidden).toBe(true);
    events.get('saved')!(); expect(a.preview).toBe(false); expect(a.dirty).toBe(false);
    await f.tabs.open('/a.md', 'a.md'); expect(f.tabs.current).toBe(a); expect(a.panel.textContent).toBe('cursor and undo owner');
    await f.tabs.destroy();
});
it('replaces only the preview and protects pinned tabs during close-saved', async () => {
    const f = tabsFixture(); await f.tabs.open('/a', 'a'); await f.tabs.open('/b', 'b');
    expect(f.tabs.get('/a')).toBeUndefined(); f.tabs.pin('/b');
    await f.tabs.open('/c', 'c');
    [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('关闭已保存'))!.click();
    await vi.waitFor(() => expect(f.tabs.get('/c')).toBeUndefined()); expect(f.tabs.get('/b')?.pinned).toBe(true);
    await f.tabs.destroy();
});
it('selects open tabs, keeps pinned files and continues closing when one save fails', async () => {
    const f = tabsFixture(); document.body.append(f.tabs.opened);
    await f.tabs.open('/a', 'a'); f.tabs.keep('/a'); await f.tabs.open('/reference', 'reference'); f.tabs.pin('/reference');
    await f.tabs.open('/c', 'c'); f.tabs.keep('/c'); f.dispose.mockRejectedValueOnce(new Error('save failed'));
    f.tabs.opened.querySelector<HTMLInputElement>('.workbench-tabs__opened-toolbar input')!.click();
    f.tabs.opened.querySelector<HTMLButtonElement>('[data-action="close-selected-tabs"]')!.click();
    await vi.waitFor(() => expect(f.tabs.get('/c')).toBeUndefined());
    expect(f.tabs.get('/a')?.failed).toBe(true); expect(f.tabs.get('/reference')?.pinned).toBe(true);
    expect(f.tabs.opened.querySelector('[data-opened-id="/reference"] [aria-pressed="true"] svg')).not.toBeNull();
    await f.tabs.destroy();
});
it('retains failed saves, shares concurrent close requests and lets the user retry', async () => {
    const f = tabsFixture(), tab = await f.tabs.open('/draft', 'draft');
    f.dispose.mockRejectedValueOnce(new Error('disk full'));
    const first = f.tabs.close('/draft'); expect(f.tabs.close('/draft')).toBe(first);
    await expect(first).rejects.toThrow('disk full'); expect(f.tabs.current).toBe(tab); expect(tab.panel.isConnected).toBe(true);
    expect(tab.preview).toBe(false); expect(tab.failed).toBe(true);
    await f.tabs.close('/draft'); expect(f.tabs.get('/draft')).toBeUndefined(); await f.tabs.destroy();
});
it('remaps an inactive renamed file and preserves pinned metadata during shutdown', async () => {
    const f = tabsFixture(); await f.tabs.open('/old.md', 'old.md'); f.tabs.pin('/old.md');
    await f.tabs.open('/other.md', 'other.md'); f.tabs.rename('/old.md', '/new.md', 'new.md');
    expect(f.tabs.get('/new.md')?.pinned).toBe(true); expect(f.tabs.get('/old.md')).toBeUndefined();
    expect(f.tabs.snapshot()).toEqual([{ id: '/new.md', title: 'new.md', pinned: true }]); await f.tabs.destroy();
});
it('resizes sidebar width with the keyboard and restores independent collapsed sections', () => {
    let state: WorkbenchSnapshot = { version: 1, width: 320, navigationHeight: 60 };
    const host = document.createElement('div'); document.body.append(host);
    const port = { load: () => state, save: (value: WorkbenchSnapshot) => { state = value; } };
    const sidebar = new WorkbenchSidebar(host, document.createElement('div'), port);
    host.querySelector('[aria-orientation="vertical"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(state.width).toBe(336);
    host.querySelector<HTMLButtonElement>('[data-section="opened"] button')!.click(); expect(state.openedCollapsed).toBe(true);
    sidebar.destroy(); const restored = new WorkbenchSidebar(host, document.createElement('div'), port);
    expect(host.querySelector('[data-section="opened"]')?.classList.contains('is-collapsed')).toBe(true);
    expect(host.style.getPropertyValue('--workbench-sidebar-width')).toBe('336px'); restored.destroy();
});
it('filters full filenames and preserves its query across a metadata refresh', async () => {
    const open = vi.fn();
    const list = createDirectoryList({ title: 'Docs', path: '/docs', entries: [
        { id: '/docs/long.md', name: '完整文件名称很长但必须可读.md', type: 'file', created: 1, modified: 2 },
        { id: '/docs/other.md', name: 'other.md', type: 'file' },
    ], open, refresh: async () => [{ id: '/docs/long.md', name: '完整文件名称很长但必须可读.md', type: 'file', modified: 3 }] });
    const input = list.querySelector<HTMLInputElement>('input[type="search"]')!; input.value = '完整'; input.dispatchEvent(new Event('input'));
    expect(list.querySelectorAll('tbody tr')).toHaveLength(1);
    await refreshDirectoryList(list); expect(input.value).toBe('完整');
    list.querySelector<HTMLButtonElement>('.workbench-directory__name')!.click(); expect(open).toHaveBeenCalledWith('/docs/long.md');
});
it('selects filtered directory rows, preserves checks across sorting and gates bulk mutations', async () => {
    const select = vi.fn(), move = vi.fn(async () => {}), remove = vi.fn(async () => {});
    const list = createDirectoryList({ title: 'Docs', path: '/docs', entries: [
        { id: '/docs/a.md', name: 'a.md', type: 'file' }, { id: '/docs/b.md', name: 'b.md', type: 'file' },
    ], open() {}, select, bulkActions: [{ id: 'move', label: '移动', allows: () => true, run: move },
        { id: 'delete', label: '删除', allows: () => false, run: remove }] }); document.body.append(list);
    const search = list.querySelector<HTMLInputElement>('input[type="search"]')!; search.value = 'a.md'; search.dispatchEvent(new Event('input'));
    list.querySelector<HTMLInputElement>('thead input')!.click();
    expect(select).toHaveBeenLastCalledWith(['/docs/a.md']);
    search.value = ''; search.dispatchEvent(new Event('input'));
    list.querySelector<HTMLButtonElement>('th[data-column="name"] button')!.click();
    expect(list.querySelector<HTMLInputElement>('[data-selection-id="/docs/a.md"]')?.checked).toBe(true);
    expect(list.querySelector<HTMLInputElement>('thead input')?.indeterminate).toBe(true);
    expect(list.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')?.disabled).toBe(true);
    list.querySelector<HTMLButtonElement>('[data-action="bulk-move"]')!.click();
    await vi.waitFor(() => expect(move).toHaveBeenCalledWith(['/docs/a.md'])); expect(remove).not.toHaveBeenCalled();
    expect(list.querySelector('[data-resource-id="/docs/a.md"] [data-file-icon="document"]')).not.toBeNull();
});
it('keeps completed editor signals alive across new reads and cancels unfinished reads', () => {
    const loads = new LatestViewLoad(), first = loads.begin(), cancel = loads.detach(first), second = loads.begin();
    expect(first.signal.aborted).toBe(false); loads.begin(); expect(second.signal.aborted).toBe(true); cancel(); expect(first.signal.aborted).toBe(true);
});
it('validates restored layout and rejects unknown versions without breaking startup', () => {
    expect(readWorkbenchSnapshot({ version: 2 })).toBeUndefined();
    expect(readWorkbenchSnapshot({ version: 1, width: 9999, tabs: [{ id: 1 }, { id: '/a', title: 'a', pinned: true }] }))
        .toMatchObject({ width: 600, tabs: [{ id: '/a', title: 'a', pinned: true }] });
});
it('switches edited files through the real connector without recreating their editors', async () => {
    const listeners = new Map<string, (payload: any) => void>(), changes = new Map<string, Map<string, () => void>>();
    const ui = { on: (event: string, callback: any) => { listeners.set(event, callback); return () => {}; }, getNode: () => undefined };
    const container = document.createElement('div'); document.body.append(container);
    const factory = vi.fn(async (mount: HTMLElement, options: any) => {
        mount.textContent = options.initialContent; const events = new Map<string, () => void>(); changes.set(options.target.path, events);
        return { on: (name: string, callback: () => void) => { events.set(name, callback); return () => {}; }, flushPendingSave: vi.fn(), destroy: vi.fn() };
    });
    const lifecycle = connectEditorLifecycle(ui as never, { driver: { readContent: async (id: string) => id } } as never, container, factory as never);
    const select = (id: string) => listeners.get('sessionSelected')!({ item: { id, type: 'file', metadata: { title: id, custom: { _extension: '.md' } } } });
    select('/a'); await vi.waitFor(() => expect(changes.has('/a')).toBe(true)); changes.get('/a')!.get('interactiveChange')!();
    select('/b'); await vi.waitFor(() => expect(changes.has('/b')).toBe(true));
    select('/a'); await vi.waitFor(() => expect(container.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toBe('/a'));
    expect(factory).toHaveBeenCalledTimes(2); await lifecycle();
});
it('opens files from the root details, filters ignored files and returns to the retained root tab', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    await fs.driver.createDirectory({ parentPath: '/', name: 'docs' });
    await fs.driver.createFile({ parentPath: '/docs', name: 'linked.md', content: '# Intro\nLinked body' });
    await fs.driver.createFile({ parentPath: '/', name: '.gitignore', content: '*.log' });
    await fs.driver.createFile({ parentPath: '/', name: 'hidden.log', content: 'hidden' });
    await fs.driver.createFile({ parentPath: '/', name: '完整文件名称.md', content: 'body' });
    const sidebar = document.createElement('div'), main = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async (mount: HTMLElement, _options: any) => {
        mount.textContent = 'file body'; return { destroy: vi.fn(), flushPendingSave: vi.fn(), navigateTo: vi.fn(async () => {}), on: () => () => {} };
    });
    const workbench = new Workbench({ files: { fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: main, editorFactory: factory as never, fileTypes: [{ extensions: ['.md'], icon: FILE_ICONS.code }] });
    try {
        await workbench.start();
        await vi.waitFor(() => expect(main.querySelector('[data-resource-id="/完整文件名称.md"]'), main.innerHTML).not.toBeNull());
        const refresh = sidebar.querySelector<HTMLButtonElement>('.workbench-sidebar__navigation [data-action="refresh"]')!;
        expect(refresh).not.toBeNull(); expect(refresh.hidden).toBe(false);
        expect(refresh.closest('[hidden]')).toBeNull(); expect(refresh.disabled).toBe(false);
        expect(refresh.title).toBe('刷新'); expect(refresh.querySelector('svg')).not.toBeNull();
        const read = vi.spyOn(fs.driver, 'getChildren');
        refresh.click();
        await vi.waitFor(() => expect(read).toHaveBeenCalledWith('/'));
        await vi.waitFor(() => expect(refresh.disabled).toBe(false)); read.mockRestore();
        expect(main.querySelector('[data-resource-id="/hidden.log"]')).toBeNull(); expect(sidebar.textContent).toContain('完整文件名称.md');
        const toolbar = main.querySelector('.workbench-directory__toolbar')!;
        expect([...toolbar.querySelectorAll('button')].map(button => button.title)).toEqual(['刷新列表', '新建文件', '新建目录']);
        expect(main.querySelector('.workbench-directory__heading button')).toBeNull();
        expect(main.querySelector('[data-resource-id="/docs"] [data-row-create]')).toBeNull();

        expect(sidebar.querySelector('[data-item-id="/完整文件名称.md"] [data-file-icon="code"]')).not.toBeNull();
        expect(main.querySelector('[data-resource-id="/完整文件名称.md"] .file-type-icon [data-file-icon="code"]')).not.toBeNull();
        main.querySelector<HTMLButtonElement>('[data-resource-id="/完整文件名称.md"] .workbench-directory__name')!.click();
        await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
        expect(sidebar.querySelector('[data-opened-id="/完整文件名称.md"] .file-type-icon [data-file-icon="code"]')).not.toBeNull();
        main.querySelector<HTMLButtonElement>('[data-tab-id="/"] .workbench-tabs__label')!.click();
        await vi.waitFor(() => expect(main.querySelector('.workbench-tabs__panel:not([hidden]) .workbench-directory')).not.toBeNull());
        expect(sidebar.querySelector('[data-item-type="file"] [data-row-create]')).toBeNull();
        expect(sidebar.querySelector('[data-item-type="directory"] [data-row-create="file"] svg')).not.toBeNull();
        expect(await fs.driver.readContent('/hidden.log', { encoding: 'utf-8' })).toBe('hidden');
        await factory.mock.calls[0][1].hostContext.openFile('/docs/linked.md', 'intro');
        expect(factory.mock.calls.at(-1)![1].target.path).toBe('/docs/linked.md');
        expect(factory.mock.calls.at(-1)![1].initialContent).toContain('Linked body');
        expect((await factory.mock.results.at(-1)!.value).navigateTo).toHaveBeenCalledWith({ elementId: 'intro' });
    } finally { await workbench.destroy(); await manager.dispose(); }
});
it('uses deletion confirmation and refreshes root details after a bulk delete', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/', name: 'a.md', content: 'a' });
    await fs.driver.createFile({ parentPath: '/', name: 'b.md', content: 'b' });
    const main = document.createElement('div'), sidebar = document.createElement('div'); document.body.append(sidebar, main);
    const workbench = new Workbench({ files: { fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: main, editorFactory: (async () => ({ destroy() {} })) as never });
    const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    try {
        await workbench.start(); await vi.waitFor(() => expect(main.querySelector('[data-resource-id="/a.md"]')).not.toBeNull());
        main.querySelector<HTMLInputElement>('[data-selection-id="/a.md"]')!.click(); main.querySelector<HTMLInputElement>('[data-selection-id="/b.md"]')!.click();
        main.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')!.click();
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce()); expect(await fs.driver.exists('/a.md')).toBe(true);
        await vi.waitFor(() => expect(main.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')?.disabled).toBe(false));
        confirm.mockReturnValue(true); main.querySelector<HTMLButtonElement>('[data-action="bulk-delete"]')!.click();
        await vi.waitFor(async () => expect(await fs.driver.exists('/a.md')).toBe(false));
        await vi.waitFor(() => expect(main.querySelector('[data-resource-id="/b.md"]')).toBeNull());
    } finally { await workbench.destroy(); await manager.dispose(); vi.unstubAllGlobals(); }
});
it('moves a pinned open file through the shared picker and saves to its new path', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); const fs = await manager.openFileSystem('/');
    await fs.driver.createDirectory({ parentPath: '/', name: 'destination' });
    await fs.driver.createFile({ parentPath: '/', name: 'source.md', content: 'body' });
    const main = document.createElement('div'), sidebar = document.createElement('div'); document.body.append(sidebar, main);
    const factory = vi.fn(async (_mount: HTMLElement, options: any) => ({ destroy() {}, flushPendingSave: async () => {}, on: () => () => {},
        updateNodeId: (path: string) => { options.target.path = path; } }));
    const workbench = new Workbench({ files: { fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: main, editorFactory: factory as never });
    try {
        await workbench.start(); await vi.waitFor(() => expect(main.querySelector('[data-resource-id="/source.md"]')).not.toBeNull());
        main.querySelector<HTMLButtonElement>('[data-resource-id="/source.md"] .workbench-directory__name')!.click();
        await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
        main.querySelector<HTMLButtonElement>('[data-tab-id="/source.md"] .workbench-tabs__pin')!.click();
        main.querySelector<HTMLButtonElement>('[data-tab-id="/"] .workbench-tabs__label')!.click();
        await vi.waitFor(() => expect(main.querySelector('.workbench-tabs__panel:not([hidden]) [data-selection-id="/source.md"]')).not.toBeNull());
        const sourceSelection = main.querySelector<HTMLInputElement>('[data-selection-id="/source.md"]')!;
        if (!sourceSelection.checked) sourceSelection.click();
        main.querySelector<HTMLButtonElement>('[data-action="bulk-move"]')!.click();
        await vi.waitFor(() => expect(document.querySelector('.vfs-move-modal [data-folder-id="/destination"]')).not.toBeNull());
        document.querySelector<HTMLElement>('.vfs-move-modal [data-folder-id="/destination"]')!.click();
        document.querySelector<HTMLButtonElement>('.vfs-move-modal [data-action="confirm-move"]')!.click();
        await vi.waitFor(async () => expect(await fs.driver.exists('/destination/source.md')).toBe(true));
        await vi.waitFor(() => expect(main.querySelector('[data-tab-id="/destination/source.md"]')).not.toBeNull());
        const options = factory.mock.calls[0][1]; await options.hostContext.saveContent(options.target.path, 'after move');
        expect(await fs.driver.readContent('/destination/source.md', { encoding: 'utf-8' })).toBe('after move');
        expect(factory).toHaveBeenCalledOnce();
    } finally { await workbench.destroy(); await manager.dispose(); }
});

it('shows readable file sizes before modified time and keeps unknown directory sizes empty', () => {
    const list = createDirectoryList({ title: 'Docs', path: '/', open() {}, entries: [
        { id: '/folder', name: 'folder', type: 'directory' },
        { id: '/empty.txt', name: 'empty.txt', type: 'file', size: 0 },
        { id: '/note.md', name: 'note.md', type: 'file', size: 1536, created: 1700000000000, modified: 1700000100000, description: '说明' },
        { id: '/image.png', name: 'image.png', type: 'file', size: 2097152 },
    ] });
    expect([...list.querySelectorAll('th')].map(cell => (cell as HTMLElement).dataset.column)).toEqual(['name', 'size', 'modified', 'type']);
    expect(list.querySelector('details')).toBeNull();
    expect(list.querySelector('[data-resource-id="/note.md"]')?.children).toHaveLength(4);
    const tooltip = list.querySelector<HTMLButtonElement>('[data-resource-id="/note.md"] .workbench-directory__name')!.title;
    expect(tooltip).toContain('note.md\n说明'); expect(tooltip).toContain('创建时间:'); expect(tooltip).toContain('修改时间:');
    expect(tooltip).toContain(new Date(1700000000000).toLocaleString('zh-CN'));
    expect(list.querySelector<HTMLButtonElement>('[data-resource-id="/folder"] .workbench-directory__name')!.title).toContain('创建时间: —');
    const size = (id: string) => list.querySelector<HTMLElement>(`[data-resource-id="${id}"] [data-column="size"]`)!;
    expect(size('/empty.txt').textContent).toBe('0 B'); expect(size('/note.md').textContent).toBe('1.5 KiB');
    expect(size('/image.png').textContent).toBe('2 MiB'); expect(size('/folder').textContent).toBe('—');
    expect(size('/note.md').title.replace(/[,\s]/g, '')).toBe('1536B');
});
