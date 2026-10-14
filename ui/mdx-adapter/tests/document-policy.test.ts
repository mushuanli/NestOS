// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { language } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { defaultEditorFactory } from '../src/factory';
import { MDxEditor, MDxRenderer } from '@itookit/mdxeditor';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each(['pnpm-lock.yaml', 'package.json', 'debug.log', 'LICENSE', 'source.txt'])('opens %s as editable source without Markdown parsing', async name => {
    const render = vi.spyOn(MDxRenderer.prototype, 'render');
    const save = vi.fn(async (_path: string, _text: string) => {});
    const element = document.createElement('div'); document.body.append(element);
    const content = '# literal\n- [ ] text\n<script>literal</script>';
    const editor = await defaultEditorFactory(element, { target: { kind: 'file', path: '/' + name }, initialContent: content,
        hostContext: { toggleSidebar() {}, saveContent: save } }) as MDxEditor;
    try {
        expect(editor.getMode()).toBe('edit');
        expect(editor.getEditorView()!.state.facet(language)).toBeNull();
        expect(editor.getText()).toBe(content);
        await editor.switchToMode('render');
        expect(editor.getMode()).toBe('edit'); expect(render).not.toHaveBeenCalled();
        editor.setText(content + '\nchanged'); editor.setDirty(true);
        await editor.flushPendingSave();
        expect(save).toHaveBeenCalledWith('/' + name, content + '\nchanged');
    } finally { await editor.destroy(); }
});

it('keeps explicit source mode and Markdown document aliases while deferring large previews', async () => {
    const render = vi.spyOn(MDxRenderer.prototype, 'render');
    for (const options of [
        { target: { kind: 'file' as const, path: '/note.md' }, initialMode: 'edit' as const, initialContent: '# normal' },
        { target: { kind: 'file' as const, path: '/large.md' }, initialContent: 'line\n'.repeat(5001) },
        { target: { kind: 'file' as const, path: '/one-line.md' }, initialContent: 'x'.repeat(10_002) },
    ]) {
        const element = document.createElement('div');
        const editor = await defaultEditorFactory(element, options) as MDxEditor;
        expect(editor.getMode()).toBe('edit'); expect(render).not.toHaveBeenCalled();
        await editor.destroy();
    }
    const editor = await defaultEditorFactory(document.createElement('div'), { target: { kind: 'file', path: '/lesson.prj' },
        contentFormat: 'markdown', initialContent: '# Lesson' }) as MDxEditor;
    expect(editor.getMode()).toBe('render'); expect(render).toHaveBeenCalledOnce(); await editor.destroy();
});

it('opens the repository lockfile without a Markdown parser and respects readonly access', async () => {
    const content = readFileSync('../../pnpm-lock.yaml', 'utf8');
    const render = vi.spyOn(MDxRenderer.prototype, 'render');
    const element = document.createElement('div'); document.body.append(element);
    const editor = await defaultEditorFactory(element, { target: { kind: 'file', path: '/pnpm-lock.yaml' },
        initialContent: content, readOnly: true }) as MDxEditor;
    try {
        expect(editor.getText()).toBe(content);
        expect(editor.getMode()).toBe('edit');
        expect(editor.getEditorView()!.state.facet(EditorView.editable)).toBe(false);
        expect(editor.getEditorView()!.state.facet(language)).toBeNull();
        expect(render).not.toHaveBeenCalled();
    } finally { await editor.destroy(); }
});

it('toggles source wrapping without changing content, selection or dirty state', async () => {
    const editor = await defaultEditorFactory(document.createElement('div'), {
        initialContent: 'long source line', initialMode: 'edit',
    }) as MDxEditor;
    try {
        const view = editor.getEditorView()!;
        view.dispatch({ selection: { anchor: 4 } });
        const changed = vi.fn(); editor.on('change', changed);
        expect(editor.getLineWrapping()).toBe(true);
        editor.setLineWrapping(false);
        expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false);
        editor.setLineWrapping(true);
        expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
        expect(view.state.selection.main.anchor).toBe(4);
        expect(editor.getText()).toBe('long source line');
        expect(editor.isDirty()).toBe(false);
        expect(changed).not.toHaveBeenCalled();
    } finally { await editor.destroy(); }
});

it('exposes independent source and preview wrapping through the titlebar without reparsing', async () => {
    const mount = document.createElement('div');
    const editor = await defaultEditorFactory(mount, { initialContent: '```text\nlong line\n```' }) as MDxEditor;
    try {
        const render = vi.spyOn(MDxRenderer.prototype, 'render');
        const button = mount.querySelector<HTMLButtonElement>('[data-button-id="toggle-line-wrapping"]')!;
        expect(button.getAttribute('aria-pressed')).toBe('false');
        const code = mount.querySelector('pre code');
        button.click(); await Promise.resolve();
        expect(editor.getLineWrapping('render')).toBe(true);
        expect(mount.querySelector('.mdx-editor-renderer--wrap pre code')).toBe(code);
        expect(render).not.toHaveBeenCalled();
        await editor.switchToMode('edit');
        editor.setLineWrapping(false);
        await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'));
        expect(editor.getLineWrapping('render')).toBe(true);
        await editor.switchToMode('render');
        await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
        expect(editor.isDirty()).toBe(false);
    } finally { await editor.destroy(); }
});

it('keeps large source wrapping off by default but allows opting in', async () => {
    const editor = await defaultEditorFactory(document.createElement('div'), {
        initialContent: 'x'.repeat(10_001),
    }) as MDxEditor;
    try {
        expect(editor.getLineWrapping()).toBe(false);
        editor.setLineWrapping(true);
        expect(editor.getEditorView()!.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
    } finally { await editor.destroy(); }
});
