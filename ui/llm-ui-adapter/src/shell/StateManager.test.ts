import { expect, it, vi } from 'vitest';
import { StateManager } from './StateManager';
import type { IChatInputPresenter } from '../domain/ports/IChatInputPresenter';
import type { StateService } from '../services/StateService';
import type { SessionViewPort } from '@itookit/llm-session/contracts';


it('saves visible history after reading legacy hidden preferences without changing the draft or collapse states', async () => {
    const service = {loadUIState: vi.fn(async () => ({history_visibility: 'hidden', input_text: 'Keep draft', collapse_states: {u: true}})), saveUIState: vi.fn(async () => {})};
    const manager = new StateManager(service as unknown as StateService, {isGenerating: () => false} as SessionViewPort, 's', id => id);
    const state = await manager.loadUIState(); expect(state?.input_text).toBe('Keep draft');
    await manager.saveUIState({text: 'Keep draft', agentId: 'default', settings: {}} as Parameters<StateManager['saveInputConfiguration']>[0]);
    expect(service.saveUIState).toHaveBeenCalledWith('s', expect.objectContaining({history_visibility: 'visible', input_text: 'Keep draft', collapse_states: {u: true}}), 'main');
    manager.cleanup();
});
it('restores Session mode even when navigation overrides the input text', () => {
    const manager = new StateManager({} as StateService, {} as SessionViewPort, 's', id => id);
    const input = { setConfig: vi.fn() } as unknown as IChatInputPresenter;
    manager.restoreInputState(input, { initialInputState: { text: 'new goal' }, sessionSettings: { executionMode: 'agent' } });
    expect(input.setConfig).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ executionMode: 'agent', flowId: undefined }) }));
    manager.restoreInputState(input, { initialInputState: { text: 'other session' } });
    expect(input.setConfig).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ executionMode: 'chat' }) }));
    manager.cleanup();
});
it('serializes rapid branch switches and preserves independent drafts before disposal', async () => {
    const drafts = new Map<string, string>([['experiment', 'experiment draft']]);
    let text = 'main draft';
    const input = { getConfig: () => ({ text, agentId: 'default', settings: {} }), setLoading: vi.fn(), setConfig: vi.fn(),
        restoreInput: vi.fn((value: string) => { text = value; }) };
    const service = { saveUIState: async (_id: string, state: { input_text?: string }, branch: string) => { if (state.input_text !== undefined) drafts.set(branch, state.input_text); },
        loadUIState: async (_id: string, branch: string) => ({ input_text: drafts.get(branch) }) };
    const manager = new StateManager(service as unknown as StateService, { isGenerating: () => false } as SessionViewPort, 's', id => id);
    manager.setChatInputGetter(() => input as unknown as IChatInputPresenter);
    await manager.switchDraftBranch('experiment'); expect(text).toBe('experiment draft');
    text = 'changed experiment';
    const first = manager.switchDraftBranch('main'), second = manager.switchDraftBranch('experiment');
    manager.cleanup(); await manager.waitForDrafts(); await Promise.all([first, second]);
    expect(text).toBe('changed experiment'); expect(drafts.get('main')).toBe('main draft');
    expect(input.setLoading).toHaveBeenLastCalledWith(false);
});

it('keeps a restored branch draft separate from main when a mount reloads the editor', async () => {
    const drafts = new Map<string, string>([['main', 'main draft'], ['experiment', 'restored experiment']]);
    let text = 'restored experiment';
    const service = {
        saveUIState: async (_id: string, state: { input_text?: string }, branch: string) => { if (state.input_text !== undefined) drafts.set(branch, state.input_text); },
        loadUIState: async (_id: string, branch: string) => ({ input_text: drafts.get(branch) }),
    };
    const manager = new StateManager(service as unknown as StateService, { isGenerating: () => false } as SessionViewPort, 's', id => id, 'experiment');
    manager.setChatInputGetter(() => ({ getConfig: () => ({ text, agentId: 'default', settings: {} }),
        setLoading: vi.fn(), setConfig: vi.fn(), restoreInput: (value: string) => { text = value; } }) as unknown as IChatInputPresenter);
    text = 'updated experiment';
    await manager.switchDraftBranch('main');
    expect(text).toBe('main draft');
    expect(drafts.get('experiment')).toBe('updated experiment');
    manager.cleanup(); await manager.waitForDrafts();
});

it('keeps Stop available when generation starts during branch draft restoration', async () => {
    let generating = false;
    const input = { getConfig: () => ({}), restoreInput: vi.fn(), setLoading: vi.fn(), setConfig: vi.fn() };
    const service = { saveUIState: async () => {}, loadUIState: async () => { generating = true; return {}; } };
    const manager = new StateManager(service as unknown as StateService, { isGenerating: () => generating } as SessionViewPort, 's', id => id);
    manager.setChatInputGetter(() => input as unknown as IChatInputPresenter);
    await manager.switchDraftBranch('experiment');
    expect(input.setLoading).toHaveBeenLastCalledWith(true);
    manager.cleanup();
});

it('restores the selected branch target without replacing the draft text or execution settings', async () => {
    const target = {kind: 'flow' as const, id: 'review', version: '2', digest: 'published'};
    const argumentsDraft = {revision: 3, target, targetId: 'review', json: '{"count":0}', signature: {id: 'review', revision: 2, digest: 'published'}};
    const input = {getConfig: () => ({text: 'Main draft', agentId: 'default', settings: {}}), setLoading: vi.fn(), restoreInput: vi.fn(), setConfig: vi.fn()};
    const service = {saveUIState: vi.fn(async () => {}), loadUIState: vi.fn(async () => ({input_text: 'Branch draft', input_target: target, input_arguments: argumentsDraft}))};
    const manager = new StateManager(service as unknown as StateService, {isGenerating: () => false} as SessionViewPort, 's', id => id);
    manager.setChatInputGetter(() => input as unknown as IChatInputPresenter);
    await manager.switchDraftBranch('review');
    expect(input.restoreInput).toHaveBeenCalledWith('Branch draft', undefined);
    expect(input.setConfig).toHaveBeenCalledWith({text: 'Branch draft', target, input: argumentsDraft});
    expect(service.saveUIState).toHaveBeenCalledWith('s', expect.objectContaining({input_text: 'Main draft'}), 'main');
    manager.cleanup();
});

it('preserves the old draft scope and refuses to replace a corrupt branch input with defaults', async () => {
    const input = {getConfig: () => ({text: 'Keep main input', agentId: 'default', settings: {}}), setLoading: vi.fn(), restoreInput: vi.fn(), setConfig: vi.fn()};
    const invalid = Object.assign(new Error('Invalid input draft'), {code: 'CALL_INPUT_DRAFT_INVALID'});
    const service = {saveUIState: vi.fn(async () => {}), loadUIState: vi.fn(async () => {throw invalid;})};
    const manager = new StateManager(service as unknown as StateService, {isGenerating: () => false} as SessionViewPort, 's', id => id);
    manager.setChatInputGetter(() => input as unknown as IChatInputPresenter);
    await expect(manager.switchDraftBranch('review')).rejects.toBe(invalid);
    expect(manager.getDraftBranch()).toBe('main'); expect(input.restoreInput).not.toHaveBeenCalled(); expect(input.setConfig).not.toHaveBeenCalled();
    manager.cleanup();
});


it('immediately serializes configuration snapshots against their original Session and retries failures', async () => {
    let finish!: () => void;
    const firstWrite = new Promise<void>(resolve => { finish = resolve; });
    const saved: unknown[] = [];
    const saveSessionSettings = vi.fn().mockImplementationOnce(() => firstWrite).mockResolvedValue(undefined);
    const service = { saveSessionSettings, saveUIState: vi.fn(async (id, state, branch) => { saved.push({ id, state, branch }); }) };
    const manager = new StateManager(service as unknown as StateService, { isGenerating: () => true } as SessionViewPort, 'original', id => id);
    const config = { text: 'draft', agentId: 'agent-a', settings: { connectionId: 'a' } };
    const first = manager.saveInputConfiguration(config);
    await Promise.resolve(); expect(saveSessionSettings).toHaveBeenCalledWith('original', { connectionId: 'a' });
    config.agentId = 'agent-b'; config.settings.connectionId = 'b';
    const second = manager.saveInputConfiguration(config);
    manager.cleanup(); expect(saveSessionSettings).toHaveBeenCalledOnce();
    finish(); await Promise.all([first, second]); await manager.waitForDrafts();
    expect(saved).toEqual([
        expect.objectContaining({ id: 'original', branch: 'main', state: expect.objectContaining({ input_agent_id: 'agent-a' }) }),
        expect.objectContaining({ id: 'original', branch: 'main', state: expect.objectContaining({ input_agent_id: 'agent-b' }) }),
    ]);
    await manager.saveInputConfiguration(config); expect(saveSessionSettings).toHaveBeenCalledTimes(2);
    config.settings.connectionId = 'retry'; saveSessionSettings.mockRejectedValueOnce(new Error('disk'));
    await expect(manager.saveInputConfiguration(config)).rejects.toThrow('disk');
    await manager.saveInputConfiguration(config); expect(saveSessionSettings).toHaveBeenLastCalledWith('original', { connectionId: 'retry' });
});

it('does not consume ambient host creation data while restoring a Session', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('Unexpected ambient creation state'); } });
    try {
        const manager = new StateManager({} as StateService, {} as SessionViewPort, 's', id => id);
        const input = { setConfig: vi.fn() } as unknown as IChatInputPresenter;
        manager.restoreInputState(input, { savedState: { input_text: 'saved', input_agent_id: 'saved-agent' } as never });
        expect(input.setConfig).toHaveBeenLastCalledWith({text: 'saved', agentId: 'saved-agent', target: undefined, input: undefined, settings: undefined});
    } finally { vi.unstubAllGlobals(); }
});

it('does not overwrite external draft updates when disposing an unchanged loaded configuration', async () => {
    const service = { saveSessionSettings: vi.fn(), saveUIState: vi.fn() };
    const manager = new StateManager(service as unknown as StateService, { isGenerating: () => false } as SessionViewPort, 's', id => id);
    const config = { text: 'loaded', agentId: 'default', settings: {} };
    manager.rememberRestoredConfiguration(config);
    await manager.saveInputConfiguration(config);
    expect(service.saveUIState).not.toHaveBeenCalled();
    await manager.saveInputConfiguration({ ...config, text: 'edited' });
    expect(service.saveUIState).toHaveBeenCalledWith('s', expect.objectContaining({ input_text: 'edited' }), 'main');
});
