// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {defaultEditorFactory} from '@itookit/mdx-adapter';
import type {MDxEditor} from '@itookit/mdxeditor';
import {WorkbenchTabs} from '../src/workbench/tabs';
import {setupMobileWorkspaceView} from '../src/navigation/mobile-workspace-view';

afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
it('places one sidebar control at the left of the tab bar and marks page navigation for mobile', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('aside'), main = document.createElement('main');
    layout.className = 'mm-layout'; sidebar.className = 'mm-sidebar'; layout.append(sidebar, main); document.body.append(layout);
    const tabs = new WorkbenchTabs(main, {activate: async () => {}, dispose: async () => {}, empty() {}, error() {}});
    await tabs.open('/note', 'Note');
    const slot = document.createElement('header'); tabs.current!.panel.append(slot);
    const release = tabs.mountTitleBar(slot);
    try {
        const bar = main.querySelector('.workbench-tabs__bar')!;
        expect(bar.firstElementChild?.classList.contains('workbench-tabs__sidebar-toggle')).toBe(true);
        expect(main.querySelectorAll('.workbench-tabs__sidebar-toggle')).toHaveLength(1);
        expect(bar.querySelector('details')).toBeNull();
        expect(main.dataset.sidebarVisible).toBe('true');
        (bar.firstElementChild as HTMLButtonElement).click(); expect(sidebar.classList.contains('is-collapsed')).toBe(true);
        await vi.waitFor(() => expect(main.dataset.sidebarVisible).toBe('false'));
        expect(bar.querySelector('.workbench-tabs__bar-windows')).not.toBeNull();
        expect(bar.querySelector('[data-window-navigation="parent"]')).toBeNull();
        sidebar.classList.remove('is-collapsed'); await vi.waitFor(() => expect(main.dataset.sidebarVisible).toBe('true'));
        expect(slot.querySelector('.workbench-content-back')).not.toBeNull();
    } finally {release(); await tabs.destroy();}
});
it('uses the existing file title bar for windows and overflow actions while retaining unsaved content', async () => {
    vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener() {}, removeEventListener() {}}));
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const layout = document.createElement('div'), sidebar = document.createElement('div'), content = document.createElement('div');
    layout.className = 'mm-layout'; content.className = 'mm-editor-area'; layout.append(sidebar, content); document.body.append(layout);
    const tabs = new WorkbenchTabs(content, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error(error) {throw error;}});
    sidebar.append(tabs.opened);
    const release = setupMobileWorkspaceView(layout, sidebar, content);
    const tab = await tabs.open('/note.md', 'note.md', false), mount = document.createElement('div'); tab.panel.append(mount);
    const editor = await defaultEditorFactory(mount, {target: {kind: 'file', path: '/note.md'}, title: 'note.md', initialContent: 'Original', initialMode: 'edit',
        mountTitleBar: (slot, parts) => tabs.mountTitleBar(slot, parts),
        mountWindowList: slot => tabs.mountWindowList(slot), hostContext: {saveContent: async () => {}, toggleSidebar: () => {layout.dataset.mobileView = 'list';}}}) as MDxEditor;
    try {
        await vi.waitFor(() => expect(layout.dataset.mobileHeader).toBe('embedded'));
        expect(tab.panel.querySelectorAll('.mdx-editor-titlebar')).toHaveLength(1);
        expect(tab.panel.querySelectorAll('.ui-content-titlebar')).toHaveLength(1);
        expect(tab.panel.querySelectorAll('.workbench-window-list')).toHaveLength(1);
        const mode = tab.panel.querySelector<HTMLButtonElement>('[data-button-id="toggle-edit-mode"]')!;
        expect(tab.panel.querySelectorAll('[data-button-id="toggle-edit-mode"]')).toHaveLength(1);
        expect(mode.closest('.ui-content-titlebar__identity')).not.toBeNull();
        mode.click(); await vi.waitFor(() => expect(editor.getMode()).toBe('render'));
        mode.click(); await vi.waitFor(() => expect(editor.getMode()).toBe('edit'));
        expect(tab.panel.querySelector('[data-button-id="toggle-sidebar"]')?.getAttribute('aria-label')).toBe('返回上一页');
        const title = tab.panel.querySelector<HTMLInputElement>('.mdx-editor-titlebar__title')!; expect(title.value).toBe('note.md');
        const menu = tab.panel.querySelector<HTMLDetailsElement>('.mdx-editor-titlebar__menu')!;
        for (const id of ['copy-content', 'save-action']) {
            const action = tab.panel.querySelector(`[data-button-id="${id}"]`)!; expect(action).not.toBeNull(); expect(action.closest('details')).toBeNull();
        }
        editor.setText('Unsaved text'); editor.setDirty(true);
        menu.querySelector('summary')!.click(); expect(menu.open).toBe(true);
        menu.querySelector<HTMLButtonElement>('[data-button-id="toggle-line-wrapping"]')!.click(); await Promise.resolve();
        expect(menu.open).toBe(false); expect(editor.getText()).toBe('Unsaved text'); expect(editor.isDirty()).toBe(true);
        tab.panel.querySelector<HTMLButtonElement>('.workbench-window-list')!.click();
        const sheet = document.querySelector<HTMLDialogElement>('.workbench-opened-sheet')!; expect(sheet.open).toBe(true); sheet.close();
        tab.panel.querySelector<HTMLButtonElement>('[data-button-id="toggle-sidebar"]')!.click();
        await vi.waitFor(() => expect(layout.dataset.mobileView).toBe('list'));
        expect(editor.getText()).toBe('Unsaved text');
    } finally {await editor.destroy(); release(); await tabs.destroy();}
});
