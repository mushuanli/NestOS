// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderSettingsEditor } from '../src/editors/ProviderSettingsEditor';
import type { LLMModel, LLMProvider } from '@itookit/driver-llm/contracts';

const operations: LLMModel['operations'] = {
    'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] },
};
const media: LLMProvider['media'] = { 'image.generate': { adapter: 'openai-images' } };
const editors: ProviderSettingsEditor[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
    for (const editor of editors.splice(0)) {
        await (editor as unknown as { discardAutoSave(): Promise<void> }).discardAutoSave();
        await editor.destroy();
    }
    vi.useRealTimers(); document.body.replaceChildren();
});
async function mount(implementation: LLMProvider['implementation'] = 'openai-compatible') {
    const provider: LLMProvider = { id: 'p', name: 'Provider', implementation, baseURL: 'https://example.test',
        apiKey: 'fixture', media, models: [{ id: 'a', name: 'A', operations }, { id: 'b', name: 'B' }] };
    const saveProvider = vi.fn().mockResolvedValue(undefined);
    const service = { getProviders: () => [provider], getFullProvider: async () => provider, saveProvider,
        onChange: () => () => {}, getProviderAuthorization: async () => ({ supported: false, status: 'signed-out' }) };
    const root = document.createElement('div'); document.body.append(root);
    const editor = new ProviderSettingsEditor(root, service as never, { target: { kind: 'entity', entityType: 'provider', id: 'p' } });
    editors.push(editor); await editor.render();
    return { root, saveProvider };
}
function input(root: HTMLElement, selector: string, value: string): void {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
}

it('preserves invalid operation drafts through search and reordering until corrected', async () => {
    const { root, saveProvider } = await mount();
    input(root, '[name="modelOperations"]', '{');
    input(root, '#provider-model-search', 'b');
    expect(root.querySelector<HTMLElement>('.settings-model-item')!.hidden).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>('[name="modelOperations"]')!.value).toBe('{');
    root.querySelectorAll<HTMLButtonElement>('.btn-up')[1].click();
    expect(root.querySelector<HTMLInputElement>('.model-id-input')!.value).toBe('b');
    const draft = root.querySelectorAll<HTMLTextAreaElement>('[name="modelOperations"]')[1];
    expect(draft.value).toBe('{');
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).not.toHaveBeenCalled();
    expect(root.querySelector('[data-autosave-status]')?.getAttribute('data-state')).toBe('invalid');
    input(root, '#provider-model-search', '');
    const corrected = { ...operations, 'image.generate': { ...operations!['image.generate']!, formats: ['jpeg'] } };
    input(root, '.settings-model-item:nth-child(2) [name="modelOperations"]', JSON.stringify(corrected));
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledOnce();
    expect(saveProvider.mock.calls[0][0].models).toMatchObject([{ id: 'b' }, { id: 'a', operations: corrected }]);
});

it('can delete a model with invalid operation JSON and save the remaining models', async () => {
    const { root, saveProvider } = await mount();
    input(root, '[name="modelOperations"]', '{');
    root.querySelector<HTMLButtonElement>('.btn-del')!.click();
    expect(root.querySelectorAll('.settings-model-item')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledOnce();
    expect(saveProvider.mock.calls[0][0].models).toMatchObject([{ id: 'b' }]);
});

it('keeps endpoint drafts editable while model navigation works and blocks invalid persistence', async () => {
    const { root, saveProvider } = await mount();
    input(root, '[name="mediaEndpoints"]', '{');
    input(root, '#provider-model-search', 'b');
    expect(root.querySelector<HTMLElement>('.settings-model-item')!.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('.btn-del')!.click();
    expect(root.querySelectorAll('.settings-model-item')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).not.toHaveBeenCalled();
    input(root, '[name="mediaEndpoints"]', JSON.stringify(media));
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledOnce();
    expect(saveProvider.mock.calls[0][0]).toMatchObject({ media, models: [{ id: 'b' }] });
});

it('hides and disables unsupported media declarations for a subscription provider', async () => {
    const { root, saveProvider } = await mount('chatgpt');
    const fields = root.querySelectorAll<HTMLTextAreaElement>('[name="mediaEndpoints"], [name="modelOperations"]');
    expect(fields).toHaveLength(3);
    for (const field of fields) {
        expect(field.disabled).toBe(true);
        expect(field.closest<HTMLElement>('[data-media-declaration]')!.hidden).toBe(true);
    }
    input(root, '[name="name"]', 'Renamed');
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledOnce();
    expect(saveProvider.mock.calls[0][0]).toMatchObject({ name: 'Renamed', media, models: [{ id: 'a', operations }, { id: 'b' }] });
});

it('excludes disabled drafts from saving and restores their validation when switching back', async () => {
    const { root, saveProvider } = await mount();
    input(root, '[name="mediaEndpoints"]', '{'); input(root, '[name="modelOperations"]', '{');
    const implementation = root.querySelector<HTMLSelectElement>('[name="implementation"]')!;
    implementation.value = 'chatgpt'; implementation.dispatchEvent(new Event('change', { bubbles: true }));
    input(root, '#provider-model-search', 'b');
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLTextAreaElement>('[name="modelOperations"]')!.disabled).toBe(true);
    implementation.value = 'openai-compatible'; implementation.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector<HTMLTextAreaElement>('[name="modelOperations"]')!.value).toBe('{');
    expect(root.querySelector<HTMLTextAreaElement>('[name="mediaEndpoints"]')!.value).toBe('{');
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-autosave-status]')?.getAttribute('data-state')).toBe('invalid');
    input(root, '[name="modelOperations"]', JSON.stringify(operations)); input(root, '[name="mediaEndpoints"]', JSON.stringify(media));
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledTimes(2);
});

it('retains the latest saved operations when switching to subscription authorization', async () => {
    const { root, saveProvider } = await mount();
    const updated = { 'image.generate': { ...operations!['image.generate']!, formats: ['jpeg'] } };
    input(root, '[name="modelOperations"]', JSON.stringify(updated));
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledOnce();
    const implementation = root.querySelector<HTMLSelectElement>('[name="implementation"]')!;
    implementation.value = 'chatgpt'; implementation.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(saveProvider).toHaveBeenCalledTimes(2);
    expect(saveProvider.mock.calls[1][0].models[0].operations).toEqual(updated);
});
