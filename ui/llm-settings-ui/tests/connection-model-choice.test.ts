// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MODEL_CAPABILITY_META, t} from '@itookit/common';
import {ConnectionSettingsEditor} from '../src/editors/ConnectionSettingsEditor';
import {modelChoiceLabel, modelPriceLabel} from '../src/utils/modelChoice';
import {renderModelCapabilityBadges} from '../src/utils/modelBadges';
import {ProviderSettingsEditor} from '../src/editors/ProviderSettingsEditor';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0)) await close(); document.body.replaceChildren(); vi.restoreAllMocks();});
async function editor() {
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const provider = {id: 'p', name: 'P', implementation: 'openai-compatible', baseURL: 'https://example.invalid', models: [
        {id: 'main', name: 'Primary', category: 'chat', supportsVision: true, supportsTools: true, inputPricePerMillion: 0, outputPricePerMillion: 2},
        {id: 'other', name: 'Other', category: 'image', supportedOperations: ['image.generate']},
    ]};
    const connection = {id: 'c', name: 'Connection', providerId: 'p', tiers: {optimal: 'main'}}, save = vi.fn(async () => {});
    const service = {getProviders: () => [provider], getConnections: async () => [connection], getDefaultConnection: async () => connection,
        getFullConnection: async () => connection, saveConnection: save};
    const root = document.createElement('div'); document.body.append(root);
    const view = new ConnectionSettingsEditor(root, service as never, {target: {kind: 'entity', entityType: 'connection', id: 'c'}});
    await view.init(root); cleanups.push(() => view.destroy()); return {view, root, save};
}

it('shows names in collapsed selectors and details in the picker and below the selection', async () => {
    const f = await editor();
    expect(f.root.querySelector('.settings-connection-default')).toBeNull();
    expect(f.root.querySelector('[data-model-search]')).toBeNull();
    expect(f.root.querySelector<HTMLSelectElement>('#conn-provider')!.disabled).toBe(true);
    const title = f.root.querySelector<HTMLInputElement>('.settings-page__title [name=name]')!;
    expect(title.value).toBe('Connection'); expect(title.required).toBe(true);
    expect(f.root.querySelector('label')?.textContent).not.toBe('连接名称 *');
    for (const select of f.root.querySelectorAll<HTMLSelectElement>('[data-tier]')) {
        expect(select.querySelector('option[value=main]')!.textContent).toBe('Primary');
        expect(select.nextElementSibling?.textContent).not.toContain('$');
    }
    expect(f.root.querySelector('[data-model-info=optimal] [data-capability=vision]')).not.toBeNull();
    f.root.querySelector<HTMLButtonElement>('#tier-optimal + button')!.click();
    const choices = document.querySelector('[data-model-picker=tier-optimal]')!;
    expect(choices.textContent).toContain(MODEL_CAPABILITY_META.vision.icon); expect(choices.textContent).toContain('$2');
    expect(modelChoiceLabel({id: 'u', name: 'Unknown'}, 'p')).toContain(t('connection.modelPriceUnknown'));
});

it('filters inside each picker without saving, and saves only a deliberate model or title change', async () => {
    const f = await editor();
    f.root.querySelector<HTMLButtonElement>('#tier-optimal + button')!.click();
    const popup = document.querySelector('[data-model-picker=tier-optimal]')!, search = popup.querySelector<HTMLInputElement>('input')!;
    vi.useFakeTimers();
    try {
        search.value = 'OTHER, image'; search.dispatchEvent(new Event('input', {bubbles: true}));
        const primary = f.root.querySelector<HTMLSelectElement>('[data-tier=optimal]')!;
        expect(primary.value).toBe('main'); expect(popup.querySelectorAll('[role=option]')).toHaveLength(1);
        search.value = 'no such model'; search.dispatchEvent(new Event('input', {bubbles: true}));
        expect(primary.value).toBe('main'); expect(popup.querySelectorAll('[role=option]')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1200); expect(f.save).not.toHaveBeenCalled();
        search.value = 'other'; search.dispatchEvent(new Event('input', {bubbles: true}));
        search.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        await vi.advanceTimersByTimeAsync(1200); expect(f.save).toHaveBeenCalledWith(expect.objectContaining({providerId: 'p', tiers: {optimal: 'other'}}));
        expect(f.root.querySelector('#tier-optimal + button')!.textContent).toBe('Other');
        const title = f.root.querySelector<HTMLInputElement>('[name=name]')!; title.value = 'Renamed';
        title.dispatchEvent(new Event('input', {bubbles: true})); await vi.advanceTimersByTimeAsync(1200);
        expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({name: 'Renamed', providerId: 'p'}));
        expect(title.isConnected).toBe(true);
    } finally {vi.useRealTimers();}
});

it('does not present a global token estimate as an image model price', () => {
    const model = {id: 'image', name: 'Image', category: 'image' as const, inputPricePerMillion: 1, outputPricePerMillion: 5};
    const pricing = {model_pricing: [{id: 'default', price: [1, 5, 0, 0] as [number, number, number, number], providers: {}}]};
    expect(modelPriceLabel(model, 'p', pricing)).toBe(t('connection.modelPriceUnknown'));
});

it('shows a shared audio icon only once in connection and provider model details', () => {
    const root = document.createElement('div');
    root.innerHTML = renderModelCapabilityBadges({id: 'speech', name: 'Speech', supportsAudio: true, supportedOperations: ['speech.synthesize']});
    expect(root.querySelectorAll('[data-capability]')).toHaveLength(1);
    expect(root.querySelector('[data-capability]')!.getAttribute('aria-label')).toContain(t('model.capability.speechSynthesis'));
});

it('restores an unsaved connection name in memory without automatically saving it', async () => {
    const old = await editor(), input = old.root.querySelector<HTMLInputElement>('[name=name]')!;
    input.value = 'Pending name';
    old.root.querySelector<HTMLSelectElement>('[data-tier=fast]')!.value = 'other';
    const state = old.view.captureRecovery(); old.view.suspendForRecovery(); await old.view.destroy();
    old.root.remove();
    const next = await editor(); next.view.restoreRecovery(state);
    expect(next.root.querySelector<HTMLInputElement>('[name=name]')!.value).toBe('Pending name');
    expect(next.root.querySelector<HTMLSelectElement>('[data-tier=fast]')!.value).toBe('other');
    expect(next.root.querySelector('#tier-fast + button')!.textContent).toBe('Other');
    expect(next.root.querySelector<HTMLSelectElement>('[data-tier=optimal]')!.value).toBe('main');
    expect([...next.root.querySelector<HTMLSelectElement>('[data-tier=standard]')!.options].map(option => option.value)).toEqual(['', 'main', 'other']);
    expect(next.save).not.toHaveBeenCalled(); next.view.suspendForRecovery();
});

it('preserves an unsaved provider credential and malformed model declaration without saving', async () => {
    const provider = {id: 'p', name: 'Provider', implementation: 'openai-compatible', baseURL: 'https://example.invalid', models: [{id: 'm', name: 'Model'}]};
    const saveProvider = vi.fn(async () => {}), service = {getProviders: () => [provider], saveProvider};
    const build = async () => {
        const root = document.createElement('div'); document.body.append(root);
        const view = new ProviderSettingsEditor(root, service as never, {target: {kind: 'entity', entityType: 'provider', id: 'p'}});
        await view.init(root); cleanups.push(() => view.destroy()); return {view, root};
    };
    const old = await build();
    old.root.querySelector<HTMLInputElement>('[name=apiKey]')!.value = 'unsaved-secret';
    old.root.querySelector<HTMLTextAreaElement>('[name=modelOperations]')!.value = '{';
    const snapshot = old.view.captureRecovery(); old.view.suspendForRecovery(); await old.view.destroy(); old.root.remove();
    const next = await build(); next.view.restoreRecovery(snapshot);
    expect(next.root.querySelector<HTMLInputElement>('[name=apiKey]')!.value).toBe('unsaved-secret');
    expect(next.root.querySelector<HTMLTextAreaElement>('[name=modelOperations]')!.value).toBe('{');
    expect(saveProvider).not.toHaveBeenCalled(); next.view.suspendForRecovery();
});

it('saves the edited connection when multiple retained forms are mounted', async () => {
    const first = await editor(), second = await editor();
    const title = second.root.querySelector<HTMLInputElement>('[name=name]')!;
    title.value = 'Second connection';
    const model = second.root.querySelector<HTMLSelectElement>('[data-tier=optimal]')!;
    model.value = 'other'; model.dispatchEvent(new Event('change', {bubbles: true}));
    await vi.waitFor(() => expect(second.save).toHaveBeenCalledWith(expect.objectContaining({name: 'Second connection', tiers: {optimal: 'other'}})));
    expect(first.save).not.toHaveBeenCalled();
    expect(first.root.querySelector<HTMLInputElement>('[name=name]')!.value).toBe('Connection');
    expect(first.root.querySelector<HTMLSelectElement>('[data-tier=optimal]')!.value).toBe('main');
});

it('keeps enabled, name and provider action in one header with the protocol next to its provider', async () => {
    const f = await editor();
    const header = f.root.querySelector('.settings-page__header')!, enabled = header.querySelector<HTMLInputElement>('[name=enabled]')!;
    expect(enabled.checked).toBe(true); expect(header.querySelector('[name=name]')).not.toBeNull();
    expect(header.querySelector('.settings-page__actions > button')?.textContent).toBe(t('toolbox.configureProvider'));
    expect(header.querySelector('.settings-page__menu button')).not.toBeNull();
    const service = f.root.querySelector('.connection-form__service-row')!;
    expect(service.querySelector('[name=providerId]')).not.toBeNull(); expect(service.querySelector('[name=protocol]')).not.toBeNull();
    expect(service.querySelector('.settings-form__help')).toBeNull();
    enabled.checked = false; enabled.dispatchEvent(new Event('change', {bubbles: true}));
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledWith(expect.objectContaining({enabled: false})));
});
