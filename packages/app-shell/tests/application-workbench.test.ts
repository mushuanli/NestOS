// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ApplicationEvent, ApplicationPort } from '@itookit/app-core/application/contracts';
import type { IEditor } from '@itookit/ui-common';
import { ApplicationFileBackend } from '../src/application/file-backend';
import { createApplicationWorkbench } from '../src/application/workbench-adapter';
import { defaultEditorFactory } from '@itookit/mdx-adapter';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture(chat = false) {
    const listeners = new Set<(event: ApplicationEvent) => void>();
    const entry = (path: string) => ({ path, name: path.split('/').pop() || '/', parentPath: path === '/' ? null : '/',
        type: path === '/' ? 'directory' : 'file', size: 10, createdAt: 1, modifiedAt: 1, version: 1, metadata: {}, tags: [] });
    const query = vi.fn(async (name: string, input: any) => {
        if (name === 'capabilities') return { commands: ['saveFile', 'createConversation'], workspaces: ['notes'] };
        if (name === 'entry') return entry(input.path);
        if (name === 'directory') return { entries: [entry('/a.md'), entry('/b.md')] };
        if (name === 'file') return { content: input.path, encoding: 'text', revision: 'original' };
        if (name === 'session') return { id: input.sessionId, title: input.sessionId, createdAt: 1, updatedAt: 1 };
        if (name === 'navigation') return { folders: [], sessions: ['one', 'two', ...(command.mock.calls.length ? ['created'] : [])]
            .map(id => ({ id, title: id, createdAt: 1, updatedAt: 1 })) };
    });
    const command = vi.fn(async () => ({ revision: 'saved', sessionId: 'created' }));
    const application: ApplicationPort = { query: query as ApplicationPort['query'], command: command as ApplicationPort['command'],
        subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); }, close: async () => {} };
    const sidebar = document.createElement('div'), editor = document.createElement('div'); document.body.append(sidebar, editor);
    const changes = new Map<string, Map<string, () => void>>();
    const file = vi.fn(async (mount: HTMLElement, options: any) => {
        mount.textContent = options.initialContent || options.title;
        const events = new Map<string, () => void>(); changes.set(options.target.path ?? options.target.sessionId, events);
        return { on: (name: string, callback: () => void) => { events.set(name, callback); return () => {}; },
            flushPendingSave: vi.fn(), destroy: vi.fn(), getText: () => '', isDirty: () => false } as unknown as IEditor;
    });
    const conversation = vi.fn(async (mount: HTMLElement, _controls: unknown, options: any) => file(mount, options));
    const view = createApplicationWorkbench({ application, sidebar, editor, presentation: { file, conversation },
        workspace: { elementId: 'notes', workspaceName: 'notes', title: 'Notes', slug: 'notes', type: chat ? 'chat' : 'standard' } });
    return { view, sidebar, editor, file, conversation, query, command, changes, listeners, application };
}
it('uses the real workbench toolbar and retains edited files across tab switches', async () => {
    const f = fixture(); await f.view.start();
    try {
        expect(f.editor.querySelector('[role="tablist"]')).not.toBeNull();
        expect(f.sidebar.querySelector<HTMLButtonElement>('[data-action="create-directory"]')?.disabled).toBe(true);
        expect(f.sidebar.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.disabled).toBe(false);
        await vi.waitFor(() => expect(f.editor.querySelectorAll('[data-directory-action]').length).toBe(2));
        expect([...f.editor.querySelectorAll<HTMLButtonElement>('[data-directory-action]')].every(button => button.disabled)).toBe(true);
        f.editor.querySelector<HTMLInputElement>('thead input')!.click();
        expect([...f.editor.querySelectorAll<HTMLButtonElement>('.workbench-directory__selection button[data-action]')].every(button => button.disabled)).toBe(true);
        await f.view.open('/a.md'); await vi.waitFor(() => expect(f.file).toHaveBeenCalledOnce());
        f.changes.get('/a.md')!.get('interactiveChange')!();
        await f.view.open('/b.md'); await vi.waitFor(() => expect(f.file).toHaveBeenCalledTimes(2));
        await f.view.open('/a.md'); await vi.waitFor(() => expect(f.editor.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toBe('/a.md'));
        expect(f.file).toHaveBeenCalledTimes(2);
        await f.file.mock.calls[0][1].hostContext.saveContent('/a.md', 'edited');
        expect(f.command).toHaveBeenCalledWith('saveFile', expect.objectContaining({ path: '/a.md', content: 'edited', revision: 'original' }));
    } finally { await f.view.close(); }
    expect(f.listeners.size).toBe(0);
});
it('uses the same tabs for conversations and the host command for session creation', async () => {
    const f = fixture(true); await f.view.start();
    try {
        await f.view.open('session:one'); await vi.waitFor(() => expect(f.conversation).toHaveBeenCalledOnce());
        f.changes.get('one')!.get('interactiveChange')!();
        await f.view.open('session:two'); await vi.waitFor(() => expect(f.conversation).toHaveBeenCalledTimes(2));
        await f.view.open('session:one'); expect(f.conversation).toHaveBeenCalledTimes(2);
        f.sidebar.querySelector<HTMLButtonElement>('[data-action="create-file"]')!.click();
        await vi.waitFor(() => expect(f.command).toHaveBeenCalledWith('createConversation', expect.objectContaining({ folder: null })));
        await vi.waitFor(() => expect(f.conversation).toHaveBeenCalledTimes(3));
    } finally { await f.view.close(); }
    expect(f.listeners.size).toBe(0);
});
it('loads all directory pages and rejects unsupported mutations before sending a command', async () => {
    const f = fixture(), backend = new ApplicationFileBackend(f.application, { kind: 'workspace', name: 'notes' });
    f.query.mockImplementation(async (name, input) => name === 'directory'
        ? { entries: [{ path: input.offset ? '/b.md' : '/a.md' }], nextOffset: input.offset ? undefined : 200 } : null as never);
    expect((await backend.list('/')).map(node => node.path)).toEqual(['/a.md', '/b.md']);
    await expect(backend.delete('/a.md')).rejects.toMatchObject({ code: 'ECAPABILITY' });
    await expect(backend.write('/a.md', new Uint8Array())).rejects.toMatchObject({ code: 'ECAPABILITY' });
    expect(f.command).not.toHaveBeenCalled(); await backend.close();
});
it('mounts the standard document title bar with the HTTP file context', async () => {
    const f = fixture(); await f.view.start();
    let editor: IEditor | undefined;
    try {
        await f.view.open('/a.md'); await vi.waitFor(() => expect(f.file).toHaveBeenCalledOnce());
        const container = document.createElement('div'); document.body.append(container);
        editor = await defaultEditorFactory(container, { ...f.file.mock.calls[0][1], files: undefined, plugins: ['-ui:asset-manager'] });
        expect(container.querySelector<HTMLInputElement>('.mdx-editor-titlebar__title')?.value).toBe('a.md');
    } finally { await editor?.destroy(); await f.view.close(); }
});
it('does not refresh a hidden workspace and refreshes it when shown again', async () => {
    const f = fixture(); await f.view.start();
    try {
        await f.view.setVisible!(false); const calls = f.query.mock.calls.length;
        for (const listener of f.listeners) listener({ kind: 'invalidate', scope: 'files', revision: 1 });
        expect(f.query).toHaveBeenCalledTimes(calls);
        await f.view.setVisible!(true); expect(f.query.mock.calls.length).toBeGreaterThan(calls);
    } finally { await f.view.close(); }
});
