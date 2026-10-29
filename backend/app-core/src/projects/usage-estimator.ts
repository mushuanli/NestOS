import { estimateUsageCost, type MeteredTokens, type MeteredUsage, type ModelPricingConfig, type UsageCostEstimate } from '@itookit/kernel-adapters/contracts';
import type { HarnessTokens, HarnessUsage } from '@itookit/nestos-node-driver';

/** Remote wire buckets → local billing buckets, mapped field by field. */
function meter(tokens: HarnessTokens): MeteredTokens {
    return {inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens, cacheWriteTokens: tokens.cacheWriteTokens,
        reasoningTokens: tokens.reasoningTokens};
}

/**
 * HarnessTokens is the remote node's wire shape and MeteredTokens is the billing shape.
 * Mapping explicitly keeps a wire change from silently becoming a billing change: adding a
 * bucket to either side now fails to compile here instead of mispricing through structural luck.
 */
export function meteredUsage(usage: HarnessUsage): MeteredUsage {
    return {complete: usage.complete, revision: usage.revision, totals: meter(usage.totals),
        entries: usage.entries.map(entry => ({id: entry.id, providerId: entry.providerId,
            modelId: entry.modelId, tokens: meter(entry.tokens)}))};
}

/** Host-injected policy: no prices or provider names enter the conversation mechanism. */
export function createUsageCostEstimator(pricing: () => ModelPricingConfig): (usage: HarnessUsage) => UsageCostEstimate {
    let previous: ModelPricingConfig | undefined;
    const quotes = new Map<string, {revision: string; value: UsageCostEstimate}>();
    return usage => {
        const config = pricing();
        if (previous !== config) { quotes.clear(); previous = config; }
        const cached = quotes.get(usage.sessionId);
        if (cached?.revision === usage.revision) return cached.value;
        const value = estimateUsageCost(meteredUsage(usage), config);
        if (quotes.size >= 128) quotes.delete(quotes.keys().next().value!);
        quotes.set(usage.sessionId, {revision: usage.revision, value});
        return value;
    };
}
