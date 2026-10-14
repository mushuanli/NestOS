// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { SessionDraftEditor } from '../../llm-ui/src/shell/drafts/SessionDraftEditor';
const state = vi.hoisted(() => ({ options: undefined as any, restore: vi.fn(), destroy: vi.fn() }));
vi.mock('../../llm-ui/src/shell/AgentProvider', () => ({ buildExecutorOptions: async () => [], buildConnectionOptions: async () => [] }));
vi.mock('../../llm-ui/src/components/input/ChatInputView', () => ({ ChatInput: class {
    constructor(_container: HTMLElement, options: unknown) { state.options = options; }
    focus() {} setLoading() {} restoreDraft = state.restore; destroy = state.destroy;
} }));

it('does not materialize while opening or on empty send; the first submitted payload reaches the real editor once', async () => {
    const sendMessage = vi.fn(async () => {});
    let finish!: (value: any) => void;
    const materialize = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
    const editor = new SessionDraftEditor(document.createElement('div'), {} as never, { sessionDraft: { materialize } });
    await editor.init(document.createElement('div'));
    expect(materialize).not.toHaveBeenCalled();
    await state.options.onSend('  ', [], 'default'); expect(materialize).not.toHaveBeenCalled();
    const sending = state.options.onSend('hello', [], 'writer', { connectionId: 'model-1' });
    await state.options.onSend('duplicate', [], 'writer');
    await Promise.resolve();
    expect(materialize).toHaveBeenCalledOnce();
    finish({ editor: { commands: { sendMessage } }, resumeOnly: false }); await sending;
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ text: 'hello', files: [], agentId: 'writer', overrides: { connectionId: 'model-1' } });
    await editor.destroy();
});

it('restores text, agent, options and binary attachments after reopening', async () => {
    const { DraftDataCodec } = await import('../../llm-ui/src/shell/drafts/session-draft-data');
    let stored = '';
    const bytes = new Map<string, ArrayBuffer>();
    const attachments = { put: vi.fn(async (data: ArrayBuffer) => { bytes.set('asset', data); return 'asset'; }),
        read: async (id: string) => bytes.get(id)! };
    const codec = new DraftDataCodec(attachments);
    const save = vi.fn(async (data: string) => { stored = data; });
    const config = { text: 'unsent text', agentId: 'writer', settings: { connectionId: 'model-2', temperature: 0.2 } };
    const file = new File([new Uint8Array([0, 255, 12])], 'sample.bin', { type: 'application/octet-stream', lastModified: 100 });
    const editor = new SessionDraftEditor(document.createElement('div'), {} as never, { sessionDraft: { materialize: vi.fn(), save, attachments } });
    await editor.init(document.createElement('div'));
    state.options.onDraftChange(config, [file]);
    await editor.destroy();
    expect((await codec.decode(stored)).config).toEqual(config);
    const restored = (await codec.decode(stored)).files[0];
    expect(JSON.parse(stored)).toMatchObject({ version: 2, files: [{ id: 'asset', name: 'sample.bin' }] });
    expect(stored).not.toContain('content');
    expect(new Uint8Array(bytes.get('asset')!)).toEqual(new Uint8Array([0, 255, 12]));
    await codec.encode({ ...config, text: 'changed' }, [restored]);
    expect(attachments.put).toHaveBeenCalledOnce();
    expect([restored.name, restored.size, restored.type, restored.lastModified]).toEqual(['sample.bin', 3, 'application/octet-stream', 100]);
    const next = new SessionDraftEditor(document.createElement('div'), {} as never, { sessionDraft: { materialize: vi.fn(), initialData: stored, attachments } });
    await next.init(document.createElement('div'));
    expect(state.options.initialConfig).toEqual(config);
    expect(state.restore).toHaveBeenLastCalledWith(config.text, expect.arrayContaining([expect.any(File)]), 'writer');
    await next.destroy();
});
it.each([true, false, undefined])('does not replace a draft merely on volatile admission (result %s)', async accepted => {
    const clear = vi.fn(async () => {}), save = vi.fn(async () => {});
    const materialize = vi.fn(async () => ({ editor: { commands: { sendMessage: async () => accepted } }, resumeOnly: false }) as any);
    const editor = new SessionDraftEditor(document.createElement('div'), {} as never, { sessionDraft: { materialize, save, clear } });
    await editor.init(document.createElement('div'));
    state.options.onDraftChange({ text: 'hello', agentId: 'writer', settings: {} }, []);
    await state.options.onSend('hello', [], 'writer');
    expect(save).toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    await editor.destroy();
});
it('opens a previously linked session without automatically replaying the message', async () => {
    const sendMessage = vi.fn(), clear = vi.fn();
    const materialize = vi.fn(async () => ({ editor: { commands: { sendMessage } }, resumeOnly: true }) as any);
    const editor = new SessionDraftEditor(document.createElement('div'), {} as never, { sessionDraft: { materialize, clear } });
    await editor.init(document.createElement('div'));
    await state.options.onSend('pending', [], 'writer');
    expect(materialize).toHaveBeenCalledOnce(); expect(sendMessage).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    await editor.destroy();
});

it('uses the normal empty-chat layout without a draft landing page', async () => {
    const container = document.createElement('div');
    const editor = new SessionDraftEditor(container, {} as never, { sessionDraft: { materialize: vi.fn() } });
    await editor.init(container);
    expect(container.querySelector<HTMLInputElement>('#llm-title-input')?.value).toBe('新会话');
    expect(container.querySelector('.llm-ui-workspace__history .llm-ui-welcome')).not.toBeNull();
    expect(container.querySelector('.llm-ui-workspace__input')).not.toBeNull();
    expect(container.querySelector('.session-draft')).toBeNull();
    expect(container.textContent).not.toMatch(/project\.(sessionDraftHint|draftDiscard)/);
    expect(container.querySelector('details:not([open]) .llm-workspace-titlebar__menu-actions')?.textContent).toBe('清空草稿');
    await editor.destroy();
});

it('carries only the originating draft identity into the first submitted message', async () => {
    const source = { id: 'submission-a', source: { kind: 'project-draft', ownerId: 'p', id: 'draft-a' } };
    const sendMessage = vi.fn(async () => true), clear = vi.fn();
    const options = { materialize: async () => {
        return { editor: { commands: { sendMessage } }, resumeOnly: false, submission: source } as any;
    }, clear };
    const editor = new SessionDraftEditor(document.createElement('div'), {} as never, { sessionDraft: options });
    await editor.init(document.createElement('div'));
    await state.options.onSend('hello', [], 'writer');
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'hello', submission: source }));
    expect(clear).not.toHaveBeenCalled();
    await editor.destroy();
});

it('migrates legacy base64 drafts to binary references when opened', async () => {
    let stored = '';
    const attachments = { put: vi.fn(async (_bytes: ArrayBuffer) => 'binary-id'), read: vi.fn() };
    const initialData = JSON.stringify({ version: 1, config: { text: 'legacy', agentId: 'default', settings: {} },
        files: [{ name: 'old.bin', type: 'application/octet-stream', lastModified: 1, content: 'AP8=' }] });
    const editor = new SessionDraftEditor(document.createElement('div'), {} as never, { sessionDraft: {
        initialData, attachments, save: async data => { stored = data; }, materialize: vi.fn(),
    } });
    await editor.init(document.createElement('div'));
    expect(new Uint8Array(attachments.put.mock.calls[0][0])).toEqual(new Uint8Array([0, 255]));
    expect(JSON.parse(stored)).toMatchObject({ version: 2, files: [{ id: 'binary-id' }] });
    expect(stored).not.toContain('AP8=');
    await editor.destroy();
});

it('retries failed binary writes without publishing an incomplete reference', async () => {
    const { DraftDataCodec } = await import('../../llm-ui/src/shell/drafts/session-draft-data');
    const attachments = { put: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue('retry-id'), read: vi.fn() };
    const codec = new DraftDataCodec(attachments);
    const file = new File(['bytes'], 'file.txt'), config = { text: 'draft', agentId: 'default', settings: {} };
    await expect(codec.encode(config, [file])).rejects.toThrow('disk full');
    expect(JSON.parse(await codec.encode(config, [file]))).toMatchObject({ files: [{ id: 'retry-id' }] });
    expect(attachments.put).toHaveBeenCalledTimes(2);
});

it('routes a remote harness directly without materializing a local Session', async () => {
    const materialize=vi.fn(),send=vi.fn(async () => {}),clear=vi.fn(async () => {});
    const editor=new SessionDraftEditor(document.createElement('div'),{} as never,{sessionDraft:{materialize,clear},remoteAgents:{list:async () => [],send}});
    await editor.init(document.createElement('div'));await state.options.onSend('remote prompt',[],'remote:codex');
    expect(send).toHaveBeenCalledWith('remote:codex','remote prompt');expect(materialize).not.toHaveBeenCalled();expect(clear).toHaveBeenCalledOnce();await editor.destroy();
});

it('rejects remote attachments before creating or sending a native conversation', async () => {
    const materialize=vi.fn(),send=vi.fn();
    const editor=new SessionDraftEditor(document.createElement('div'),{} as never,{sessionDraft:{materialize},remoteAgents:{list:async () => [],send}});
    await editor.init(document.createElement('div'));
    await expect(state.options.onSend('remote prompt',[new File(['data'],'file.txt')],'remote:codex')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();expect(materialize).not.toHaveBeenCalled();await editor.destroy();
});
