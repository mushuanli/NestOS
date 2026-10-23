import {afterEach, expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import type {ModelPricingConfig} from '@itookit/kernel-adapters/contracts';
import {modelPriceLabel, modelPriceSource} from '../src/utils/modelPrice';
import {matchesModelQuery} from '../src/utils/modelChoice';

afterEach(() => vi.useRealTimers());
const config: ModelPricingConfig = {model_pricing: [], reference_catalog: {version: 1, providers: {
    p: {sourceUrl: 'https://example.invalid/prices', reviewedAt: '2026-10-23', status: 'published', models: [
        {modelIds: ['image'], currency: 'CNY', unit: 'image', rates: [{input: 0, output: 0.12}]},
        {modelIds: ['tts'], currency: 'CNY', unit: 'ten-thousand-characters', rates: [{input: 3}]},
        {modelIds: ['variable'], currency: 'USD', unit: 'million-tokens', status: 'variable', rates: []},
        {modelIds: ['tiered'], currency: 'USD', unit: 'million-tokens', rates: [{input: 2, output: 12}, {input: 4, output: 18}]},
        {modelIds: ['promo'], currency: 'USD', unit: 'million-tokens', rates: [{input: 1, conditions: {validUntil: '2026-10-01'}}]},
    ]},
    account: {sourceUrl: 'https://example.invalid/account', reviewedAt: '2026-10-23', status: 'account', models: []},
    subscription: {sourceUrl: '', reviewedAt: '2026-10-23', status: 'subscription', models: []},
}}};
const label = (id: string, provider = 'p') => modelPriceLabel({id, name: id}, provider, config);

it('shows native currency and per-image or per-character units instead of a token estimate', () => {
    expect(label('image')).toContain('¥0.12'); expect(label('image')).toContain(t('connection.priceUnit.image'));
    expect(label('image')).not.toContain('USD'); expect(label('image')).not.toContain('token');
    expect(label('tts')).toContain('¥3'); expect(label('tts')).toContain(t('connection.priceUnit.ten-thousand-characters'));
    expect(label('tiered')).toContain('$2–$4'); expect(label('tiered')).toContain('$12–$18');
    expect(modelPriceSource('p', config)).toEqual({url: 'https://example.invalid/prices', reviewedAt: '2026-10-23'});
});

it('distinguishes unknown, routed, account-specific and expired promotional rates', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
    expect(label('missing')).toBe(t('connection.modelPriceUnverified'));
    expect(label('promo')).toBe(t('connection.modelPriceUnverified'));
    expect(label('variable')).toBe(t('connection.modelPriceVariable'));
    expect(label('m', 'account')).toBe(t('connection.modelPriceAccount'));
    expect(label('m', 'subscription')).toBe(t('connection.modelPriceSubscription'));
    const broken = structuredClone(config); broken.reference_catalog!.providers.p.sourceUrl = 'javascript:alert(1)';
    expect(modelPriceSource('p', broken)).toBeUndefined();
});

it('matches names, IDs and declared abilities with intersecting keywords', () => {
    const model = {id: 'opaque-v2', name: 'Custom Model', supportsVision: true, supportsTools: true};
    expect(matchesModelQuery(model, 'CUSTOM opaque VISION')).toBe(true);
    expect(matchesModelQuery(model, 'custom, tools')).toBe(true);
    expect(matchesModelQuery(model, 'custom audio')).toBe(false);
    expect(matchesModelQuery(model, '')).toBe(true);
});
