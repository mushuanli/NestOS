// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installMobileViewport } from '../src/navigation/mobile-viewport';
import { setupMobileWorkspaceView } from '../src/navigation/mobile-workspace-view';
import { VFS_DOM_EVENTS } from '@itookit/vfs-ui';
import { WorkbenchTabs } from '../src/workbench/tabs';

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

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

it('keeps initial tabs in the list and enters detail as soon as a resource is activated', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    const tabs = new WorkbenchTabs(editor, { activate: async id => { tabs.activate(id); },
        dispose: async () => {}, empty: () => {}, error: error => { throw error; } });
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        const first = await tabs.open('first', 'First', false);
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        first.panel.innerHTML = '<div class="editor">Ready</div>';
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        layout.querySelector<HTMLButtonElement>('.mm-mobile-back')!.click();
        first.panel.firstElementChild!.append(document.createElement('span'));
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        await tabs.open('second', 'Second', false);
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        tabs.activate('first'); await flush(); expect(layout.dataset.mobileView).toBe('detail');
        first.panel.innerHTML = '<div class="mm-placeholder">Choose a file</div>';
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        await tabs.close('first'); await tabs.close('second');
        await flush(); expect(layout.dataset.mobileView).toBe('list');
    } finally { dispose(); }
});

it('keeps detail visible during delayed preview disposal and before the next editor mounts', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => gate, empty() {}, error() {}});
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        const first = await tabs.open('first', 'First'); first.panel.innerHTML = '<div>First conversation</div>';
        await flush(); layout.querySelector<HTMLButtonElement>('.mm-mobile-back')!.click();
        sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated));
        const states: string[] = [], observer = new MutationObserver(() => {states.push(layout.dataset.mobileView!);});
        observer.observe(layout, {attributes: true, attributeFilter: ['data-mobile-view']});
        const next = tabs.open('second', 'Second'); await flush(); expect(layout.dataset.mobileView).toBe('detail');
        finish(); const second = await next; await flush(); expect(layout.dataset.mobileView).toBe('detail');
        second.panel.innerHTML = '<div data-editor-mobile-navigation="embedded">Second conversation</div>';
        await flush(); expect(states).not.toContain('list'); observer.disconnect();
        layout.querySelector<HTMLButtonElement>('.mm-mobile-back')!.click();
        tabs.activate('second'); await flush(); expect(layout.dataset.mobileView).toBe('detail');
    } finally {finish(); dispose(); await tabs.destroy();}
});

it('opens a deep link directly in detail while restored window entries initialize', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor, true);
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}},
        [{id: 'old', title: 'Previous window', pinned: false}]);
    try {
        await new Promise(resolve => setTimeout(resolve, 0)); expect(layout.dataset.mobileView).toBe('detail');
        expect(tabs.current).toBeUndefined();
        await tabs.open('current', 'Current session', false);
        await new Promise(resolve => setTimeout(resolve, 0)); expect(layout.dataset.mobileView).toBe('detail');
    } finally {dispose(); await tabs.destroy();}
});

it('keeps the requested detail presentation while its editor and navigation are still loading', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    layout.dataset.workspaceOpening = 'true';
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor, true);
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}},
        [{id: 'old', title: 'Previous window', pinned: false}]);
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        await flush();
        expect(layout.dataset.mobileView).toBe('detail');
        expect(layout.dataset.mobileHeader).toBe('pending');
        const current = await tabs.open('current', 'Current session', false);
        await flush(); expect(layout.dataset.mobileHeader).toBe('pending');
        current.panel.innerHTML = '<div data-editor-mobile-navigation="embedded">Current conversation</div>';
        delete layout.dataset.workspaceOpening;
        await flush(); expect(layout.dataset.mobileView).toBe('detail'); expect(layout.dataset.mobileHeader).toBe('embedded');
        layout.dataset.workspaceOpening = 'true'; await flush();
        const next = await tabs.open('document', 'Document', false); next.panel.textContent = 'Document';
        await flush(); expect(layout.dataset.mobileHeader).toBe('pending');
        delete layout.dataset.workspaceOpening;
        await flush(); expect(layout.dataset.mobileView).toBe('detail'); expect(layout.dataset.mobileHeader).toBe('standalone');
    } finally {dispose(); await tabs.destroy();}
});

it('uses embedded navigation only for the active editor and restores standalone navigation for documents', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}});
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        const chat = await tabs.open('chat', 'Chat', false); chat.panel.innerHTML = '<div data-editor-mobile-navigation="embedded">Chat</div>';
        await flush(); expect(layout.dataset.mobileHeader).toBe('embedded');
        layout.querySelector<HTMLButtonElement>('.mm-mobile-back')!.click();
        chat.panel.firstElementChild!.append(document.createElement('span')); await flush();
        expect(layout.dataset.mobileView).toBe('list');
        const doc = await tabs.open('doc', 'Document', false); doc.panel.textContent = 'Document';
        await flush(); expect(layout.dataset.mobileHeader).toBe('standalone');
        tabs.activate('chat'); await flush(); expect(layout.dataset.mobileHeader).toBe('embedded');
    } finally { dispose(); await tabs.destroy(); }
});

it('tracks the mobile keyboard viewport, ignores pinch zoom and releases listeners', () => {
    const viewport = Object.assign(new EventTarget(), {height: 800, scale: 1}); let narrow = true;
    vi.stubGlobal('visualViewport', viewport); vi.stubGlobal('matchMedia', () => ({matches: narrow}));
    const dispose = installMobileViewport(), value = () => document.documentElement.style.getPropertyValue('--app-visible-height');
    expect(value()).toBe('800px'); viewport.height = 380; viewport.dispatchEvent(new Event('resize')); expect(value()).toBe('380px');
    viewport.scale = 2; viewport.height = 190; viewport.dispatchEvent(new Event('resize')); expect(value()).toBe('380px');
    narrow = false; window.dispatchEvent(new Event('resize')); expect(value()).toBe('');
    dispose(); narrow = true; viewport.scale = 1; viewport.dispatchEvent(new Event('resize')); expect(value()).toBe('');
});
