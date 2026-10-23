// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MODEL_CAPABILITY_META, t} from '@itookit/common';
import {ConnectionSettingsEditor} from '../src/editors/ConnectionSettingsEditor';
import {modelChoiceLabel, modelPriceLabel} from '../src/utils/modelChoice';
import {renderModelCapabilityBadges} from '../src/utils/modelBadges';
import {ProviderSettingsEditor} from '../src/editors/ProviderSettingsEditor';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0)) await close(); document.body.replaceChildren();});
async function editor() {
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

it('shows model abilities and token price in all routing choices without a repeated global default summary', async () => {
    const f = await editor();
    expect(f.root.querySelector('.settings-connection-default')).toBeNull();
    for (const select of f.root.querySelectorAll<HTMLSelectElement>('[data-tier]')) {
        const label = select.querySelector('option[value=main]')!.textContent!;
        expect(label).toContain(t('model.capability.vision')); expect(label).toContain(t('model.capability.tools'));
        expect(label).toContain('$0'); expect(label).toContain('$2');
    }
    expect(f.root.querySelector('[data-model-info=optimal] [data-capability=vision]')).not.toBeNull();
    expect(f.root.querySelector('option[value=main]')!.textContent).toContain(MODEL_CAPABILITY_META.vision.icon);
    expect(modelChoiceLabel({id: 'u', name: 'Unknown'}, 'p')).toContain(t('connection.modelPriceUnknown'));
});

it('filters every tier by multiple case-insensitive terms without changing or saving selections', async () => {
    const f = await editor(), search = f.root.querySelector<HTMLInputElement>('[data-model-search]')!;
    vi.useFakeTimers();
    try {
        search.value = 'OTHER, image'; search.dispatchEvent(new Event('input', {bubbles: true}));
        const primary = f.root.querySelector<HTMLSelectElement>('[data-tier=optimal]')!;
        expect(primary.value).toBe('main');
        expect(primary.querySelector('option[value=main]')!.textContent).toContain(t('connection.modelSelectedOutsideFilter', {model: ''}).trim());
        expect([...f.root.querySelector<HTMLSelectElement>('[data-tier=standard]')!.options].map(option => option.value)).toEqual(['', 'other']);
        search.value = 'no such model'; search.dispatchEvent(new Event('input', {bubbles: true}));
        expect(primary.value).toBe('main'); expect(primary.options).toHaveLength(2);
        search.value = ''; search.dispatchEvent(new Event('input', {bubbles: true}));
        expect(primary.options).toHaveLength(3); expect(primary.value).toBe('main');
        await vi.advanceTimersByTimeAsync(1200); expect(f.save).not.toHaveBeenCalled();
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
    const search = old.root.querySelector<HTMLInputElement>('[data-model-search]')!;
    search.value = 'other image'; search.dispatchEvent(new Event('input', {bubbles: true}));
    const state = old.view.captureRecovery(); old.view.suspendForRecovery(); await old.view.destroy();
    old.root.remove();
    const next = await editor(); next.view.restoreRecovery(state);
    expect(next.root.querySelector<HTMLInputElement>('[name=name]')!.value).toBe('Pending name');
    expect(next.root.querySelector<HTMLInputElement>('[data-model-search]')!.value).toBe('other image');
    expect(next.root.querySelector<HTMLSelectElement>('[data-tier=optimal]')!.value).toBe('main');
    expect([...next.root.querySelector<HTMLSelectElement>('[data-tier=standard]')!.options].map(option => option.value)).toEqual(['', 'other']);
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
