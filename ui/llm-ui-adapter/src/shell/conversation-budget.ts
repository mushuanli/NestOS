import type {ConversationSnapshot} from '../contracts';
import {getLocale, t} from '@itookit/common';

export interface ConversationBudget {kind: 'quota' | 'cost' | 'unknown'; label: string; value: string; compactValue?: string; detail: string; warning?: boolean}
type Window = NonNullable<NonNullable<ConversationSnapshot['metrics']>['quota']>['windows'][number];
const count = (n: number) => new Intl.NumberFormat(getLocale(), {maximumFractionDigits: 1}).format(n);
const money = (n: number) => new Intl.NumberFormat(getLocale(), {style: 'currency', currency: 'USD', maximumFractionDigits: n > 0 && n < 0.01 ? 6 : 2}).format(n);
function windowLabel(row: Window): string {
    const minutes = row.windowMinutes;
    if (minutes) {
        if (minutes % 1440 === 0) return t('harness.metricsWindowDays', {days: count(minutes / 1440)});
        if (minutes % 60 === 0) return t('harness.metricsWindowHours', {hours: count(minutes / 60)});
        return t('harness.metricsWindow', {minutes: count(minutes)});
    }
    return row.id === 'primary' ? t('harness.metricsPrimary') : row.id === 'secondary' ? t('harness.metricsSecondary') : row.id;
}
function windowText(row: Window): string {
    const label = windowLabel(row);
    const value = row.usedPercent == null ? label : t('harness.metricsQuotaValue', {window: label, used: count(row.usedPercent), remaining: count(Math.max(0, 100 - row.usedPercent))});
    const status = row.status ? t(`harness.metricsStatus.${row.status}`) : '';
    const reset = row.resetsAt == null ? '' : t('harness.metricsReset', {time: new Date(row.resetsAt).toLocaleString(getLocale(), {hour12: false})});
    return [value, status, reset].filter(Boolean).join(' · ');
}
function quotaBudget(quota: NonNullable<NonNullable<ConversationSnapshot['metrics']>['quota']>): ConversationBudget | undefined {
    const rows = quota.windows.filter(row => row.usedPercent != null || row.status);
    if (!rows.length && !quota.unlimited && quota.creditBalance == null) return;
    const remaining = rows.flatMap(row => row.usedPercent == null ? [] : [Math.max(0, 100 - row.usedPercent)]);
    const rejected = rows.some(row => row.status === 'rejected');
    const value = rejected ? t('harness.metricsStatus.rejected') : remaining.length ? t('harness.budgetRemaining', {percent: count(Math.min(...remaining))})
        : quota.unlimited ? t('harness.budgetUnlimited') : quota.creditBalance != null ? t('harness.metricsCredits', {balance: quota.creditBalance}) : t('harness.budgetAvailable');
    const details = rows.map(windowText);
    if (quota.unlimited) details.push(t('harness.metricsUnlimited'));
    if (quota.creditBalance != null) details.push(t('harness.metricsCredits', {balance: quota.creditBalance}));
    return {kind: 'quota', label: t('harness.budgetQuota'), value, compactValue: !rejected && remaining.length ? `${count(Math.min(...remaining))}%` : value, detail: details.join('\n'),
        warning: rejected || rows.some(row => row.status === 'allowed_warning') || remaining.some(n => n <= 10)};
}
/** Choose exactly one observation, without inferring a subscription from a model name. */
export function conversationBudget(snapshot: ConversationSnapshot): ConversationBudget {
    const quota = snapshot.metrics?.quota && quotaBudget(snapshot.metrics.quota);
    if (quota) return quota;
    const native = snapshot.metrics?.cost?.amountUsd;
    const host = snapshot.usageUnavailable ? undefined : snapshot.usageEstimate?.estimatedCostUsd;
    const amount = native ?? host;
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
        const label = t('harness.budgetCost'), value = `≈ ${money(amount)}`;
        const detail = [native != null ? t('harness.metricsNativeCost') : t('harness.estimatedCost'), value,
            native == null && !snapshot.usageEstimate?.complete ? t('harness.usagePartial') : '', t('harness.budgetEstimateHelp')].filter(Boolean).join(' · ');
        return {kind: 'cost', label, value, detail};
    }
    return {kind: 'unknown', label: t('harness.budgetUnknownLabel'), value: '—', detail: t('harness.budgetUnknown')};
}
