// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ModelDefaultsEditor } from '../src/editors/ModelDefaultsEditor';
import { t } from '@itookit/common';
import type { OcrControls } from '@itookit/ui-common';

afterEach(() => { document.body.replaceChildren(); });
function fixture(ocr?: OcrControls) {
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
    const editor = new ModelDefaultsEditor(root, service as never, { hostContext: { navigate } } as never, ocr);
    return { editor, root, service, connections, provider, navigate, defaults: (value: Record<string, string>) => { defaults = value; } };
}

it('keeps connection choices concise and shows capabilities and price below the selection', async () => {
    const f = fixture(); Object.assign(f.provider.models[0], {supportsVision: true, inputPricePerMillion: 0, outputPricePerMillion: 2});
    await f.editor.init(f.root);
    const option = f.root.querySelector('[data-default-operation=chat] option[value=chat]')!;
    expect(option.textContent).not.toContain(t('model.capability.vision'));
    expect(option.textContent).not.toContain('$');
    const info = f.root.querySelector('[data-default-model=chat]')!;
    expect(info.querySelector('[data-capability=vision]')).not.toBeNull(); expect(info.textContent).toContain('$2');
    expect(f.root.querySelector('[data-default-model="image.generate"]')?.textContent).toContain(t('connection.modelPriceUnknown'));
    expect(f.service.testConnection).not.toHaveBeenCalled(); await f.editor.destroy();
});

it('recovers pending model choices and inline OCR fields without saving', async () => {
    const ocr = ocrFixture(), old = fixture(ocr.controls); await old.editor.init(old.root);
    old.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value = '';
    old.root.querySelector<HTMLSelectElement>('[name=ocr-connection]')!.value = '';
    const state = old.editor.captureRecovery(); old.editor.suspendForRecovery(); await old.editor.destroy(); old.root.remove();
    const next = fixture(ocr.controls); await next.editor.init(next.root); next.editor.restoreRecovery(state);
    expect(next.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value).toBe('');
    expect(next.root.querySelector('[data-default-selection=chat] [data-model-config]')).toBeNull();
    expect(next.root.querySelector<HTMLSelectElement>('[name=ocr-connection]')!.value).toBe('');
    expect(ocr.controls.saveSettings).not.toHaveBeenCalled(); expect(next.service.setModelDefault).not.toHaveBeenCalled();
    expect(next.service.testConnection).not.toHaveBeenCalled(); await next.editor.destroy();
});

it('discards a background read that finishes after an eventless model choice is restored', async () => {
    const old = fixture(); old.defaults({}); await old.editor.init(old.root);
    old.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value = 'chat';
    const state = old.editor.captureRecovery(); old.editor.suspendForRecovery(); await old.editor.destroy(); old.root.remove();
    const next = fixture(); next.defaults({}); await next.editor.init(next.root);
    next.connections[0].name = 'Updated connection';
    let finish!: (value: Record<string, string>) => void;
    vi.spyOn(next.service, 'getModelDefaults').mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const refresh = next.editor.render(), select = next.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!;
    next.editor.restoreRecovery(state); finish({}); await refresh;
    expect(next.root.querySelector('[data-default-operation=chat]')).toBe(select); expect(select.value).toBe('chat');
    expect(next.root.querySelector('[data-default-selection=chat] [data-model-config]')?.getAttribute('data-model-config')).toBe('/connections/chat');
    expect(next.service.setModelDefault).not.toHaveBeenCalled(); await next.editor.destroy();
});

it('preserves an eventless choice when unchanged settings become readable again before recovery capture', async () => {
    const f = fixture(); f.defaults({}); await f.editor.init(f.root);
    const select = f.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!; select.value = 'chat';
    vi.spyOn(f.service, 'getModelDefaults').mockRejectedValueOnce(new Error('Host disconnected'));
    await f.editor.render(); expect(f.root.textContent).toContain('Host disconnected');
    await f.editor.render();
    expect(f.root.querySelector('[data-default-operation=chat]')).toBe(select); expect(select.value).toBe('chat');
    expect(f.root.textContent).not.toContain('Host disconnected');
    expect(f.service.setModelDefault).not.toHaveBeenCalled(); await f.editor.destroy();
});

it('waits for an in-flight default save before recovery and never repeats the write', async () => {
    const f = fixture(); let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    const save = f.service.setModelDefault.getMockImplementation()!;
    f.service.setModelDefault.mockImplementationOnce(async (operation, id) => {await gate; await save(operation, id);});
    await f.editor.init(f.root);
    const select = f.root.querySelector<HTMLSelectElement>('[data-default-operation="image.generate"]')!;
    select.value = ''; select.dispatchEvent(new Event('change', {bubbles: true}));
    expect(() => f.editor.captureRecovery()).toThrow(t('httpApp.recoveryBusy'));
    finish(); await f.editor.flushPendingSave(); expect(() => f.editor.captureRecovery()).not.toThrow();
    expect(f.service.setModelDefault).toHaveBeenCalledTimes(1); expect(f.service.testConnection).not.toHaveBeenCalled();
    await f.editor.destroy();
});

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

it('links to model configuration and each selected connection without exposing paid verification', async () => {
    const f = fixture(); await f.editor.init(f.root);
    expect(f.root.querySelector('[data-chat-probe], [data-media-probe]')).toBeNull();
    expect(f.root.querySelector('.model-defaults__status')).toBeNull();
    f.root.querySelector<HTMLAnchorElement>('[data-models-link]')!.click();
    expect(f.navigate).toHaveBeenLastCalledWith({target: 'toolbox', resourceId: '/connections'});
    for (const [operation, id] of [['chat', 'chat'], ['image.generate', 'image'], ['speech.synthesize', 'speech']]) {
        f.root.querySelector<HTMLAnchorElement>(`[data-default-selection="${operation}"] [data-model-config]`)!.click();
        expect(f.navigate).toHaveBeenLastCalledWith({target: 'toolbox', resourceId: '/connections/' + id});
    }
    expect(f.service.testConnection).not.toHaveBeenCalled();
    await f.editor.navigateToAnchor('speech.synthesize');
    expect(document.activeElement).toBe(f.root.querySelector('[data-default-operation="speech.synthesize"]'));
    await f.editor.destroy();
});

it('preserves an eventless choice across unchanged service notifications', async () => {
    const f = fixture(); await f.editor.init(f.root);
    const select = f.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!; select.value = '';
    await f.editor.render();
    expect(f.root.querySelector('[data-default-operation=chat]')).toBe(select); expect(select.value).toBe('');
    expect(f.service.setModelDefault).not.toHaveBeenCalled(); expect(f.service.testConnection).not.toHaveBeenCalled();
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
    const ocr = ocrFixture(), f = fixture(ocr.controls);
    f.connections.push({...f.connections[0], id: 'vision', name: 'Vision'}); await f.editor.init(f.root);
    const select = f.root.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!;
    expect([...select.options].map(option => option.value)).toEqual(['', 'vision', 'no-key']);
    expect(select.options[2].disabled).toBe(true); expect(select.value).toBe('vision');
    select.closest('section')!.querySelector<HTMLAnchorElement>('[data-model-config]')!.click();
    expect(f.navigate).toHaveBeenLastCalledWith({target: 'toolbox', resourceId: '/connections/vision'});
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

it('retains the mounted OCR field and eventless draft when a background read fails during disconnection', async () => {
    const ocr = ocrFixture(), f = fixture(ocr.controls); await f.editor.init(f.root);
    const select = f.root.querySelector<HTMLSelectElement>('[name=ocr-connection]')!; select.value = '';
    ocr.controls.readSettings.mockRejectedValueOnce(new Error('Connection interrupted')); ocr.notify();
    await vi.waitFor(() => expect(f.root.textContent).toContain('Connection interrupted'));
    expect(f.root.querySelector('[name=ocr-connection]')).toBe(select); expect(select.value).toBe('');
    expect(() => f.editor.captureRecovery()).not.toThrow();
    f.root.querySelector<HTMLButtonElement>('[data-ocr-retry]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-ocr-retry]')).toBeNull());
    expect(select.value).toBe(''); expect(ocr.controls.saveSettings).not.toHaveBeenCalled(); await f.editor.destroy();
});

it('recovers other settings when OCR initially failed to read and becomes available in the new view', async () => {
    const ocr = ocrFixture(); ocr.controls.readSettings.mockRejectedValueOnce(new Error('OCR unavailable'));
    const old = fixture(ocr.controls); await old.editor.init(old.root);
    old.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value = '';
    const state = old.editor.captureRecovery(); old.editor.suspendForRecovery(); await old.editor.destroy(); old.root.remove();
    const next = fixture(ocr.controls); await next.editor.init(next.root); next.editor.restoreRecovery(state);
    expect(next.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value).toBe('');
    expect(next.root.querySelector<HTMLSelectElement>('[name=ocr-connection]')!.value).toBe('vision');
    expect(ocr.controls.saveSettings).not.toHaveBeenCalled(); expect(next.service.setModelDefault).not.toHaveBeenCalled(); await next.editor.destroy();
});

it('preserves an eventless selection when provider metadata changes before recovery capture', async () => {
    const f = fixture(); f.defaults({}); await f.editor.init(f.root);
    f.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value = 'chat';
    f.provider.name = 'Updated provider catalog'; await f.editor.render();
    expect(f.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value).toBe('chat');
    expect(f.root.querySelector('[data-default-selection=chat] [data-model-config]')?.getAttribute('data-model-config')).toBe('/connections/chat');
    expect(f.editor.isDirty()).toBe(true); expect(f.service.setModelDefault).not.toHaveBeenCalled();
    const state = f.editor.captureRecovery(); f.editor.suspendForRecovery(); await f.editor.destroy(); f.root.remove();
    const next = fixture(); next.defaults({}); await next.editor.init(next.root); next.editor.restoreRecovery(state);
    expect(next.root.querySelector<HTMLSelectElement>('[data-default-operation=chat]')!.value).toBe('chat');
    await next.editor.destroy();
});
