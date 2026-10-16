import { estimateUsageCost, type ModelPricingConfig, type UsageCostEstimate } from '@itookit/kernel-adapters/contracts';
import type { HarnessUsage } from '@itookit/piagent-driver';

/** Host-injected policy: no prices or provider names enter the conversation mechanism. */
export function createUsageCostEstimator(pricing: () => ModelPricingConfig): (usage: HarnessUsage) => UsageCostEstimate {
    let previous: ModelPricingConfig | undefined;
    const quotes = new Map<string, {revision: string; value: UsageCostEstimate}>();
    return usage => {
        const config = pricing();
        if (previous !== config) { quotes.clear(); previous = config; }
        const cached = quotes.get(usage.sessionId);
        if (cached?.revision === usage.revision) return cached.value;
        const value = estimateUsageCost(usage, config);
        if (quotes.size >= 128) quotes.delete(quotes.keys().next().value!);
        quotes.set(usage.sessionId, {revision: usage.revision, value});
        return value;
    };
}
