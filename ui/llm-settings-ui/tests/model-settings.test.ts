// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderSettingsEditor } from '../src/editors/ProviderSettingsEditor';
import { ConnectionSettingsEditor } from '../src/editors/ConnectionSettingsEditor';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import { t } from '@itookit/common';
import { readProviderForm } from '../src/editors/provider-form';

const editors: Array<ProviderSettingsEditor | ConnectionSettingsEditor> = [];
afterEach(async () => {
    for (const editor of editors.splice(0)) { await (editor as unknown as { discardAutoSave(): Promise<void> }).discardAutoSave(); await editor.destroy(); }
    vi.unstubAllGlobals(); document.body.replaceChildren();
});
function provider(): LLMProvider {
    return { id: 'p', name: 'Provider', implementation: 'custom', baseURL: 'https://example.test',
        media: { 'speech.synthesize': { adapter: 'doubao-speech' } }, models: [
            { id: 'speech', name: 'Speech', category: 'audio', operations: { 'speech.synthesize': { inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['voice'] } } },
            { id: 'text', name: 'Text', category: 'chat' } ] };
}
async function mount(p = provider()) {
    const testConnection = vi.fn().mockResolvedValue({ success: true, message: 'Verified', model: 'text' });
    const saveProvider = vi.fn().mockResolvedValue(undefined), getFullProvider = vi.fn(() => { throw new Error('Credentials must not be read'); });
    const service = { getProviders: () => [{ ...p, hasApiKey: true }], getFullProvider, saveProvider, testConnection,
        listProviderModels: vi.fn(), getConnections: async () => [], onChange: () => () => {}, getProviderAuthorization: async () => ({ supported: false, status: 'signed-out' }) };
    const root = document.createElement('div'); document.body.append(root);
    const editor = new ProviderSettingsEditor(root, service as never, { target: { kind: 'entity', entityType: 'provider', id: 'p' } }, {'speech.synthesize': {input: '你好'}});
    editors.push(editor); await editor.render();
    return { root, editor, service };
}

it('keeps stored credentials write-only and tests the chosen text model even when media is first', async () => {
    const { root, service } = await mount();
    expect(service.getFullProvider).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLInputElement>('[name="apiKey"]')!.value).toBe('');
    expect(root.querySelector<HTMLElement>('[data-provider-text-test]')!.hidden).toBe(false);
    expect([...root.querySelectorAll<HTMLOptionElement>('[name="connectionTestModel"] option')].map(option => option.value)).toEqual(['text']);
    root.querySelector<HTMLButtonElement>('#btn-test-provider')!.click();
    await vi.waitFor(() => expect(service.testConnection).toHaveBeenCalledOnce());
    expect(service.testConnection.mock.calls[0][0]).toMatchObject({ model: 'text', provider: 'p' });
    expect(service.testConnection.mock.calls[0][0].apiKey).toBeUndefined();
});

it('never sends a text request from a speech-only service and exposes a separate media verification', async () => {
    const p = provider(); p.models = p.models.slice(0, 1);
    const { root, service } = await mount(p);
    expect(root.querySelector<HTMLElement>('[data-provider-text-test]')!.hidden).toBe(true);
    expect(root.querySelector('.provider-settings__storage')!.closest('[hidden]')).not.toBeNull();
    expect(root.querySelector('#btn-test-provider')!.closest('[hidden]')).not.toBeNull();
    expect(root.querySelector('[name="apiKey"]')!.closest('[hidden]')).toBeNull();
    root.querySelector<HTMLButtonElement>('#btn-test-provider')!.click();
    expect(service.testConnection).not.toHaveBeenCalled();
    expect(root.querySelector('[data-probe-model] option')?.getAttribute('value')).toContain('speech.synthesize');
    expect(root.querySelector('[data-provider-chat-settings]')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>('[data-probe-input]')!.value).toBe('你好');
    root.querySelector<HTMLButtonElement>('[data-probe-run]')!.click();
    await vi.waitFor(() => expect(service.testConnection).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'speech.synthesize', request: expect.objectContaining({ input: '你好', model: 'speech' }),
    })));
});

it('updates text verification visibility when the last text model changes category', async () => {
    const { root } = await mount();
    const textTest = root.querySelector<HTMLElement>('[data-provider-text-test]')!;
    const category = root.querySelectorAll<HTMLSelectElement>('.model-category-select')[1];
    category.value = 'audio'; category.dispatchEvent(new Event('change', {bubbles: true}));
    expect(textTest.hidden).toBe(true);
    category.value = 'chat'; category.dispatchEvent(new Event('change', {bubbles: true}));
    expect(textTest.hidden).toBe(false);
    expect(root.querySelector<HTMLSelectElement>('[name="connectionTestModel"]')!.value).toBe('text');
});

it('disables unsupported catalog discovery and preserves the capability through form saves', async () => {
    const p = { ...provider(), modelsPath: false as const };
    const { root, service } = await mount(p), button = root.querySelector<HTMLButtonElement>('#btn-refresh-models')!;
    expect(button.disabled).toBe(true); expect(root.textContent).toContain(t('provider.models.unavailable'));
    button.click(); expect(service.listProviderModels).not.toHaveBeenCalled();
    const form = root.querySelector('form')!;
    expect(readProviderForm(form, p).modelsPath).toBe(false);
    const endpoint = form.querySelector<HTMLInputElement>('[name="modelsPath"]')!;
    endpoint.value = '/custom/catalog'; endpoint.dispatchEvent(new Event('input', { bubbles: true }));
    expect(button.disabled).toBe(false); expect(readProviderForm(form, p).modelsPath).toBe('/custom/catalog');
    endpoint.value = ''; endpoint.dispatchEvent(new Event('input', { bubbles: true }));
    expect(button.disabled).toBe(true);
});

it('preserves drafts when switching accessible tabs and invalidates an in-flight text result', async () => {
    const { root, service } = await mount();
    let finish!: (value: unknown) => void;
    service.testConnection.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    root.querySelector<HTMLButtonElement>('#btn-test-provider')!.click();
    await vi.waitFor(() => expect(service.testConnection).toHaveBeenCalledOnce());
    root.querySelector<HTMLButtonElement>('[data-provider-tab="models"]')!.click();
    const raw = root.querySelector<HTMLTextAreaElement>('[name="modelOperations"]')!;
    raw.value = '{'; raw.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-provider-tab="overview"]')!.click();
    finish({ success: true, message: 'Old success' });
    await vi.waitFor(() => expect(root.querySelector('#btn-test-provider')?.hasAttribute('disabled')).toBe(false));
    expect(raw.value).toBe('{');
    expect(root.querySelector('#provider-test-result')?.textContent).not.toContain('Old success');
    expect(root.querySelector('[data-provider-tab="overview"]')?.getAttribute('aria-selected')).toBe('true');
});

it('edits structured media fields without dropping advanced declarations', async () => {
    const { root } = await mount();
    const scope = root.querySelector('[data-media-declaration]')!;
    const voice = scope.querySelector<HTMLInputElement>('[data-media-operation="speech.synthesize"] [data-media-field="voices"]')!;
    voice.value = 'voice, other'; voice.dispatchEvent(new Event('input', { bubbles: true }));
    const raw = scope.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(JSON.parse(raw.value)['speech.synthesize']).toMatchObject({ formats: ['mp3'], voices: ['voice', 'other'] });
});

it('renders only the selected model and protocol reasoning choices', async () => {
    const p = provider(); p.models = [{ id: 'a', name: 'A', reasoning: { efforts: [{ id: 'low' }, { id: 'max' }], canDisable: true },
        reasoningByProtocol: { 'anthropic-messages': { efforts: [{ id: 'high' }] } } }, { id: 'b', name: 'B', reasoning: false }];
    p.supportedProtocols = ['openai-chat', 'anthropic-messages'];
    const c = { id: 'c', name: 'Connection', providerId: 'p', tiers: { optimal: 'a' } };
    const root = document.createElement('div'); document.body.append(root);
    const editor = new ConnectionSettingsEditor(root, { getProviders: () => [p], getConnections: async () => [c], getDefaultConnection: async () => null,
        getFullConnection: async () => c, saveConnection: vi.fn() } as never, { target: { kind: 'entity', entityType: 'connection', id: 'c' } });
    editors.push(editor); await editor.render();
    const choices = () => [...root.querySelectorAll<HTMLOptionElement>('[data-effort-tier="optimal"] option')].map(option => option.value);
    expect(choices()).toEqual(['', 'off', 'low', 'max']);
    const protocol = root.querySelector<HTMLSelectElement>('[name="protocol"]')!;
    protocol.value = 'anthropic-messages'; protocol.dispatchEvent(new Event('change', { bubbles: true }));
    expect(choices()).toEqual(['', 'high']);
    const model = root.querySelector<HTMLSelectElement>('[data-tier="optimal"]')!;
    model.value = 'b'; model.dispatchEvent(new Event('change', { bubbles: true }));
    expect(choices()).toEqual([]);
});


it('keeps raw and structured media edits in sync without losing focus or advanced values', async () => {
    const { root } = await mount();
    const scope = root.querySelector('[data-media-declaration]')!;
    const raw = scope.querySelector<HTMLTextAreaElement>('textarea')!;
    const value = JSON.parse(raw.value); value['speech.synthesize'].formats = ['opus'];
    value['speech.synthesize'].features = ['instructions']; raw.value = JSON.stringify(value);
    raw.dispatchEvent(new Event('input', { bubbles: true }));
    const voice = scope.querySelector<HTMLInputElement>('[data-media-operation="speech.synthesize"] [data-media-field="voices"]')!;
    voice.focus(); voice.value = 'other'; voice.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.activeElement).toBe(voice);
    expect(JSON.parse(raw.value)['speech.synthesize']).toMatchObject({ formats: ['opus'], voices: ['other'], features: ['instructions'] });
});
