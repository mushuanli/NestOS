// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { connectEditorLifecycle } from '../src/browser/editor-connector';

function fixture(chatFromFile?: import('@itookit/ui-common').EditorHostContext['chatFromFile']) {
    const events = new Map<string, (event: any) => Promise<void>>();
    const ui = { on: (name: string, callback: any) => { events.set(name, callback); return () => {}; },
        getNode: () => undefined, updateNodeMetadata: vi.fn() };
    const read = vi.fn(async (id: string) => id);
    const engine = { driver: { readContent: read } };
    const factory = vi.fn(async (mount: HTMLElement, options: any) => {
        mount.textContent = options.initialContent;
        return { destroy: vi.fn(async () => { mount.replaceChildren(); }), flushPendingSave: vi.fn(async () => {}), on: () => () => {} };
    });
    const container = document.createElement('div');
    const lifecycle = connectEditorLifecycle(ui as any, engine as any, container, factory as any, { hostContext: { chatFromFile } });
    const select = (id: string) => events.get('sessionSelected')!({ item: { id, type: 'file', metadata: { title: id, custom: { _extension: '.md' } } } });
    return { read, factory, container, lifecycle, select };
}

it('does not render a hidden read and reloads the requested file when visible again', async () => {
    const f = fixture(); let finish!: (text: string) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.select('/old');
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    await f.lifecycle.setVisible(false); finish('old body');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.factory).not.toHaveBeenCalled();
    await f.lifecycle.setVisible(true);
    await vi.waitFor(() => expect(f.container.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toBe('/old'));
    expect(f.read).toHaveBeenCalledTimes(2); await f.lifecycle();
});

it('isolates a late factory so its cleanup cannot erase the newer editor', async () => {
    const f = fixture(); let finish!: () => void;
    const destroyed = vi.fn();
    f.factory.mockImplementationOnce(async mount => {
        await new Promise<void>(resolve => { finish = resolve; });
        mount.textContent = 'obsolete';
        return { destroy: async () => { mount.replaceChildren(); destroyed(); } } as any;
    });
    await f.select('/old');
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    await f.select('/new');
    await vi.waitFor(() => expect(f.container.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toBe('/new'));
    finish(); await vi.waitFor(() => expect(destroyed).toHaveBeenCalledOnce());
    expect(f.container.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toBe('/new'); await f.lifecycle();
});

it('flushes on hide and retains the active editor if saving fails', async () => {
    const f = fixture(); await f.select('/edited');
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    const editor = await f.factory.mock.results[0].value;
    editor.flushPendingSave.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.lifecycle.setVisible(false)).rejects.toThrow('disk full');
    expect(editor.destroy).not.toHaveBeenCalled();
    await f.lifecycle.setVisible(true);
    expect(f.container.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toBe('/edited'); await f.lifecycle();
});

it('uses the editor save coordinator and retains the editor on a failed switch', async () => {
    const f = fixture(); await f.select('/draft');
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    const editor = await f.factory.mock.results[0].value;
    editor.flushPendingSave.mockRejectedValueOnce(new Error('disk full'));
    await f.select('/other');
    expect(editor.destroy).not.toHaveBeenCalled();
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.container.querySelector('.workbench-tabs__panel:not([hidden])')?.textContent).toContain('/draft');
    await f.select('/other');
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledTimes(2));
    expect(editor.destroy).toHaveBeenCalledOnce();
    await f.lifecycle();
});

it('passes the host chat capability through the generic editor connector', async () => {
    const chat = vi.fn(async () => {}), f = fixture(chat);
    try {
        await f.select('/note.md');
        await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
        expect(f.factory.mock.calls[0][1].hostContext.chatFromFile).toBe(chat);
    } finally { await f.lifecycle(); }
});
