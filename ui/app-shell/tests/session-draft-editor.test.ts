// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { SessionDraftEditor } from '../../llm-ui-adapter/src/shell/drafts/SessionDraftEditor';
const state = vi.hoisted(() => ({selection: undefined as {modelId: string; reasoningEffort?: string} | undefined, options: undefined as any, restore: vi.fn(), destroy: vi.fn(), refreshAgents: vi.fn() }));

it('roundtrips a precise context draft and keeps the saved checkpoint independent from later caller edits', async () => {
    const {DraftDataCodec} = await import('../../llm-ui-adapter/src/shell/drafts/session-draft-data');
    const context = {revision: 1, sessionId: 'session', branchId: 'main', target: {kind: 'agent' as const, id: 'worker', version: '1', digest: 'published'},
        selection: {mode: 'fork' as const, sourceBindingId: 'binding', expectedBindingRevision: 2, expectedGeneration: 1, checkpointRef: 'checkpoint-A'}};
    const codec = new DraftDataCodec(), encoded = await codec.encode({text: 'Keep', agentId: 'worker', settings: {}, context}, []);
    context.selection.checkpointRef = 'checkpoint-B';
    expect((await codec.decode(encoded)).config?.context).toMatchObject({revision: 1, selection: {checkpointRef: 'checkpoint-A'}});
});

vi.mock('../../llm-ui-adapter/src/shell/AgentProvider', () => ({ buildExecutorOptions: async () => [], buildConnectionOptions: async () => [] }));
vi.mock('../../llm-ui-adapter/src/components/input/ChatInputView', () => ({ ChatInput: class {
    private config = {text: '', agentId: 'default', settings: {}};
    constructor(_container: HTMLElement, options: any) { state.options = options; Object.assign(this.config, options.initialConfig); }
    getConfig() {return this.config;} setConfig(value: object) {Object.assign(this.config, value);}
    getNativeModelSelection() {return state.selection ? {...state.selection} : undefined;}
    focus() {} setLoading() {} refreshConnections() {} cancelPendingSend() {} refreshAgents = state.refreshAgents; restoreDraft = state.restore; destroy = state.destroy;
} }));

it('refreshes Agent availability from the shared configuration and defers hidden updates until activation', async () => {
    let changed!: () => void;
    const unsubscribe = vi.fn(); state.refreshAgents.mockClear();
    const configuration = { getConfigurationSnapshot: () => ({}), subscribe: (listener: () => void) => { changed = listener; return unsubscribe; } };
    const editor = new SessionDraftEditor(document.createElement('div'), { onChange: vi.fn(() => () => {}) } as never,
        { sessionDraft: { materialize: vi.fn() } }, undefined, undefined, { configuration } as never);
    await editor.init(document.createElement('div'));
    changed(); await vi.waitFor(() => expect(state.refreshAgents).toHaveBeenCalledOnce());
    editor.cancelPendingRender(); changed(); await Promise.resolve(); expect(state.refreshAgents).toHaveBeenCalledOnce();
    await editor.activate(); expect(state.refreshAgents).toHaveBeenCalledTimes(2);
    await editor.destroy(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it('does not materialize while opening or on empty send; the first submitted payload reaches the real editor once', async () => {
    const sendMessage = vi.fn(async () => {});
    let finish!: (value: any) => void;
    const materialize = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
    const mount = document.createElement('div');
    const editor = new SessionDraftEditor(mount, {onChange: () => () => {}} as never, { sessionDraft: { materialize } });
    await editor.init(mount);
    expect(materialize).not.toHaveBeenCalled();
    await state.options.onSend('  ', [], 'default'); expect(materialize).not.toHaveBeenCalled();
    const sending = state.options.onSend('hello', [], 'writer', { connectionId: 'model-1' });
    await state.options.onSend('duplicate', [], 'writer');
    await Promise.resolve();
    expect(materialize).toHaveBeenCalledOnce();
    expect(mount.querySelector('.llm-ui-welcome')).toBeNull();
    expect(mount.querySelector('.llm-ui-header-preview')?.textContent).toBe('hello');
    finish({ editor: { commands: { sendMessage } }, resumeOnly: false }); await sending;
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ text: 'hello', files: [], agentId: 'writer', overrides: { connectionId: 'model-1' } });
    await editor.destroy();
});

it.each([undefined, ''])('keeps the selected Flow on a programmatic first send with Agent identity %s', async agentId => {
    const target = {kind: 'flow', id: 'worker', version: '1', digest: 'published'};
    const config = {text: '', agentId: '', target, settings: {}};
    const initialData = JSON.stringify({version: 2, config, files: []});
    const sendMessage = vi.fn(async () => true), materialize = vi.fn(async () => ({editor: {commands: {sendMessage}}, resumeOnly: false}));
    const mount = document.createElement('div');
    const editor = new SessionDraftEditor(mount, {onChange: () => () => {}} as never,
        {sessionDraft: {initialData, materialize}} as never);
    await editor.init(mount);
    await editor.commands.sendMessage({text: '', files: [], agentId});
    expect(materialize).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({text: '', files: [], agentId: '', target});
    await editor.destroy();
});

it('reopens a promoted project draft with a fresh save cursor after another browser submitted it', async () => {
    const save = vi.fn(async () => {}), nextSave = vi.fn(async () => {});
    const next = {initialData: '', save: nextSave, materialize: vi.fn()};
    const refresh = vi.fn(async () => next);
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never,
        {sessionDraft: {initialData: '', save, refresh, materialize: vi.fn()}});
    await editor.init(document.createElement('div')); await editor.activate();
    state.options.onDraftChange({text: 'Next conversation', agentId: 'default', settings: {}}, []);
    await editor.flushPendingSave(); expect(nextSave).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled(); await editor.destroy();
});

it('shares activation and promotion refreshes without replacing the draft editor twice', async () => {
    let finish!: (value: any) => void;
    const pending = new Promise<any>(resolve => {finish = resolve;}), refresh = vi.fn(() => pending), save = vi.fn();
    const next = {initialData: '', save, materialize: vi.fn()};
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never,
        {sessionDraft: {refresh, materialize: vi.fn()}});
    await editor.init(document.createElement('div')); const render = vi.spyOn(editor, 'render');
    const active = editor.activate(), promoted = editor.commands.refreshDraft();
    finish(next); await Promise.all([active, promoted]);
    expect(refresh).toHaveBeenCalledOnce(); expect(render).toHaveBeenCalledOnce();
    state.options.onDraftChange({text: 'Keep successor input', agentId: 'default', settings: {}}, []);
    await editor.flushPendingSave(); expect(save).toHaveBeenCalledOnce(); await editor.destroy();
});

it('preserves edits made while checking for a promoted draft instead of replacing the input', async () => {
    let finish!: (value: any) => void;
    const nextSave = vi.fn(), refresh = vi.fn(() => new Promise<any>(resolve => {finish = resolve;}));
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never,
        {sessionDraft: {save: async () => {}, refresh, materialize: vi.fn()}});
    await editor.init(document.createElement('div')); const active = editor.activate();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    state.options.onDraftChange({text: 'Keep new typing', agentId: 'default', settings: {}}, []); await editor.flushPendingSave();
    finish({initialData: '', save: nextSave, materialize: vi.fn()}); await active;
    state.options.onDraftChange({text: 'Still my draft', agentId: 'default', settings: {}}, []); await editor.flushPendingSave();
    expect(nextSave).not.toHaveBeenCalled(); await editor.destroy();
});

it('restores text, agent, options and binary attachments after reopening', async () => {
    const { DraftDataCodec } = await import('../../llm-ui-adapter/src/shell/drafts/session-draft-data');
    let stored = '';
    const bytes = new Map<string, ArrayBuffer>();
    const attachments = { put: vi.fn(async (data: ArrayBuffer) => { bytes.set('asset', data); return 'asset'; }),
        read: async (id: string) => bytes.get(id)! };
    const codec = new DraftDataCodec(attachments);
    const save = vi.fn(async (data: string) => { stored = data; });
    const config = { text: 'unsent text', agentId: 'writer', settings: { connectionId: 'model-2', temperature: 0.2 } };
    const file = new File([new Uint8Array([0, 255, 12])], 'sample.bin', { type: 'application/octet-stream', lastModified: 100 });
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never, { sessionDraft: { materialize: vi.fn(), save, attachments } });
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
    const next = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never, { sessionDraft: { materialize: vi.fn(), initialData: stored, attachments } });
    await next.init(document.createElement('div'));
    expect(state.options.initialConfig).toEqual(config);
    expect(state.restore).toHaveBeenLastCalledWith(config.text, expect.arrayContaining([expect.any(File)]), 'writer');
    await next.destroy();
});
it.each([true, false, undefined])('does not replace a draft merely on volatile admission (result %s)', async accepted => {
    const clear = vi.fn(async () => {}), save = vi.fn(async () => {});
    const materialize = vi.fn(async () => ({ editor: { commands: { sendMessage: async () => accepted } }, resumeOnly: false }) as any);
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never, { sessionDraft: { materialize, save, clear } });
    await editor.init(document.createElement('div'));
    state.options.onDraftChange({ text: 'hello', agentId: 'writer', settings: {} }, []);
    await state.options.onSend('hello', [], 'writer');
    expect(save).toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    await editor.destroy();
});
it('opens a previously linked session without automatically replaying the message', async () => {
    const sendMessage = vi.fn(), clear = vi.fn();
    const materialize = vi.fn(async () => ({ editor: { commands: { sendMessage } }, resumeOnly: true }) as any);
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never, { sessionDraft: { materialize, clear } });
    await editor.init(document.createElement('div'));
    await state.options.onSend('pending', [], 'writer');
    expect(materialize).toHaveBeenCalledOnce(); expect(sendMessage).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    await editor.destroy();
});

it('uses the normal empty-chat layout without a draft landing page', async () => {
    const container = document.createElement('div');
    const editor = new SessionDraftEditor(container, {onChange: () => () => {}} as never, { sessionDraft: { materialize: vi.fn() } });
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
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never, { sessionDraft: options });
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
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never, { sessionDraft: {
        initialData, attachments, save: async data => { stored = data; }, materialize: vi.fn(),
    } });
    await editor.init(document.createElement('div'));
    expect(new Uint8Array(attachments.put.mock.calls[0][0])).toEqual(new Uint8Array([0, 255]));
    expect(JSON.parse(stored)).toMatchObject({ version: 2, files: [{ id: 'binary-id' }] });
    expect(stored).not.toContain('AP8=');
    await editor.destroy();
});

it('retries failed binary writes without publishing an incomplete reference', async () => {
    const { DraftDataCodec } = await import('../../llm-ui-adapter/src/shell/drafts/session-draft-data');
    const attachments = { put: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue('retry-id'), read: vi.fn() };
    const codec = new DraftDataCodec(attachments);
    const file = new File(['bytes'], 'file.txt'), config = { text: 'draft', agentId: 'default', settings: {} };
    await expect(codec.encode(config, [file])).rejects.toThrow('disk full');
    expect(JSON.parse(await codec.encode(config, [file]))).toMatchObject({ files: [{ id: 'retry-id' }] });
    expect(attachments.put).toHaveBeenCalledTimes(2);
});

it('routes a remote harness directly without materializing a local Session', async () => {
    const materialize=vi.fn(),send=vi.fn(async () => {}),clear=vi.fn(async () => {});
    const editor=new SessionDraftEditor(document.createElement('div'),{onChange: () => () => {}} as never,{sessionDraft:{materialize,clear},remoteAgents:{list:async () => [],send}});
    await editor.init(document.createElement('div'));await state.options.onSend('remote prompt',[],'remote:codex');
    expect(send).toHaveBeenCalledWith('remote:codex','remote prompt');expect(materialize).not.toHaveBeenCalled();expect(clear).toHaveBeenCalledOnce();await editor.destroy();
});

it('captures the first native model choice before waiting for a draft save', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {finish = resolve;});
    const save = vi.fn(async () => {}).mockImplementationOnce(() => pending), send = vi.fn(async () => {});
    state.selection = {modelId: 'original', reasoningEffort: 'high'};
    const editor = new SessionDraftEditor(document.createElement('div'), {onChange: () => () => {}} as never,
        {sessionDraft: {materialize: vi.fn(), save}, remoteAgents: {list: async () => [], send}});
    await editor.init(document.createElement('div'));
    try {
        state.options.onDraftChange({text: 'Prompt', agentId: 'remote:codex', settings: {}}, []);
        const sending = state.options.onSend('Prompt', [], 'remote:codex');
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        state.selection = {modelId: 'next', reasoningEffort: 'low'}; finish();
        await sending;
        expect(send).toHaveBeenCalledWith('remote:codex', 'Prompt', {modelId: 'original', reasoningEffort: 'high'});
    } finally {state.selection = undefined; await editor.destroy();}
});

it('rejects remote attachments before creating or sending a native conversation', async () => {
    const materialize=vi.fn(),send=vi.fn();
    const editor=new SessionDraftEditor(document.createElement('div'),{onChange: () => () => {}} as never,{sessionDraft:{materialize},remoteAgents:{list:async () => [],send}});
    await editor.init(document.createElement('div'));
    await expect(state.options.onSend('remote prompt',[new File(['data'],'file.txt')],'remote:codex')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();expect(materialize).not.toHaveBeenCalled();await editor.destroy();
});

it.each(['missing', 'throws'])('submits a draft when native UUID support %s', async mode => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: original.getRandomValues.bind(original),
        ...(mode === 'throws' ? {randomUUID: () => {throw new Error('HTTP WebView');}} : {})});
    const sendMessage = vi.fn(async () => {}), mount = document.createElement('div');
    const editor = new SessionDraftEditor(mount, {onChange: () => () => {}} as never,
        {sessionDraft: {materialize: async () => ({editor: {commands: {sendMessage}} as never, resumeOnly: false})}});
    try { await editor.init(mount); await state.options.onSend('hello', [], 'default'); expect(sendMessage).toHaveBeenCalledOnce(); }
    finally {await editor.destroy(); vi.unstubAllGlobals();}
});
