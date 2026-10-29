import { afterEach, expect, it, vi } from 'vitest';
import { LLMDeviceDriver } from '../../src/llm-management/device/llm-device-driver';
import {createLlmDeviceCatalog} from '../../src/llm-management/catalogs';
const {providers: LLM_PROVIDERS} = createLlmDeviceCatalog();
import { fromLLMProvider, toLLMProvider, fromConnectionDef, toRuntimeConnection } from '../../src/llm-management/constants/llm-loader';
import { isProvider } from '../../src/llm-management/device/argument-validation';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import { ProviderManager } from '../../src/llm-management/device/provider-manager';

afterEach(() => vi.unstubAllGlobals());
function setup() {
    const saved: LLMProvider = { id: 'p', name: 'Provider', implementation: 'custom', baseURL: 'https://original.test', apiKey: 'stored-secret', models: [{ id: 'text', name: 'Text' }] };
    const save = vi.fn().mockResolvedValue(undefined);
    const driver = Object.create(LLMDeviceDriver.prototype) as LLMDeviceDriver;
    Object.assign(driver, { ensureReady: async () => {}, cancelPendingSync: () => {},
        providerManager: { getFullProvider: () => saved, saveProvider: save },
        connectionManager: { ensureProviderConnection: async () => {} }, authorization: { credentials: () => undefined } });
    const { apiKey: _secret, ...draft } = saved;
    return { driver, saved, draft, save };
}

it('resolves stored credentials for a text test without returning them to the UI', async () => {
    const { driver, draft } = setup();
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await driver.testConnection({ provider: 'p', providerDefinition: draft, model: 'text' })).toMatchObject({ success: true });
    expect(new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('Authorization')).toBe('Bearer stored-secret');
});

it.each([{ baseURL: 'https://changed.test' }, { apiKey: '' }])('never reuses a stored key after an endpoint change or explicit clearing: %j', async extra => {
    const { driver, draft } = setup(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await driver.testConnection({ provider: 'p', providerDefinition: draft, model: 'text', ...extra });
    expect(result).toMatchObject({ success: false, code: 'CONNECTION_TEST_CONFIG' }); expect(fetch).not.toHaveBeenCalled();
});

it('preserves a write-only credential on ordinary saves and honors explicit clearing', async () => {
    const { driver, draft, save } = setup();
    await driver.saveProvider({ ...draft, name: 'Renamed' });
    expect(save.mock.calls[0][0]).toMatchObject({ name: 'Renamed', apiKey: 'stored-secret' });
    await driver.saveProvider({ ...draft, apiKey: '' });
    expect(save.mock.calls[1][0].apiKey).toBe('');
});

it('rejects unsupported model discovery at the service boundary without an HTTP request', async () => {
    const { driver, draft } = setup(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(driver.listProviderModels({ ...draft, modelsPath: false })).rejects.toMatchObject({ code: 'MODEL_CATALOG_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
});

it('round trips reasoning, operation endpoints and the text test model without credentials', () => {
    const provider: LLMProvider = { ...LLM_PROVIDERS.volcengine, models: [
        { id: 'r', name: 'R', reasoning: { efforts: [{ id: 'max', value: 'xhigh' }] }, reasoningByProtocol: { 'anthropic-messages': false } },
    ], connectionTestModel: 'r', apiKey: 'secret' };
    const encoded = fromLLMProvider(provider);
    expect(encoded).not.toHaveProperty('apiKey');
    expect(toLLMProvider(encoded)).toMatchObject({ connectionTestModel: 'r', media: provider.media, models: provider.models });
    expect(isProvider(provider)).toBe(true);
    expect(isProvider({ ...provider, models: [{ id: 'r', reasoning: { efforts: [{ id: 'max' }], defaultEffort: 'missing' } }] })).toBe(false);
});

it('keeps speech and text credentials separate and declares native Seedream execution', () => {
    expect(LLM_PROVIDERS['doubao-speech'].models.every(model => model.category === 'audio')).toBe(true);
    expect(LLM_PROVIDERS['doubao-speech'].modelsPath).toBe(false);
    expect(LLM_PROVIDERS.volcengine.models.find(model => model.id === LLM_PROVIDERS.volcengine.connectionTestModel)?.category).toBe('chat');
    expect(LLM_PROVIDERS.volcengine.media?.['image.generate']?.adapter).toBe('volcengine-images');
    expect(LLM_PROVIDERS.volcengine.models.find(model => model.category === 'image')?.operations?.['image.generate']?.formats).toContain('png');
});

it('round trips unsupported catalog discovery and inherits it for stored built-ins without overriding custom endpoints', () => {
    const definition = LLM_PROVIDERS['doubao-speech'];
    expect(toLLMProvider(fromLLMProvider(definition)).modelsPath).toBe(false);
    expect(isProvider(definition)).toBe(true); expect(isProvider({ ...definition, modelsPath: true })).toBe(false);
    const manager = new ProviderManager({} as never, {} as never, () => {}, { providers: { [definition.id]: definition }, pricing: { model_pricing: [] } } as never);
    Object.assign(manager, { _pricingConfig: { model_pricing: [] } });
    const legacy = { ...definition, modelsPath: undefined, apiKey: 'existing-key' };
    manager.reloadProvidersFrom([legacy]);
    expect(manager.getProvider(definition.id)?.modelsPath).toBe(false);
    expect(manager.getFullProvider(definition.id)?.apiKey).toBe('existing-key');
    manager.reloadProvidersFrom([{ ...legacy, modelsPath: '/proxy/catalog' }]);
    expect(manager.getProvider(definition.id)?.modelsPath).toBe('/proxy/catalog');
});

it('preserves connection routing, model-specific reasoning and budgets through export/import', () => {
    const connection = { id: 'c', name: 'C', providerId: 'p', protocol: 'anthropic-messages' as const,
        tiers: { optimal: 'text' }, temperature: 0.5, metadata: { modelReasoningEfforts: { text: 'max' }, modelThinkingBudgets: { text: 2048 } } };
    expect(toRuntimeConnection(fromConnectionDef(connection))).toMatchObject(connection);
});
