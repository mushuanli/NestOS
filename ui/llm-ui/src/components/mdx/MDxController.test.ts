import { afterEach, expect, it, vi } from 'vitest';
import { createMDxEditor } from '@itookit/mdx-adapter';
import { MDxController } from './MDxController';
vi.mock('@itookit/mdx-adapter', () => ({ createMDxEditor: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });

function fixture() {
    const editor = { on: vi.fn(), destroy: vi.fn(), finishStreamingText: vi.fn(async () => {}) };
    let ready!: (value: typeof editor) => void;
    vi.mocked(createMDxEditor).mockReturnValue(new Promise(resolve => { ready = resolve as typeof ready; }) as never);
    const controller = new MDxController({} as HTMLElement, 'initial');
    return { editor, controller, ready: () => ready(editor) };
}

it('renders unchanged history only through the factory initial content', async () => {
    const f = fixture(); f.ready(); await f.controller.waitUntilReady();
    expect(createMDxEditor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialContent: 'initial' }));
    expect(f.editor.finishStreamingText).not.toHaveBeenCalled();
    f.controller.destroy();
});

it.each(['delta', 'empty', 'replacement'])('renders %s received before initialization completes', async change => {
    const f = fixture();
    if (change === 'delta') { f.controller.appendDelta(' delta'); await f.controller.finalize(); }
    else f.controller.setContent(change === 'empty' ? '' : 'replacement');
    f.ready(); await f.controller.waitUntilReady();
    await vi.waitFor(() => expect(f.editor.finishStreamingText).toHaveBeenCalledWith(
        change === 'delta' ? 'initial delta' : change === 'empty' ? '' : 'replacement'));
    f.controller.destroy();
});

it('disposes a late editor after the Session has closed', async () => {
    const f = fixture(); f.controller.destroy(); f.ready(); await f.controller.waitUntilReady();
    expect(f.editor.destroy).toHaveBeenCalledOnce();
    expect(f.editor.on).not.toHaveBeenCalled();
    expect(f.editor.finishStreamingText).not.toHaveBeenCalled();
});

it('keeps hidden content and streaming updates in memory until first reveal', async () => {
    const editor = { on: vi.fn(), destroy: vi.fn(), finishStreamingText: vi.fn() };
    vi.mocked(createMDxEditor).mockResolvedValue(editor as never);
    const controller = new MDxController({} as HTMLElement, 'old', { deferred: true });
    controller.setContent('new'); controller.appendDelta(' delta'); await controller.finalize();
    expect(controller.content).toBe('new delta');
    expect(createMDxEditor).not.toHaveBeenCalled();
    await Promise.all([controller.waitUntilReady(), controller.waitUntilReady()]);
    expect(createMDxEditor).toHaveBeenCalledOnce();
    expect(createMDxEditor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialContent: 'new delta' }));
    expect(editor.finishStreamingText).not.toHaveBeenCalled();
    controller.destroy();
});

it('initializes a hidden editor before editing and never initializes a destroyed one', async () => {
    const editor = { on: vi.fn(), destroy: vi.fn(), switchToMode: vi.fn(async () => {}), focus: vi.fn() };
    vi.mocked(createMDxEditor).mockResolvedValue(editor as never);
    const controller = new MDxController({} as HTMLElement, 'edit me', { deferred: true });
    await controller.toggleEdit();
    expect(controller.isEditing()).toBe(true);
    expect(editor.switchToMode).toHaveBeenCalledWith('edit');
    controller.destroy();
    const hidden = new MDxController({} as HTMLElement, 'closed', { deferred: true });
    hidden.destroy(); await hidden.waitUntilReady();
    expect(createMDxEditor).toHaveBeenCalledOnce();
});
