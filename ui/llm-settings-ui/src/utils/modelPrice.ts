import type {LLMModel} from '@itookit/driver-llm/contracts';
import {getProviderPriceCatalog, resolveModelReferencePrice, resolvePricingEntry, type ModelPricingConfig, type ModelReferencePrice} from '@itookit/kernel-adapters/contracts';
import {t} from '@itookit/common';

function priceRange(values: Array<number | undefined>, currency: string): string | undefined {
    const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (!known.length) return;
    const min = Math.min(...known), max = Math.max(...known), sign = currency === 'CNY' ? '¥' : '$';
    return min === max ? `${sign}${min}` : `${sign}${min}–${sign}${max}`;
}

function referenceLabel(reference: ModelReferencePrice): string {
    const today = new Date().toISOString().slice(0, 10);
    const rates = reference.rates.filter(rate => !rate.conditions?.validUntil || rate.conditions.validUntil >= today);
    const input = priceRange(rates.map(rate => rate.input), reference.currency), output = priceRange(rates.map(rate => rate.output), reference.currency);
    if (!input && !output) return t('connection.modelPriceUnverified');
    const unit = reference.unit === 'million-tokens' ? t(`connection.priceUnit.million-${reference.tokenModality ?? 'text'}-tokens`)
        : t(`connection.priceUnit.${reference.unit}`), currency = reference.currency;
    const price = input && output ? t('connection.modelPriceQuote', {input, output, unit, currency})
        : input ? t('connection.modelPriceInput', {input, unit, currency}) : t('connection.modelPriceOutput', {output: output!, unit, currency});
    return t('connection.modelReferencePrice', {price});
}

export function modelPriceLabel(model: LLMModel, providerId: string, pricing?: ModelPricingConfig): string {
    const provider = getProviderPriceCatalog(pricing?.reference_catalog, providerId);
    if (provider?.status === 'account') return t('connection.modelPriceAccount');
    if (provider?.status === 'subscription') return t('connection.modelPriceSubscription');
    const reference = resolveModelReferencePrice(pricing?.reference_catalog, providerId, model.id);
    if (reference?.status === 'variable') return t('connection.modelPriceVariable');
    if (reference) return referenceLabel(reference);
    if (provider?.status === 'published') return t('connection.modelPriceUnverified');
    const quote = pricing && resolvePricingEntry(pricing, providerId, model.id);
    if (quote && quote.basis !== 'model') return t('connection.modelPriceUnknown');
    const exact = quote?.entry.price;
    const input = exact?.[0] ?? model.inputPricePerMillion, output = exact?.[1] ?? model.outputPricePerMillion;
    if (input === undefined && output === undefined) return t('connection.modelPriceUnknown');
    const price = t('connection.modelPrice', {input: priceRange([input], 'USD') ?? t('connection.modelPriceUnknown'),
        output: priceRange([output], 'USD') ?? t('connection.modelPriceUnknown')});
    return t('connection.modelConfiguredPrice', {price});
}

export function modelPriceSource(providerId: string, pricing?: ModelPricingConfig, modelId?: string): {url: string; reviewedAt: string} | undefined {
    const provider = getProviderPriceCatalog(pricing?.reference_catalog, providerId);
    const reference = modelId && resolveModelReferencePrice(pricing?.reference_catalog, providerId, modelId);
    const sourceUrl = reference && reference.sourceUrl || provider?.sourceUrl;
    if (!sourceUrl || !provider) return;
    try {
        const url = new URL(sourceUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') return {url: url.href, reviewedAt: provider.reviewedAt};
    } catch { /* Invalid catalog links must not become executable markup. */ }
}
