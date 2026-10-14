// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultEditorFactory } from '../src/factory';
import type { MDxEditor } from '@itookit/mdxeditor';
import { fileReference } from '@itookit/mdxeditor';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

async function setup(mode: 'edit' | 'render' = 'edit', save = vi.fn(async () => {})) {
    const chat = vi.fn(async () => {}), mount = document.createElement('div'); document.body.append(mount);
    const editor = await defaultEditorFactory(mount, { target: { kind: 'file', path: '/note.md' },
        initialMode: mode, initialContent: 'one two three', hostContext: {
            chatFromFile: chat, toggleSidebar() {}, navigate: async () => {}, saveContent: save,
        } }) as MDxEditor;
    return { editor, chat, mount, button: mount.querySelector<HTMLButtonElement>('[data-button-id="ai-action"]')! };
}

it('quotes the current source selection after saving and suppresses duplicate clicks', async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { editor, chat, button } = await setup('edit', save);
    try {
        editor.setText('new current text'); editor.setDirty(true);
        editor.getEditorView()!.dispatch({ selection: { anchor: 4, head: 11 } });
        button.click(); button.click();
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        expect(chat).not.toHaveBeenCalled(); finish();
        await vi.waitFor(() => expect(chat).toHaveBeenCalledWith({ path: '/note.md', content: 'current', selection: true }));
        expect(chat).toHaveBeenCalledOnce(); expect(editor.isDirty()).toBe(false);
    } finally { await editor.destroy(); }
});

it('quotes a preview selection and ignores selections outside the document', async () => {
    const { editor, chat, button, mount } = await setup('render');
    try {
        const text = mount.querySelector('.mdx-editor-renderer p')!.firstChild!;
        const range = document.createRange(); range.setStart(text, 4); range.setEnd(text, 7);
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        button.dispatchEvent(press); expect(press.defaultPrevented).toBe(true); button.click();
        await vi.waitFor(() => expect(chat).toHaveBeenCalledWith({ path: '/note.md', content: 'two', selection: true }));
        const elsewhere = document.createElement('p'); elsewhere.textContent = 'outside'; document.body.append(elsewhere);
        range.selectNodeContents(elsewhere); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
        expect(fileReference(editor)).toEqual({ path: '/note.md', content: 'one two three', selection: false });
        editor.updateNodeId('/renamed.md');
        expect(fileReference(editor).path).toBe('/renamed.md');
    } finally { document.getSelection()!.removeAllRanges(); await editor.destroy(); }
});

it('does not create a chat if saving the current file fails', async () => {
    const save = vi.fn(async () => { throw new Error('disk full'); });
    const { editor, chat, button } = await setup('edit', save);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        editor.setDirty(true); button.click();
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(button.disabled).toBe(false));
        expect(chat).not.toHaveBeenCalled(); expect(editor.isDirty()).toBe(true);
    } finally { save.mockResolvedValue(undefined); await editor.destroy(); }
});
