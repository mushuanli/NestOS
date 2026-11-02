// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {FILE_ICONS} from '@itookit/common';
import type {EditorOptions} from '@itookit/ui-common-adapter';
import {connectEditorLifecycle} from '../src/browser/editor-connector';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); sessionStorage.clear(); vi.restoreAllMocks();});

async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({parentPath: '/', name: 'note.txt', content: 'Study reference'});
    const host = document.createElement('div'); document.body.append(host);
    const switchToMode = vi.fn(async (_mode: 'edit' | 'render') => {}), focus = vi.fn();
    const file = vi.fn(async (_container: HTMLElement, options: EditorOptions) => ({destroy: vi.fn(async () => {}),
        flushPendingSave: async () => {}, on: () => () => {}, getText: () => options.initialContent ?? '', switchToMode, focus}));
    const destroyStudy = vi.fn(async () => {}), study = document.createElement('div'); study.textContent = 'Study manager';
    const createStudy = vi.fn(async (container: HTMLElement) => {container.append(study); return {destroy: destroyStudy, flushPendingSave: async () => {}} as never;});
    const vfs = {on: () => () => {}, getResourceIcon: () => FILE_ICONS.folder};
    const lifecycle = connectEditorLifecycle(vfs as never, fs, host, file as never, {
        virtualViews: [{id: '@study', title: 'Study', icon: FILE_ICONS.folder, preview: false, create: createStudy}]});
    cleanup.push(lifecycle);
    return {host, lifecycle, file, createStudy, destroyStudy, study, switchToMode, focus};
}

it('keeps the study manager mounted while opening a file and reuses it on return', async () => {
    const f = await fixture(); await f.lifecycle.openResource('@study');
    expect(f.host.querySelector('[data-tab-id="@study"]')?.classList.contains('is-preview')).toBe(false);
    await f.lifecycle.openResource('/note.txt');
    expect(f.study.isConnected).toBe(true); expect(f.study.closest<HTMLElement>('.workbench-tabs__panel')?.hidden).toBe(true);
    expect(f.destroyStudy).not.toHaveBeenCalled();
    await f.lifecycle.openResource('@study');
    expect(f.createStudy).toHaveBeenCalledOnce(); expect(f.lifecycle.getActiveResourceId()).toBe('@study');
    expect(f.study.closest<HTMLElement>('.workbench-tabs__panel')?.hidden).toBe(false);
});

it.each(['edit', 'render'] as const)('opens a file in %s mode without recreating an existing editor', async mode => {
    const f = await fixture(); await f.lifecycle.openResource('/note.txt');
    expect(f.switchToMode).not.toHaveBeenCalled();
    await f.lifecycle.openResource('/note.txt', mode);
    expect(f.file).toHaveBeenCalledOnce(); expect(f.switchToMode).toHaveBeenCalledWith(mode); expect(f.focus).toHaveBeenCalled();
});
