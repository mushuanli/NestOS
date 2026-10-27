// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {MDxEditor} from '@itookit/mdxeditor';
import {mountFileMenu} from '../src/file-menu';

const cleanups: Array<() => void> = [];
beforeEach(() => {HTMLDialogElement.prototype.showModal = function () {this.open = true;};});
afterEach(() => {cleanups.splice(0).forEach(stop => stop()); document.body.replaceChildren(); vi.restoreAllMocks();});
function fixture() {
    let text = 'Current content', dirty = false, disk = 'Disk content', committed = 0;
    const backup: string[] = [], read = vi.fn(async () => ({createdAt: 1_700_000_000_000, modifiedAt: 1_700_000_100_000}));
    const editor = {getText: () => text, isDirty: () => dirty,
        replaceLoadedContent: vi.fn((value: string, expected: string) => {expect(text).toBe(expected); text = value; dirty = false;})};
    const container = document.createElement('div'); document.body.append(container);
    const stop = mountFileMenu(container, editor as unknown as MDxEditor, {target: {kind: 'file', path: '/note.md'}, files: {fs: {driver: {getNode: read}}} as any,
        hostContext: {reloadContent: async (_path, accept) => {if (await accept(disk)) committed++;},
            reloadRecovery: {preserve: async value => {backup.push(value);}, read: async () => backup.at(-1)}} as any}, () => '/note.md');
    cleanups.push(stop);
    return {container, editor, read, backup, stop, text: () => text, committed: () => committed, edit: (value: string) => {text = value; dirty = true;}, disk: (value: string) => {disk = value;},
        refresh: () => container.querySelector<HTMLButtonElement>('[data-file-refresh]')!.click()};
}
it('reads file times only when information expands and does not poll or read AI state', async () => {
    const f = fixture(); expect(f.read).not.toHaveBeenCalled();
    f.container.querySelector('details')!.open = true;
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    expect(f.container.querySelectorAll('dd')).toHaveLength(2);
    expect(f.container.querySelector('dd')!.textContent).not.toBe('Unknown');
});
it('compares changes, preserves current on cancel, and advances the host revision only on acceptance', async () => {
    const f = fixture(); f.refresh();
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    expect(document.querySelectorAll('[data-changed]')).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('[data-compare-keep]')!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('已保留当前'));
    expect(f.text()).toBe('Current content'); expect(f.committed()).toBe(0);
    f.refresh(); await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-compare-load]')!.click();
    await vi.waitFor(() => expect(f.committed()).toBe(1)); expect(f.text()).toBe('Disk content');
});
it('preserves a dirty draft backup before loading the selected disk version', async () => {
    const f = fixture(); f.edit('Unsaved private text'); f.refresh();
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-compare-load]')!.click();
    await vi.waitFor(() => expect(f.committed()).toBe(1)); expect(f.backup).toEqual(['Unsaved private text']); expect(f.text()).toBe('Disk content');
});
it('rejects stale confirmation when editing continues during comparison', async () => {
    const f = fixture(); f.refresh(); await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    f.edit('Newer draft'); document.querySelector<HTMLButtonElement>('[data-compare-load]')!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('文档已改变'));
    expect(f.text()).toBe('Newer draft'); expect(f.committed()).toBe(0); expect(f.editor.replaceLoadedContent).not.toHaveBeenCalled();
});
it('cancels the compare dialog when the editor closes', async () => {
    const f = fixture(); f.refresh(); await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    f.stop(); expect(document.querySelector('dialog')).toBeNull(); await Promise.resolve(); expect(f.committed()).toBe(0);
});
