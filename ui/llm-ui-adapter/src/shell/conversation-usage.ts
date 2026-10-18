import { getLocale, t } from '@itookit/common';
import type { ConversationSnapshot } from '@itookit/ui-common';

/** Renders host-prepared usage and quotes; no provider catalogs or pricing rules. */
export function conversationUsage(snapshot: ConversationSnapshot): string {
    if (snapshot.usageUnavailable) return t('harness.usageUnknown');
    const usage = snapshot.usage;
    if (!usage) return '';
    const tokens = usage.totals;
    const total = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens;
    const count = new Intl.NumberFormat(getLocale()).format(total);
    const estimate = snapshot.usageEstimate;
    const amount = estimate?.estimatedCostUsd;
    const cost = typeof amount === 'number'
        ? `${t('harness.estimatedCost')} ≈ ${new Intl.NumberFormat(getLocale(), {style: 'currency', currency: estimate!.currency, maximumFractionDigits: amount > 0 && amount < 0.01 ? 6 : 2}).format(amount)}`
        : t('harness.usageUnknown');
    return [`${t('harness.usage')} ${count}`, cost, !usage.complete || estimate && !estimate.complete ? t('harness.usagePartial') : ''].filter(Boolean).join(' · ');
}
