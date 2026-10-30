// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {Workbench} from '../src/core/Workbench';

afterEach(() => {vi.unstubAllGlobals(); document.body.replaceChildren();});
it.each([{path: '/', readOnly: false}, {path: '/folder', readOnly: false}, {path: '/folder', readOnly: true}])('opens Anki from a restored mobile notes directory ($path, readOnly=$readOnly)', async ({path, readOnly}) => {
    vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener() {}, removeEventListener() {}}));
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    await fs.driver.createDirectory({parentPath: '/', name: 'folder'});
    const sidebar = document.createElement('div'), content = document.createElement('div'); document.body.append(sidebar, content);
    sidebar.hidden = true;
    const workbench = new Workbench({files: {fs, cwd: '/'}, sidebarContainer: sidebar, editorContainer: content,
        editorConfig: {plugins: ['cloze:cloze']}, uiOptions: {readOnly}});
    try {
        await workbench.start(path);
        const action = content.querySelector<HTMLButtonElement>('.workbench-directory__toolbar [data-action=study]');
        expect(action).not.toBeNull(); expect(action!.disabled).toBe(false); expect(action!.title).toContain('Anki');
        expect(action!.parentElement!.firstElementChild!.getAttribute('title')).toContain('刷新');
        action!.click();
        await vi.waitFor(() => expect(content.querySelector('.mdx-study')).not.toBeNull(), {timeout: 5000});
        expect(workbench.getActiveFilePath()).toBe('@study');
    } finally {await workbench.destroy(); await manager.dispose();}
});
it('keeps ordinary workspace directories free of the notes study action', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const sidebar = document.createElement('div'), content = document.createElement('div'); document.body.append(sidebar, content);
    const workbench = new Workbench({files: {fs, cwd: '/'}, sidebarContainer: sidebar, editorContainer: content});
    try {await workbench.start('/'); expect(content.querySelector('[data-action=study]')).toBeNull();}
    finally {await workbench.destroy(); await manager.dispose();}
});
it('reports a blocked navigation and lets the same directory action retry', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const sidebar = document.createElement('div'), content = document.createElement('div'); document.body.append(sidebar, content);
    let blocked = false;
    const workbench = new Workbench({files: {fs, cwd: '/'}, sidebarContainer: sidebar, editorContainer: content,
        editorConfig: {plugins: ['cloze:cloze']}, onBeforeNavigate: () => {if (blocked) throw Object.assign(new Error('请先保存当前内容'), {code: 'SAVE_REQUIRED'});}});
    try {
        await workbench.start('/'); blocked = true;
        const action = content.querySelector<HTMLButtonElement>('[data-action=study]')!; action.click();
        await vi.waitFor(() => expect(content.textContent).toContain('请先保存当前内容'));
        expect(workbench.getActiveFilePath()).toBe('/'); blocked = false; action.click();
        await vi.waitFor(() => expect(content.querySelector('.mdx-study')).not.toBeNull(), {timeout: 5000});
    } finally {await workbench.destroy(); await manager.dispose();}
});
