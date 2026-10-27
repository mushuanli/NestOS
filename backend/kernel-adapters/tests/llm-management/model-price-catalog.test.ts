import {expect, it} from 'vitest';
import {createLlmDeviceCatalog} from '@itookit/device-llm';
const {providers: LLM_PROVIDERS, pricing: {reference_catalog: catalog}} = createLlmDeviceCatalog();
const MODEL_PRICE_CATALOG = catalog!;
import {resolveModelReferencePrice} from '@itookit/device-llm/contracts';
import {createNestosLlmPresets} from '../../src/llm-management/presets';
import {ProviderManager} from '../../src/llm-management/device/provider-manager';

it('records a reviewed pricing source and explicit pricing mode for every builtin provider', () => {
    expect(Object.keys(MODEL_PRICE_CATALOG.providers).sort()).toEqual(Object.keys(LLM_PROVIDERS).sort());
    for (const [id, provider] of Object.entries(MODEL_PRICE_CATALOG.providers)) {
        expect(provider.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (id !== 'custom') expect(new URL(provider.sourceUrl).protocol).toBe('https:');
        if (provider.status !== 'published') continue;
        for (const model of LLM_PROVIDERS[id].models) expect(resolveModelReferencePrice(MODEL_PRICE_CATALOG, id, model.id), model.id).toBeDefined();
        const ids = provider.models.flatMap(model => model.modelIds);
        expect(new Set(ids).size).toBe(ids.length);
        for (const model of provider.models) for (const rate of model.rates) {
            for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
                if (rate[field] !== undefined) {expect(Number.isFinite(rate[field])).toBe(true); expect(rate[field]).toBeGreaterThanOrEqual(0);}
        }
    }
});

it('preserves exact model identity and the original image and speech billing units', () => {
    expect(resolveModelReferencePrice(MODEL_PRICE_CATALOG, 'volcengine', 'doubao-seedream-5-0-flash-260915'))
        .toMatchObject({currency: 'CNY', unit: 'image', rates: [{output: 0.12}]});
    expect(resolveModelReferencePrice(MODEL_PRICE_CATALOG, 'doubao-speech', 'seed-tts-2.0'))
        .toMatchObject({currency: 'CNY', unit: 'ten-thousand-characters', rates: [{input: 3}]});
    expect(resolveModelReferencePrice(MODEL_PRICE_CATALOG, 'volcengine', 'doubao-seedream-4-0-20260415')).toBeUndefined();
    expect(resolveModelReferencePrice(MODEL_PRICE_CATALOG, 'openrouter', 'gpt-5.5')).toBeUndefined();
    expect(resolveModelReferencePrice(MODEL_PRICE_CATALOG, '__proto__', 'gpt-5.5')).toBeUndefined();
});

it('keeps reviewed vendor references available independently of editable ledger rates', () => {
    const presets = createNestosLlmPresets();
    const manager = new ProviderManager({} as never, {} as never, () => {}, presets);
    const config = manager.getPricingConfig();
    expect(config.model_pricing).toEqual([]);
    expect(config.reference_catalog).toEqual(MODEL_PRICE_CATALOG);
    config.reference_catalog!.providers.openai.models[0].rates[0].input = 999;
    expect(manager.getPricingConfig().reference_catalog!.providers.openai.models[0].rates[0].input).toBe(5);
    expect(MODEL_PRICE_CATALOG.providers.openai.models[0].rates[0].input).toBe(5);
});
