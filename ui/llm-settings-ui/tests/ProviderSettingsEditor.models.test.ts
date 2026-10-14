// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderSettingsEditor } from '../src/editors/ProviderSettingsEditor';
import type { LLMModel, LLMProvider } from '@itookit/driver-llm/contracts';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

function setup(models: LLMModel[]) {
    const listProviderModels = vi.fn();
    document.body.innerHTML = `<form><input name="baseURL" value="https://example.com/v1">
        <input name="apiKey" value="current-key"><button type="button">Refresh</button>
        <div id="model-list-container"></div></form>`;
    const editor = new ProviderSettingsEditor(document.createElement('div'), { listProviderModels } as never, {} as never);
    const state = editor as unknown as { editModels: LLMModel[]; editingProvider: LLMProvider;
        renderModelListHTML(): string; refreshModels(button: HTMLButtonElement, list: HTMLElement): Promise<void> };
    state.editModels = models;
    state.editingProvider = { id: 'custom', name: '', implementation: 'openai-compatible', baseURL: '', models: [] };
    const list = document.getElementById('model-list-container')!;
    list.innerHTML = state.renderModelListHTML();
    return { state, list, listProviderModels, button: document.querySelector('button')! };
}

it('preserves existing models and pending edits while appending unique API IDs with defaults', async () => {
    const existing = { id: 'existing', name: 'Custom', supportsVision: false, thinkingMode: 'disabled' as const };
    const { state, list, button, listProviderModels } = setup([existing]);
    list.querySelector<HTMLInputElement>('.model-name-input')!.value = 'Pending edit';
    listProviderModels.mockResolvedValue([{ id: 'existing', name: 'Remote replacement' },
        { id: 'new', name: 'new', category: 'chat', supportsVision: true, supportsThinking: true, supportsTools: true },
        { id: 'new', name: 'Duplicate' }]);
    await state.refreshModels(button, list);
    expect(listProviderModels.mock.calls[0][0]).toMatchObject({ baseURL: 'https://example.com/v1', apiKey: 'current-key' });
    expect(state.editModels[0]).toBe(existing);
    expect(existing).toEqual({ id: 'existing', name: 'Pending edit', supportsVision: false,
        thinkingMode: 'disabled', category: 'chat' });
    expect(state.editModels[1]).toEqual({ id: 'new', name: 'new', category: 'chat',
        supportsVision: true, supportsThinking: true, supportsTools: true });
    expect(state.editModels).toHaveLength(2);
    expect(list.querySelector('[data-cap="vision"]')).toBeNull();
    expect(button.disabled).toBe(false);
});

it('keeps the list after malformed responses and escapes remote IDs', async () => {
    const { state, list, button, listProviderModels } = setup([{ id: '<model"', name: '<script>' }]);
    expect(list.querySelector<HTMLInputElement>('.model-id-input')!.value).toBe('<model"');
    expect(list.querySelector('script')).toBeNull();
    listProviderModels.mockRejectedValue(new Error('Invalid model catalog response'));
    await state.refreshModels(button, list);
    expect(state.editModels).toHaveLength(1);
    expect(button.disabled).toBe(false);
});

it('edits and saves model preference, filters without losing edits and adds protocols on demand', async () => {
    const provider: LLMProvider = { id: 'gateway', name: 'Gateway', implementation: 'openai-compatible',
        baseURL: 'https://example.com', apiKey: 'stored', models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
    const saveProvider = vi.fn().mockResolvedValue(undefined);
    const service = { getProviders: () => [provider], getFullProvider: () => provider, saveProvider,
        listProviderModels: vi.fn().mockResolvedValue([{ id: 'a', name: 'Remote' }, { id: 'c', name: 'C', supportsVision: true }]) };
    const container = document.createElement('div'); document.body.append(container);
    const editor = new ProviderSettingsEditor(container, service as never,
        { target: { kind: 'entity', entityType: 'provider', id: provider.id } } as never);
    await editor.render();
    const add = container.querySelector<HTMLSelectElement>('#provider-add-protocol')!;
    add.value = 'anthropic-messages'; add.dispatchEvent(new Event('change', { bubbles: true }));
    const protocol = container.querySelector<HTMLSelectElement>('.model-protocol-select')!;
    protocol.value = 'anthropic-messages';
    const name = container.querySelector<HTMLInputElement>('.model-name-input')!;
    name.value = 'Pending A';
    const search = container.querySelector<HTMLInputElement>('#provider-model-search')!;
    search.value = 'b'; search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.querySelector<HTMLElement>('.settings-model-item')!.hidden).toBe(true);
    container.querySelector<HTMLButtonElement>('#btn-refresh-models')!.click();
    await vi.waitFor(() => expect(service.listProviderModels).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(container.querySelectorAll('.settings-model-item')).toHaveLength(3));
    expect(container.querySelector('.settings-page__actions .settings-btn--primary')).toBeNull();
    await vi.waitFor(() => expect(saveProvider).toHaveBeenCalled());
    expect(saveProvider.mock.calls.at(-1)![0]).toMatchObject({
        supportedProtocols: ['openai-chat', 'anthropic-messages'], defaultProtocol: 'openai-chat',
        models: [{ id: 'a', name: 'Pending A', preferredProtocol: 'anthropic-messages', supportsThinking: true },
            { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    });
});
