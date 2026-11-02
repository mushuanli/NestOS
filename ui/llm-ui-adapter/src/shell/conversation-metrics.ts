import type {ConversationSnapshot} from '../contracts';
import {getLocale, t} from '@itookit/common';

import {conversationBudget} from './conversation-budget';
const count = (n: number) => new Intl.NumberFormat(getLocale(), {maximumFractionDigits: 1}).format(n);
export function conversationContext(snapshot: ConversationSnapshot): string {
    const context = snapshot.metrics?.contextWindow;
    if (!context) return t('harness.metricsUnknown');
    const value = context.usedTokens == null ? t('harness.metricsContextLimit', {limit: count(context.limitTokens)})
        : t('harness.metricsContextValue', {used: count(context.usedTokens), limit: count(context.limitTokens), percent: new Intl.NumberFormat(getLocale(), {maximumSignificantDigits: 3}).format(context.usedTokens / context.limitTokens * 100)});
    return `${value}\n${t('harness.metricsContextSource')}`;
}
export function conversationMetrics(snapshot: ConversationSnapshot): Array<[string, string]> {
    const metrics = snapshot.metrics, budget = conversationBudget(snapshot);
    const rows: Array<[string, string]> = [[t('harness.metricsContext'), conversationContext(snapshot)], [budget.label, budget.detail]];
    if (metrics) rows.push([t('harness.metricsFetched'), new Date(metrics.observedAt).toLocaleString(getLocale(), {hour12: false})]);
    const codes = [snapshot.metricsError?.code, ...Object.values(metrics?.errors ?? {})].filter(Boolean);
    if (codes.length) rows.push([t('harness.metricsTitle'), t('harness.metricsError', {code: codes.join(', ')})]);
    return rows;
}
