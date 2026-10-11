import { escapeHTML, t } from '@itookit/common';
import type { CostRecord } from '@itookit/kernel-adapters/contracts';

export type CostTrendPeriod = 'day' | 'month';
interface Range { dateFrom: string; dateTo: string; }
interface Bucket { date: string; cost: number; tokens: number; requests: number; }

/** Match the UTC dates persisted by CostStore. */
export function costTrendRange(period: CostTrendPeriod, now = new Date()): Range {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (period === 'month' ? 11 : 0), 1));
    return { dateFrom: start.toISOString().slice(0, 10), dateTo: now.toISOString().slice(0, 10) };
}

export function costTrendBuckets(records: CostRecord[], period: CostTrendPeriod, range: Range): Bucket[] {
    const buckets = new Map<string, Bucket>();
    const cursor = new Date(`${range.dateFrom}T00:00:00Z`);
    while (cursor.toISOString().slice(0, 10) <= range.dateTo) {
        const date = cursor.toISOString().slice(0, period === 'day' ? 10 : 7);
        buckets.set(date, { date, cost: 0, tokens: 0, requests: 0 });
        if (period === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
        else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    for (const record of records) {
        if (record.date < range.dateFrom || record.date > range.dateTo) continue;
        const bucket = buckets.get(record.date.slice(0, period === 'day' ? 10 : 7));
        if (!bucket) continue;
        bucket.cost += record.cost;
        bucket.tokens += record.inputTokens + record.outputTokens;
        bucket.requests += record.requests;
    }
    return [...buckets.values()];
}

function chart(buckets: Bucket[], metric: 'cost' | 'tokens'): string {
    const maximum = Math.max(0, ...buckets.map(bucket => bucket[metric]));
    const heading = t(metric === 'cost' ? 'settings.cost.recordedCost' : 'settings.cost.tokens');
    const scale = metric === 'cost' ? `$${maximum.toFixed(4)}` : maximum.toLocaleString();
    const columns = buckets.map(bucket => {
        const value = metric === 'cost' ? `$${bucket.cost.toFixed(4)}` : bucket.tokens.toLocaleString();
        const description = `${bucket.date}: ${bucket.requests ? value : t('settings.cost.noRecord')}`;
        const height = maximum > 0 ? bucket[metric] / maximum * 100 : 0;
        return `<div class="cost-trend__column" tabindex="0" aria-label="${escapeHTML(description)}" title="${escapeHTML(description)}">
            <div class="cost-trend__track"><div class="cost-trend__bar" style="height:${height.toFixed(2)}%"></div></div>
            <span>${bucket.date.slice(bucket.date.length === 7 ? 2 : 5)}</span></div>`;
    }).join('');
    return `<section class="cost-trend"><h3>${escapeHTML(heading)} · 0 — ${scale}</h3><div class="cost-trend__columns">${columns}</div></section>`;
}

export function renderCostTrend(records: CostRecord[], period: CostTrendPeriod, range: Range): string {
    const buckets = costTrendBuckets(records, period, range);
    if (!buckets.some(bucket => bucket.requests > 0)) return `<p class="cost-empty">${t('settings.cost.empty')}</p>`;
    return `<p class="cost-fold__hint">${range.dateFrom} — ${range.dateTo} · UTC</p>${chart(buckets, 'cost')}${chart(buckets, 'tokens')}`;
}
