import { resolvePricingEntry, type ModelPricingConfig, type PricingBasis } from './pricing';
import type { MeteredTokens } from '@itookit/driver-llm/contracts';

/** Bucket shape is owned by driver-llm metering so the meter and the rate table cannot drift. */
export type { MeteredTokens };
export interface MeteredUsage {
    complete: boolean; revision: string; totals: MeteredTokens;
    entries: ReadonlyArray<{id: string; providerId: string | null; modelId: string | null; tokens: MeteredTokens}>;
}
export interface UsageCostEstimate {
    currency: 'USD'; estimatedCostUsd: number | null; pricedCostUsd: number; complete: boolean; usageRevision: string;
    entries: Array<{id: string; providerId: string | null; modelId: string | null; costUsd: number | null;
        pricingId?: string; basis?: PricingBasis; price?: [number, number, number, number]}>;
}
/** Pure estimation over disjoint token buckets; never adds reasoning twice or writes a ledger. */
export function estimateUsageCost(usage: MeteredUsage, config: ModelPricingConfig): UsageCostEstimate {
    const entries = usage.entries.map(entry => {
        const quote = resolvePricingEntry(config, entry.providerId ?? '', entry.modelId ?? '');
        if (!quote || quote.entry.price.length !== 4 || quote.entry.price.some(n => !Number.isFinite(n) || n < 0)) return {...entryIdentity(entry), costUsd: null};
        const t = entry.tokens, price = quote.entry.price;
        const costUsd = (t.inputTokens * price[0] + t.outputTokens * price[1] + t.cacheWriteTokens * price[2] + t.cacheReadTokens * price[3]) / 1_000_000;
        return {...entryIdentity(entry), costUsd: Number.isFinite(costUsd) ? costUsd : null, pricingId: quote.entry.id,
            basis: quote.basis, price: [...price] as [number, number, number, number]};
    });
    const pricedCostUsd = entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
    const priced = entries.length > 0 && entries.every(entry => entry.costUsd !== null) && Number.isFinite(pricedCostUsd);
    return {currency: 'USD', estimatedCostUsd: priced ? pricedCostUsd : null, pricedCostUsd,
        complete: usage.complete && priced, usageRevision: usage.revision, entries};
}
function entryIdentity(entry: MeteredUsage['entries'][number]) {
    return {id: entry.id, providerId: entry.providerId, modelId: entry.modelId};
}
