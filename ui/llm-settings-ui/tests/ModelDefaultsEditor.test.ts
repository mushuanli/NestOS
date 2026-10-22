// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ModelDefaultsEditor } from '../src/editors/ModelDefaultsEditor';
import { t } from '@itookit/common';
import type { OcrControls } from '@itookit/ui-common';
import type { MediaProbeExamples } from '@itookit/kernel-adapters/contracts';

afterEach(() => { document.body.replaceChildren(); });
function fixture(ocr?: OcrControls, examples: MediaProbeExamples = {'speech.synthesize': {input: '你好'}}) {
    const provider = { id: 'p', name: '<Provider>', implementation: 'openai-compatible', media: {
        'image.generate': { adapter: 'openai-images' }, 'speech.synthesize': { adapter: 'openai-speech' },
    }, models: [{ id: 'chat', name: 'Chat' }, { id: 'image', name: 'Picture', category: 'image', operations: {
        'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] },
    } }, { id: 'speech', name: 'Speech', category: 'audio', operations: {
        'speech.synthesize': { inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['alloy'] },
    } }] };
    let defaults: Record<string, string> = { chat: 'chat', 'image.generate': 'image', 'speech.synthesize': 'speech' };
    const connections = ['chat', 'image', 'speech'].map(model => ({ id: model, name: model, model, providerId: 'p', credentialsReady: true, enabled: true }));
    const service = { getProviders: () => [provider], getConnections: async () => connections, getModelDefaults: async () => ({ ...defaults }),
        setModelDefault: vi.fn(async (operation: string, id: string | null) => { if (id) defaults[operation] = id; else delete defaults[operation]; }),
        testConnection: vi.fn(async () => ({ success: true, message: 'verified', model: 'chat' })) };
    const root = document.createElement('div'); document.body.append(root);
    const navigate = vi.fn(async () => {});
    const editor = new ModelDefaultsEditor(root, service as never, { hostContext: { navigate } } as never, ocr, examples);
    return { editor, root, service, connections, navigate, defaults: (value: Record<string, string>) => { defaults = value; } };
}

it('separates compatible models by purpose and does not run a paid probe when saving', async () => {
    const f = fixture(); await f.editor.init(f.root);
    const options = (operation: string) => [...f.root.querySelectorAll<HTMLOptionElement>(`[data-default-operation="${operation}"] option`)].map(item => item.value);
    expect(options('chat')).toEqual(['', 'chat']); expect(options('image.generate')).toEqual(['', 'image']); expect(options('speech.synthesize')).toEqual(['', 'speech']);
    expect(f.root.innerHTML).not.toContain('<Provider>');
    const select = f.root.querySelector<HTMLSelectElement>('[data-default-operation="image.generate"]')!;
    select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); await f.editor.flushPendingSave();
    expect(f.service.setModelDefault).toHaveBeenCalledWith('image.generate', null);
    expect(f.service.testConnection).not.toHaveBeenCalled(); expect(f.root.textContent).toContain(t('modelDefaults.saved'));
    await f.editor.destroy();
});

it('retains a stale selection visibly and explains credential and persistence failures', async () => {
    const f = fixture(); f.defaults({ chat: 'removed' }); f.connections[1].credentialsReady = false;
    await f.editor.init(f.root);
    expect(f.root.querySelector<HTMLSelectElement>('[data-default-operation="chat"]')?.value).toBe('removed');
    expect(f.root.textContent).toContain(t('modelDefaults.credentials'));
    f.service.setModelDefault.mockRejectedValueOnce(new Error('storage quota exceeded'));
    const select = f.root.querySelector<HTMLSelectElement>('[data-default-operation="chat"]')!;
    select.value = 'chat'; select.dispatchEvent(new Event('change', { bubbles: true })); await f.editor.flushPendingSave();
    expect(select.value).toBe('removed'); expect(f.root.textContent).toContain('storage quota exceeded');
    await f.editor.destroy();
});

it('verifies chat explicitly and navigates management to the shared toolbox editors', async () => {
    const f = fixture(); await f.editor.init(f.root);
    f.root.querySelector<HTMLButtonElement>('[data-chat-probe]')!.click();
    await vi.waitFor(() => expect(f.root.textContent).toContain('verified'));
    expect(f.root.querySelector('[data-purpose="chat"] .model-defaults__status')?.textContent).toBe(t('modelDefaults.verified'));
    expect(f.service.testConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: 'p', model: 'chat' }));
    f.root.querySelector<HTMLButtonElement>('[data-manage="providers"]')!.click();
    expect(f.navigate).toHaveBeenCalledWith({ target: 'toolbox', resourceId: '/providers' });
    await f.editor.navigateToAnchor('speech.synthesize');
    expect(document.activeElement).toBe(f.root.querySelector('[data-default-operation="speech.synthesize"]'));
    await f.editor.destroy();
});

it('shows request identifiers and specific network failures from the shared probe diagnostics', async () => {
    const f = fixture(); f.service.testConnection.mockResolvedValueOnce({ success: false, message: 'TLS certificate rejected',
        operation: 'chat', model: 'chat', requestId: 'request-test', code: 'NETWORK_ERROR', latency: 15 } as never);
    await f.editor.init(f.root); f.root.querySelector<HTMLButtonElement>('[data-chat-probe]')!.click();
    await vi.waitFor(() => expect(f.root.textContent).toContain('TLS certificate rejected'));
    expect(f.root.textContent).toContain('request-test'); expect(f.root.textContent).toContain('15 ms');
    await f.editor.destroy();
});

it('uses host examples for both media operations without starting a test', async () => {
    const f = fixture(undefined, {'image.generate': {input: 'Example picture'}, 'speech.synthesize': {input: 'Example speech'}});
    await f.editor.init(f.root);
    expect(f.root.querySelector<HTMLTextAreaElement>('[data-purpose="image.generate"] [data-probe-input]')!.value).toBe('Example picture');
    expect(f.root.querySelector<HTMLTextAreaElement>('[data-purpose="speech.synthesize"] [data-probe-input]')!.value).toBe('Example speech');
    expect(f.service.testConnection).not.toHaveBeenCalled(); await f.editor.destroy();
});

it('preserves verification input across unchanged service notifications and scopes speech verification to speech', async () => {
    const f = fixture(); await f.editor.init(f.root);
    const root = f.root.querySelector<HTMLElement>('[data-purpose="speech.synthesize"]')!;
    const input = root.querySelector<HTMLTextAreaElement>('[data-probe-input]')!;
    expect(input.value).toBe('你好');
    expect(f.root.querySelector<HTMLTextAreaElement>('[data-purpose="image.generate"] [data-probe-input]')!.value).toBe('');
    input.value = 'private verification draft';
    await f.editor.render();
    expect(root.querySelector('[data-probe-input]')).toBe(input);
    expect(input.value).toBe('private verification draft');
    expect([...root.querySelectorAll<HTMLOptionElement>('[data-probe-model] option')].map(option => option.value)).toEqual(['speech:speech.synthesize']);
    await f.editor.destroy();
});

it('retries a failed settings read without installing an empty default map', async () => {
    const f = fixture(); vi.spyOn(f.service, 'getModelDefaults').mockRejectedValueOnce(new Error('settings read unavailable'));
    await f.editor.init(f.root); expect(f.root.textContent).toContain('settings read unavailable');
    f.root.querySelector('button')!.click();
    await vi.waitFor(() => expect(f.root.querySelector<HTMLSelectElement>('[data-default-operation="chat"]')?.value).toBe('chat'));
    expect(f.service.setModelDefault).not.toHaveBeenCalled(); await f.editor.destroy();
});

function ocrFixture() {
    const listeners = new Set<() => void>();
    const state = { value: { connectionId: 'vision' as string | undefined }, connections: [
        { id: '', label: 'Unset' }, { id: 'vision', label: '<Vision>', supported: true },
        { id: 'no-key', label: 'Vision · missing credentials', supported: true, disabled: true },
        { id: 'text', label: 'Text only', supported: false, disabled: true },
    ] };
    const controls = { readSettings: vi.fn(async () => structuredClone(state)),
        saveSettings: vi.fn(async (value: { connectionId?: string }) => { state.value = value; listeners.forEach(listener => listener()); }),
        openSettings: vi.fn(async () => {}), configure: vi.fn(async () => true), recognize: vi.fn(async () => ''), label: async () => '',
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    return { controls, state, notify: () => listeners.forEach(listener => listener()), listeners };
}

it('selects the OCR default inline and opens its prompt only from the adjacent icon', async () => {
    const ocr = ocrFixture(), f = fixture(ocr.controls); await f.editor.init(f.root);
    const select = f.root.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!;
    expect([...select.options].map(option => option.value)).toEqual(['', 'vision', 'no-key']);
    expect(select.options[2].disabled).toBe(true); expect(select.value).toBe('vision');
    expect(f.root.querySelector('Vision')).toBeNull(); expect(f.root.querySelector('textarea[data-ocr-prompt]')).toBeNull();
    select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); await f.editor.flushPendingSave();
    expect(ocr.controls.saveSettings).toHaveBeenCalledWith({ connectionId: undefined });
    expect(f.service.setModelDefault).not.toHaveBeenCalled(); expect(f.service.testConnection).not.toHaveBeenCalled();
    expect(ocr.controls.openSettings).not.toHaveBeenCalled();
    const button = f.root.querySelector<HTMLButtonElement>('[data-ocr-open="prompt"]')!;
    expect(button.textContent).toBe(''); expect(button.getAttribute('aria-label')).toBe(t('ocr.editPrompt'));
    button.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ocr.controls.openSettings).toHaveBeenCalledWith('prompt'); expect(ocr.controls.configure).not.toHaveBeenCalled();
    await f.editor.destroy(); expect(ocr.listeners.size).toBe(0);
});

it('preserves failed OCR drafts across model refreshes and blocks closing until saved', async () => {
    const ocr = ocrFixture(), f = fixture(ocr.controls); await f.editor.init(f.root);
    ocr.controls.saveSettings.mockRejectedValueOnce(new Error('Disk unavailable'));
    const select = f.root.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!;
    select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
    await expect(f.editor.flushPendingSave()).rejects.toThrow('Disk unavailable');
    expect(f.editor.isDirty()).toBe(true); await expect(f.editor.destroy()).rejects.toThrow('Disk unavailable');
    expect(select.value).toBe(''); expect(select.disabled).toBe(false); expect(ocr.state.value.connectionId).toBe('vision');
    f.defaults({ chat: 'chat' }); await f.editor.render(); ocr.notify();
    expect(f.root.querySelector('[name="ocr-connection"]')).toBe(select); expect(f.root.textContent).toContain('Disk unavailable');
    select.dispatchEvent(new Event('change', { bubbles: true })); await f.editor.flushPendingSave();
    expect(ocr.state.value.connectionId).toBeUndefined(); expect(f.editor.isDirty()).toBe(false); await f.editor.destroy();
});

it('refreshes the OCR selection from shared changes and retains incompatible saved references', async () => {
    const ocr = ocrFixture(), f = fixture(ocr.controls); await f.editor.init(f.root);
    ocr.state.value.connectionId = 'text'; ocr.notify();
    await vi.waitFor(() => expect(f.root.querySelector<HTMLSelectElement>('[name="ocr-connection"]')?.value).toBe('text'));
    const select = f.root.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!;
    expect(select.selectedOptions[0].disabled).toBe(true);
    await f.editor.navigateToAnchor('ocr'); expect(document.activeElement).toBe(select);
    await f.editor.destroy();
});

it('retries OCR configuration reads in place without rewriting any defaults', async () => {
    const ocr = ocrFixture(); ocr.controls.readSettings.mockRejectedValueOnce(new Error('OCR service offline'));
    const f = fixture(ocr.controls); await f.editor.init(f.root);
    expect(f.root.textContent).toContain('OCR service offline');
    f.root.querySelector<HTMLButtonElement>('[data-ocr-retry]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector<HTMLSelectElement>('[name="ocr-connection"]')?.value).toBe('vision'));
    expect(ocr.controls.saveSettings).not.toHaveBeenCalled(); expect(f.service.setModelDefault).not.toHaveBeenCalled();
    await f.editor.destroy();
});
