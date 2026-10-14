// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { setupMobileWorkspaceView } from '../src/navigation/mobile-workspace-view';
import { VFS_DOM_EVENTS } from '@itookit/vfs-ui';
import { WorkbenchTabs } from '../src/workbench/tabs';

afterEach(() => { document.body.innerHTML = ''; });

it('switches a narrow workspace between the file list and the active editor', async () => {
    const layout = document.createElement('div');
    const sidebar = document.createElement('div');
    const editor = document.createElement('div');
    layout.append(sidebar, editor);
    document.body.append(layout);
    editor.innerHTML = '<div class="mm-placeholder">Choose a file</div>';
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    try {
        expect(layout.dataset.mobileView).toBe('list');
        editor.innerHTML = '<div class="editor">Open file</div>';
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(layout.dataset.mobileView).toBe('detail');
        layout.querySelector<HTMLButtonElement>('.mm-mobile-back')!.click();
        expect(layout.dataset.mobileView).toBe('list');
        sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated));
        expect(layout.dataset.mobileView).toBe('detail');
    } finally { dispose(); }
});

it('keeps the list visible while tabs initialize and follows actual active panel content', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    const tabs = new WorkbenchTabs(editor, { activate: async id => { tabs.activate(id); },
        dispose: async () => {}, empty: () => {}, error: error => { throw error; } });
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        const first = await tabs.open('first', 'First', false);
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        first.panel.innerHTML = '<div class="editor">Ready</div>';
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        layout.querySelector<HTMLButtonElement>('.mm-mobile-back')!.click();
        first.panel.firstElementChild!.append(document.createElement('span'));
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        await tabs.open('second', 'Second', false);
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        tabs.activate('first'); await flush(); expect(layout.dataset.mobileView).toBe('detail');
        first.panel.innerHTML = '<div class="mm-placeholder">Choose a file</div>';
        await flush(); expect(layout.dataset.mobileView).toBe('list');
    } finally { dispose(); }
});
