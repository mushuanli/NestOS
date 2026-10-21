// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchTabs } from '../src/workbench/tabs';
import { WorkbenchSidebar } from '../src/workbench/sidebar';
import { createDirectoryList, refreshDirectoryList, refreshDirectorySelection } from '../src/workbench/directory-list';
import { readWorkbenchSnapshot, type WorkbenchSnapshot } from '../src/workbench/state';
import { connectEditorLifecycle } from '../src/browser/editor-connector';
import { LatestViewLoad } from '../src/lifecycle/view-load';
import { Workbench } from '../src/core/Workbench';
import { createDirectoryBreadcrumbs } from '../src/workbench/directory-breadcrumbs';
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
it('keeps project context separate from resource names and rename persistence', async () => {
    const f = tabsFixture();
    await f.tabs.open('/note.md', 'note.md', false); f.tabs.context('/note.md', 'Personal');
    f.tabs.rename('/note.md', '/renamed.md', 'renamed.md');
    const header = f.container.querySelector('.workbench-tabs__tab')!;
    expect(header.querySelector('.workbench-tabs__context')?.textContent).toBe('Personal');
    expect(header.querySelector('.workbench-tabs__label')?.getAttribute('aria-label')).toBe('renamed.md');
    expect(f.tabs.snapshot()).toEqual([{id: '/renamed.md', title: 'renamed.md', pinned: false, context: 'Personal'}]);
    expect(f.tabs.get('/renamed.md')?.context).toBe('Personal'); await f.tabs.destroy();
});
it('switches opened documents from the compact header without replacing retained editor DOM', async () => {
    HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
    HTMLDialogElement.prototype.close ??= function () { this.open = false; this.dispatchEvent(new Event('close')); };
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.open = true; });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () { this.open = false; this.dispatchEvent(new Event('close')); });
    const f = tabsFixture(), back = vi.fn(), sidebar = document.createElement('aside');
    sidebar.append(f.tabs.opened); document.body.append(sidebar);
    const first = await f.tabs.open('a', 'First', false); first.panel.innerHTML = '<textarea>Keep this draft</textarea>';
    await f.tabs.open('b', 'Second', false); f.tabs.activate('a');
    const slot = document.createElement('div'); first.panel.append(slot);
    const release = f.tabs.mountCompactNavigation(slot, 'Project', back);
    const buttons = slot.querySelectorAll<HTMLButtonElement>('button'); buttons[0].click(); expect(back).toHaveBeenCalledOnce();
    expect(slot.textContent).toContain('First'); expect(slot.textContent).toContain('Project');
    buttons[1].click(); const dialog = document.querySelector<HTMLDialogElement>('.workbench-opened-sheet')!;
    expect(dialog.open).toBe(true); expect(dialog.contains(f.tabs.opened)).toBe(true);
    dialog.querySelector<HTMLButtonElement>('[data-opened-id="b"] .workbench-tabs__opened-label')!.click();
    await vi.waitFor(() => expect(f.tabs.current?.id).toBe('b'));
    await vi.waitFor(() => expect(document.querySelector('.workbench-opened-sheet')).toBeNull());
    expect(first.panel.querySelector('textarea')?.value).toBe('Keep this draft');
    expect(f.tabs.opened.parentElement).toBe(sidebar);
    release(); await f.tabs.destroy();
});

it('locates same-named windows by project and path and retains their context across restoration', async () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.open = true; });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () { this.open = false; this.dispatchEvent(new Event('close')); });
    const f = tabsFixture(), sidebar = document.createElement('aside'); sidebar.append(f.tabs.opened); document.body.append(sidebar);
    await f.tabs.open('one', 'New conversation', false); f.tabs.context('one', 'Alpha'); f.tabs.location('one', '/work/research');
    await f.tabs.open('two', 'New conversation', false); f.tabs.context('two', 'Beta'); f.tabs.location('two', '/work/design');
    const slot = document.createElement('div'); f.tabs.content.append(slot);
    const release = f.tabs.mountCompactNavigation(slot, 'Beta', () => {});
    try {
        slot.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click();
        const dialog = document.querySelector<HTMLDialogElement>('.workbench-opened-sheet')!;
        expect(dialog.querySelector('[data-opened-id="one"] small')!.textContent).toBe('Alpha · /work/research');
        const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
        search.value = 'research'; search.dispatchEvent(new Event('input'));
        expect(dialog.querySelector<HTMLElement>('[data-opened-id="one"]')!.hidden).toBe(false);
        expect(dialog.querySelector<HTMLElement>('[data-opened-id="two"]')!.hidden).toBe(true);
        f.tabs.title('one', 'Renamed'); expect(f.tabs.current?.id).toBe('two');
        expect(dialog.querySelector<HTMLElement>('[data-opened-id="two"]')!.hidden).toBe(true);
        dialog.close(); expect(sidebar.querySelector<HTMLElement>('[data-opened-id="two"]')!.hidden).toBe(true);
        const saved = readWorkbenchSnapshot({ version: 1, tabs: f.tabs.snapshot() });
        expect(saved!.tabs![0]).toMatchObject({ id: 'one', title: 'Renamed', context: 'Alpha', location: '/work/research' });
        const restoredHost = document.createElement('div'); document.body.append(restoredHost);
        const restored = new WorkbenchTabs(restoredHost, { activate: vi.fn(), dispose: async () => {}, empty() {}, error() {} }, saved!.tabs);
        expect(restored.opened.querySelector('[data-opened-id="one"] small')!.textContent).toBe('Alpha · /work/research');
        await restored.destroy();
    } finally { release(); await f.tabs.destroy(); }
});

it('lists windows immediately and closes a filtered multi-selection while retaining failed and pinned windows', async () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.open = true; });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () { this.open = false; this.dispatchEvent(new Event('close')); });
    const host = document.createElement('div'), slot = document.createElement('div'); document.body.append(host, slot);
    const dispose = vi.fn(async () => {}), error = vi.fn();
    const tabs = new WorkbenchTabs(host, { navigation: 'Workbench', activate: async id => {tabs.activate(id);}, dispose, error, empty() {} });
    for (const id of ['one', 'two', 'three', 'pinned']) {
        await tabs.open(id, id + '.md', false); tabs.context(id, id === 'three' ? 'Beta' : 'Alpha'); tabs.location(id, '/notes/' + id + '.md');
    }
    tabs.pin('pinned'); const release = tabs.mountWindowList(slot);
    try {
        slot.querySelector<HTMLButtonElement>('button')!.click();
        const dialog = document.querySelector<HTMLDialogElement>('.workbench-opened-sheet')!;
        expect(dialog.querySelectorAll('[data-opened-id]')).toHaveLength(4);
        expect([...dialog.querySelectorAll<HTMLElement>('[data-opened-id]')].every(row => !row.hidden)).toBe(true);
        expect(dialog.querySelector('[data-opened-id="one"] small')!.textContent).toBe('Workbench · Alpha · /notes/one.md');
        const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
        search.value = 'alpha'; search.dispatchEvent(new Event('input'));
        expect(dialog.querySelector<HTMLElement>('[data-opened-id="three"]')!.hidden).toBe(true);
        dialog.querySelector<HTMLInputElement>('.workbench-tabs__opened-toolbar input')!.click();
        expect(dialog.querySelector<HTMLInputElement>('[data-opened-id="one"] input')!.checked).toBe(true);
        expect(dialog.querySelector<HTMLInputElement>('[data-opened-id="two"] input')!.checked).toBe(true);
        expect(dialog.querySelector<HTMLInputElement>('[data-opened-id="three"] input')!.checked).toBe(false);
        expect(dialog.querySelector<HTMLInputElement>('[data-opened-id="pinned"] input')!.disabled).toBe(true);
        dispose.mockRejectedValueOnce(new Error('save failed'));
        dialog.querySelector<HTMLButtonElement>('[data-action="close-selected-tabs"]')!.click();
        await vi.waitFor(() => expect(tabs.get('two')).toBeUndefined());
        expect(tabs.get('one')!.failed).toBe(true); expect(tabs.get('three')).toBeDefined(); expect(tabs.get('pinned')).toBeDefined();
        expect(error).toHaveBeenCalledOnce(); expect(dialog.open).toBe(true);
        search.value = ''; search.dispatchEvent(new Event('input'));
        expect(dialog.querySelector<HTMLElement>('[data-opened-id="three"]')!.hidden).toBe(false);
    } finally { release(); await tabs.destroy(); }
});

it('fills legacy window locations on demand without opening their editors', async () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.open = true; });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () { this.open = false; this.dispatchEvent(new Event('close')); });
    const host = document.createElement('div'), slot = document.createElement('div'); document.body.append(host, slot);
    const activate = vi.fn(), describe = vi.fn(async () => ({ context: 'Legacy project', location: '/old/project' }));
    const tabs = new WorkbenchTabs(host, { activate, describe, dispose: async () => {}, empty() {}, error() {} }, [
        { id: 'old-session', title: 'New conversation', pinned: false },
    ]);
    const release = tabs.mountCompactNavigation(slot, '', () => {});
    try {
        expect(describe).not.toHaveBeenCalled(); slot.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click();
        await vi.waitFor(() => expect(document.querySelector('.workbench-tabs__opened-text small')!.textContent).toBe('Legacy project · /old/project'));
        expect(activate).not.toHaveBeenCalled(); expect(describe).toHaveBeenCalledOnce();
    } finally { release(); await tabs.destroy(); }
});

it.each(['context', 'location', 'route-roundtrip'] as const)('discards late descriptions after a newer %s update', async field => {
    HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
    HTMLDialogElement.prototype.close ??= function () { this.open = false; this.dispatchEvent(new Event('close')); };
    let finish!: (info: { context: string; location: string }) => void;
    const host = document.createElement('div'), slot = document.createElement('div'); document.body.append(host, slot);
    const tabs = new WorkbenchTabs(host, { describe: () => new Promise(resolve => { finish = resolve; }),
        activate: vi.fn(), dispose: async () => {}, empty() {}, error() {} }, [
        { id: 'session', title: 'Conversation', pinned: false },
    ]);
    const release = tabs.mountCompactNavigation(slot, '', () => {});
    try {
        slot.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click();
        if (field === 'route-roundtrip') { tabs.rename('session', 'temporary', 'Conversation'); tabs.rename('temporary', 'session', 'Conversation'); }
        else { tabs[field]('session', 'fresh'); if (field === 'context') tabs.context('session', undefined); }
        const before = tabs.snapshot();
        finish({ context: 'Old project', location: '/stale' }); await Promise.resolve(); await Promise.resolve();
        expect(tabs.snapshot()).toEqual(before);
        expect(tabs.get('session')!.location).not.toBe('/stale');
    } finally { release(); await tabs.destroy(); }
});

it('does not apply a late location lookup after the window route changes', async () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.open = true; });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () { this.open = false; this.dispatchEvent(new Event('close')); });
    let finish!: (value: { location: string }) => void;
    const host = document.createElement('div'), slot = document.createElement('div'); document.body.append(host, slot);
    const describe = vi.fn(() => new Promise<{ location: string }>(resolve => { finish = resolve; }));
    const tabs = new WorkbenchTabs(host, { describe, activate: vi.fn(), dispose: async () => {}, empty() {}, error() {} }, [
        { id: '/old/name.md', title: 'name.md', pinned: false },
    ]);
    const release = tabs.mountCompactNavigation(slot, '', () => {});
    try {
        slot.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click(); expect(describe).toHaveBeenCalledOnce();
        tabs.rename('/old/name.md', '/new/name.md', 'name.md'); finish({ location: '/old/name.md' });
        await Promise.resolve(); await Promise.resolve();
        expect(tabs.get('/new/name.md')!.location).toBeUndefined(); expect(tabs.get('/old/name.md')).toBeUndefined();
    } finally { release(); await tabs.destroy(); }
});
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
it('shares the same search input and query between the sidebar and the window dialog', async () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {this.open = true;});
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () {this.open = false; this.dispatchEvent(new Event('close'));});
    const f = tabsFixture(), sidebar = document.createElement('aside'), slot = document.createElement('div');
    sidebar.append(f.tabs.opened); document.body.append(sidebar, slot);
    await f.tabs.open('one', 'First', false); await f.tabs.open('two', 'Second', false);
    const search = sidebar.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'First'; search.dispatchEvent(new Event('input'));
    expect(sidebar.querySelector<HTMLElement>('[data-opened-id="two"]')!.hidden).toBe(true);
    const release = f.tabs.mountWindowList(slot); slot.querySelector<HTMLButtonElement>('button')!.click();
    const dialog = document.querySelector<HTMLDialogElement>('.workbench-opened-sheet')!;
    expect(dialog.querySelector('input[type="search"]')).toBe(search);
    dialog.close(); expect(sidebar.querySelector('input[type="search"]')).toBe(search); expect(search.value).toBe('First');
    release(); await f.tabs.destroy();
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
        expect(factory).not.toHaveBeenCalled();
        sidebar.querySelector<HTMLButtonElement>('[data-action="open-root"]')!.click();
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
        expect([...toolbar.querySelectorAll(':scope > button')].map(button => button.title)).toEqual(['刷新列表', '新建文件', '新建目录']);
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
        await workbench.start(); sidebar.querySelector<HTMLButtonElement>('[data-action="open-root"]')!.click();
        await vi.waitFor(() => expect(main.querySelector('[data-resource-id="/a.md"]')).not.toBeNull());
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
        await workbench.start(); sidebar.querySelector<HTMLButtonElement>('[data-action="open-root"]')!.click();
        await vi.waitFor(() => expect(main.querySelector('[data-resource-id="/source.md"]')).not.toBeNull());
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

it('restores layout and tab entries without opening the saved file; an explicit open waits for its editor', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }); const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/', name: 'saved.md', content: 'saved file body' });
    const main = document.createElement('div'), sidebar = document.createElement('div'); document.body.append(sidebar, main);
    const snapshot = { activeId: '/saved.md', expandedFolderIds: [], selectedItemIds: ['/saved.md'] };
    const factory = vi.fn(async (mount: HTMLElement) => { await new Promise(resolve => setTimeout(resolve, 10)); mount.textContent = 'editor ready'; return { destroy() {} }; });
    const workbench = new Workbench({ files: { fs, cwd: '/' }, sidebarContainer: sidebar, editorContainer: main, editorFactory: factory as never,
        uiPersistence: { load: () => snapshot, save() {} },
        workbenchState: { load: () => ({ version: 1, tabs: [{ id: '/saved.md', title: 'Saved tab', pinned: true }] }), save() {} } });
    try {
        await workbench.start();
        expect(factory).not.toHaveBeenCalled(); expect(workbench.getActiveFilePath()).toBeNull();
        expect(main.textContent).toContain('Saved tab'); expect(main.textContent).not.toContain('editor ready');
        expect(snapshot.activeId).toBe('/saved.md'); expect(snapshot.selectedItemIds).toEqual(['/saved.md']);
        await workbench.openFile('/saved.md');
        expect(factory).toHaveBeenCalledOnce(); expect(main.textContent).toContain('editor ready');
    } finally { await workbench.destroy(); await manager.dispose(); }
});

it('uses a display-only path in compact directory navigation and restores document titles on activation', async () => {
    const f = tabsFixture(), open = vi.fn();
    const dir = await f.tabs.open('directory', '文件', false);
    f.tabs.context(dir.id, '个人');
    f.tabs.setNavigationLabel(dir.id, createDirectoryBreadcrumbs([{id: '/', label: '所有项目'}, {id: '/p', label: '个人'}, {id: '/p/files', label: '文件'}], open));
    const label = () => f.container.querySelector('.workbench-tabs__navigation .workbench-compact-navigation__label')!;
    try {
        expect(label().textContent).toBe('所有项目 / 个人 / 文件');
        expect(label().querySelector('strong')).toBeNull();
        label().querySelector<HTMLButtonElement>('[data-directory-path="/p"]')!.click(); expect(open).toHaveBeenCalledWith('/p');
        expect(f.tabs.snapshot()[0]).toEqual({id: 'directory', title: '文件', pinned: false, context: '个人'});
        await f.tabs.open('doc', 'notes.md', false); expect(label().querySelector('nav')).toBeNull(); expect(label().textContent).toContain('notes.md');
        f.tabs.activate(dir.id); expect(label().textContent).toBe('所有项目 / 个人 / 文件');
    } finally { await f.tabs.destroy(); }
});
