// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { CostRecord } from '@itookit/kernel-adapters/contracts';
import { CostEditor } from '../src/editors/CostEditor';
import { costTrendBuckets, costTrendRange, renderCostTrend } from '../src/editors/cost-trend';

const editors: CostEditor[] = [];
afterEach(async () => {
    await Promise.all(editors.splice(0).map(editor => editor.destroy()));
    vi.useRealTimers(); document.body.innerHTML = '';
});
function record(date: string, cost = 1): CostRecord {
    return { date, cost, requests: 1, sessionId: 's', providerId: 'p', connectionId: 'c', modelId: 'm', inputTokens: 10, outputTokens: 5 };
}
async function mount(queryCosts = vi.fn().mockResolvedValue([record('2026-01-01')])) {
    const container = document.createElement('div'); document.body.append(container);
    const editor = new CostEditor(container, { queryCosts } as never, {}); editors.push(editor);
    await editor.init(container); return { container, queryCosts };
}
function openTrend(container: HTMLElement): void {
    const details = container.querySelector<HTMLDetailsElement>('#cost-trend-details')!;
    details.open = true; details.dispatchEvent(new Event('toggle'));
}

it('uses UTC boundaries and twelve calendar months across a year transition', () => {
    const now = new Date('2026-01-01T00:30:00+08:00');
    expect(costTrendRange('day', now)).toEqual({ dateFrom: '2025-12-01', dateTo: '2025-12-31' });
    const range = costTrendRange('month', now);
    expect(range).toEqual({ dateFrom: '2025-01-01', dateTo: '2025-12-31' });
    expect(costTrendBuckets([], 'month', range)).toHaveLength(12);
});

it('aggregates providers without including records beyond the selected period', () => {
    const records = [record('2026-01-01', 2), record('2026-01-01', 3), record('2025-12-31', 100), record('2026-01-04', 100)];
    const range = { dateFrom: '2026-01-01', dateTo: '2026-01-03' };
    expect(costTrendBuckets(records, 'day', range)).toEqual([
        { date: '2026-01-01', cost: 5, tokens: 30, requests: 2 },
        { date: '2026-01-02', cost: 0, tokens: 0, requests: 0 },
        { date: '2026-01-03', cost: 0, tokens: 0, requests: 0 },
    ]);
    expect(costTrendBuckets(records, 'month', range)[0]).toMatchObject({ cost: 5, tokens: 30, requests: 2 });
    const html = renderCostTrend(records, 'day', range);
    expect(html).toContain('2026-01-01: $5.0000');
    expect(html).not.toContain('NaN');
    expect(renderCostTrend([record('2026-01-01', 0)], 'day', range)).toContain('2026-01-01: $0.0000');
});

it('starts with a monthly summary and lazy, collapsed trends and pricing', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
    const { container, queryCosts } = await mount();
    expect(queryCosts).toHaveBeenCalledTimes(1);
    expect(queryCosts).toHaveBeenCalledWith({ dateFrom: '2026-01-01', dateTo: '2026-01-15' });
    expect(container.querySelector<HTMLDetailsElement>('#cost-trend-details')!.open).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>('#cost-panel-pricing')!.open).toBe(false);
    expect(container.querySelector('.settings-page__description')!.textContent).toContain('harness session');
    openTrend(container); await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll('.cost-trend')).toHaveLength(2);
    container.querySelector<HTMLButtonElement>('[data-trend="month"]')!.click(); await vi.advanceTimersByTimeAsync(0);
    expect(queryCosts).toHaveBeenLastCalledWith({ dateFrom: '2025-02-01', dateTo: '2026-01-15' });
    expect(container.querySelectorAll('.cost-trend__column')).toHaveLength(24);
});

it('shows loading errors instead of a zero-cost summary', async () => {
    const { container } = await mount(vi.fn().mockRejectedValue(new Error('unavailable')));
    expect(container.querySelector('#cost-summary-grid')!.textContent).not.toContain('$0.00');
    expect(container.querySelector('#cost-summary-grid')!.textContent).not.toContain('加载中');
});

it('does not replace a newer trend with a slow older response', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
    let resolveOld!: (records: CostRecord[]) => void;
    const query = vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise<CostRecord[]>(resolve => { resolveOld = resolve; }))
        .mockResolvedValue([record('2025-02-01', 9)]);
    const { container } = await mount(query);
    openTrend(container);
    container.querySelector<HTMLButtonElement>('[data-trend="month"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    resolveOld([record('2026-01-01', 100)]); await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('#cost-trend-chart')!.innerHTML).toContain('2025-02-01');
    expect(container.querySelector('#cost-trend-chart')!.innerHTML).not.toContain('$100.0000');
});
