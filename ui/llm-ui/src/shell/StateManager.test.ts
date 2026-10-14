import { expect, it, vi } from 'vitest';
import { StateManager } from './StateManager';
import type { IChatInputPresenter } from '../domain/ports/IChatInputPresenter';
import type { StateService } from '../services/StateService';
import type { SessionViewPort } from '@itookit/llm-session/contracts';
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
    const input = { getConfig: () => ({ text, agentId: 'default', settings: {} }), setLoading: vi.fn(),
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
        setLoading: vi.fn(), restoreInput: (value: string) => { text = value; } }) as unknown as IChatInputPresenter);
    text = 'updated experiment';
    await manager.switchDraftBranch('main');
    expect(text).toBe('main draft');
    expect(drafts.get('experiment')).toBe('updated experiment');
    manager.cleanup(); await manager.waitForDrafts();
});

it('keeps Stop available when generation starts during branch draft restoration', async () => {
    let generating = false;
    const input = { getConfig: () => ({}), restoreInput: vi.fn(), setLoading: vi.fn() };
    const service = { saveUIState: async () => {}, loadUIState: async () => { generating = true; return {}; } };
    const manager = new StateManager(service as unknown as StateService, { isGenerating: () => generating } as SessionViewPort, 's', id => id);
    manager.setChatInputGetter(() => input as unknown as IChatInputPresenter);
    await manager.switchDraftBranch('experiment');
    expect(input.setLoading).toHaveBeenLastCalledWith(true);
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
        expect(input.setConfig).toHaveBeenLastCalledWith({ text: 'saved', agentId: 'saved-agent', settings: undefined });
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
