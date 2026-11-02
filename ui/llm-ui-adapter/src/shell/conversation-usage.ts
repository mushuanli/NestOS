import type {ConversationSnapshot} from '../contracts';
import { getLocale, t } from '@itookit/common';


/** Renders host-prepared usage and quotes; no provider catalogs or pricing rules. */
export function conversationUsage(snapshot: ConversationSnapshot): string {
    if (snapshot.usageUnavailable) return t('harness.usageUnknown');
    const usage = snapshot.usage;
    if (!usage) return '';
    const tokens = usage.totals;
    const total = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens;
    const count = new Intl.NumberFormat(getLocale()).format(total);
    return [`${t('harness.usage')} ${count}`, !usage.complete ? t('harness.usagePartial') : ''].filter(Boolean).join(' · ');
}
