import { expect, it } from 'vitest';
import { ensureProviderPricing, resolvePricingEntry, type ModelPricingConfig } from '../../src/contracts';
import { estimateUsageCost, type MeteredUsage } from '../../src/llm-management/contracts/usage-pricing';
const config: ModelPricingConfig = {model_pricing: [
    {id: 'global', fallbackFor: ['p'], price: [2, 4, 3, 0.5], providers: {}},
    {id: 'exact', price: [10, 20, 12, 1], providers: {p: ['known']}},
    {id: 'named', names: ['family-*'], price: [1, 2, 1, 0.1], providers: {}},
    {id: 'default', price: [5, 10, 5, 1], providers: {}},
]};
const tokens = {inputTokens: 1000000, outputTokens: 1000000, cacheWriteTokens: 1000000, cacheReadTokens: 1000000, reasoningTokens: 500000};
const usage: MeteredUsage = {revision: 'r', complete: true, totals: tokens, entries: [{id: 'e', providerId: 'p', modelId: 'unknown', tokens}]};
it('resolves exact and named models before provider defaults, then global defaults', () => {
    expect(resolvePricingEntry(config, 'p', 'known')).toMatchObject({entry: {id: 'exact'}, basis: 'model'});
    expect(resolvePricingEntry(config, 'p', 'family-new')).toMatchObject({entry: {id: 'named'}, basis: 'model'});
    expect(resolvePricingEntry(config, 'p', 'unknown')).toMatchObject({entry: {id: 'global'}, basis: 'provider-default'});
    expect(resolvePricingEntry(config, 'other', 'unknown')).toMatchObject({entry: {id: 'default'}, basis: 'global-default'});
});
it('prices disjoint cache buckets once and never adds reasoning to output a second time', () => {
    const result = estimateUsageCost(usage, config);
    expect(result.estimatedCostUsd).toBe(9.5);
    expect(result.entries[0]).toMatchObject({basis: 'provider-default', pricingId: 'global'});
    expect(estimateUsageCost(usage, config)).toEqual(result);
});
it('distinguishes unknown prices, incomplete usage, configured zero prices and mixed models', () => {
    expect(estimateUsageCost(usage, {model_pricing: []})).toMatchObject({estimatedCostUsd: null, complete: false});
    expect(estimateUsageCost({...usage, complete: false}, config)).toMatchObject({estimatedCostUsd: 9.5, complete: false});
    expect(estimateUsageCost(usage, {model_pricing: [{id: 'default', providers: {}, price: [0, 0, 0, 0]}]}).estimatedCostUsd).toBe(0);
    const mixed = {...usage, entries: [...usage.entries, {...usage.entries[0], id: 'other', modelId: 'known'}]};
    expect(estimateUsageCost(mixed, config).estimatedCostUsd).toBe(52.5);
    expect(estimateUsageCost(usage, {model_pricing: [{id: 'default', providers: {}, price: [-1, 0, 0, 0]}]}).estimatedCostUsd).toBeNull();
});

it('adds injected provider defaults to old saved pricing without replacing custom defaults', async () => {
    const {createVFS, MemoryBackend} = await import('@itookit/vfs-core');
    const {loadPricingConfig, writePricingConfig} = await import('../../src/llm-management/constants/pricing');
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/etc');
    try {
        await writePricingConfig(fs, {model_pricing: [{id: 'custom-p', fallbackFor: ['p'], providers: {}, price: [7, 8, 9, 1]}]});
        const loaded = await loadPricingConfig(fs, {model_pricing: [
            {id: 'preset-p', fallbackFor: ['p'], providers: {}, price: [1, 1, 1, 1]},
            {id: 'preset-q', fallbackFor: ['q'], providers: {}, price: [2, 2, 2, 2]},
        ]});
        expect(resolvePricingEntry(loaded, 'p', 'unknown')?.entry.price[0]).toBe(7);
        expect(resolvePricingEntry(loaded, 'q', 'unknown')?.entry.price[0]).toBe(2);
        expect(loaded.model_pricing.some(entry => entry.id === 'preset-p')).toBe(false);
    } finally { await manager.dispose(); }
});

it('gives custom providers an editable default from the configured global template and preserves identity on repeated reads', () => {
    const expanded = ensureProviderPricing(config, ['p', 'custom-a', 'custom-b']);
    expect(resolvePricingEntry(expanded, 'p', 'unknown')?.entry.price[0]).toBe(2);
    expect(resolvePricingEntry(expanded, 'custom-a', 'unknown')).toMatchObject({basis: 'provider-default', entry: {price: [5, 10, 5, 1]}});
    expect(ensureProviderPricing(expanded, ['p', 'custom-a', 'custom-b'])).toBe(expanded);
    expect(config.model_pricing).toHaveLength(4);
    const empty = {model_pricing: []}; expect(ensureProviderPricing(empty, ['custom'])).toBe(empty);
});
