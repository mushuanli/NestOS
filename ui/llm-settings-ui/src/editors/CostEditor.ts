import { SettingsValidationError, requestSettingsSave } from '@itookit/ui-common';
// @file: llm-ui/editors/CostEditor.ts
//
// 费用统计 & 定价配置编辑器。
//
// 职责：
// Monthly summaries, collapsible UTC daily/monthly trends, and provider/session breakdowns.
// Pricing edits save automatically without recalculating historical ledger entries.

import { aggregateCostRecords, lookupPricingEntry } from '@itookit/kernel-adapters/contracts';
import { t } from '@itookit/common';
import type { IAgentManagementService, CostRecord, ModelPricingEntry, ModelPricingConfig } from '@itookit/kernel-adapters/contracts';
import { costTrendRange, renderCostTrend, type CostTrendPeriod } from './cost-trend';
import { BaseSettingsEditor } from '@itookit/ui-common';

type Period = 'today' | 'week' | 'month';

interface SessionAgg {
    sessionId: string;
    providerId: string;
    modelId: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    requests: number;
}

export class CostEditor extends BaseSettingsEditor<IAgentManagementService> {
    private activePeriod: Period = 'month';
    private trendPeriod: CostTrendPeriod = 'day';
    private dashboardGeneration = 0;
    private trendGeneration = 0;
    private filterProviderId = '';

    private editablePricing: ModelPricingEntry[] = [];
    private pricingInitialized = false;
    private expandedPricingIdx: number | null = null;

    async render(): Promise<void> {
        if (!await this.prepareRender()) return;
        this.pricingInitialized = false;
        this.clearListeners();
        this.container.innerHTML = `
            <div class="settings-page">
                <div class="settings-page__header">
                    <div>
                        <h2 class="settings-page__title">${t('settings.cost.title')}</h2>
                        <p class="settings-page__description">
                            ${t('settings.cost.scope')}
                        </p>
                    </div>
                </div>

                <div id="cost-panel-dashboard">
                    <div class="cost-filters">
                        <div class="cost-filters__time" role="group" aria-label="时间范围">
                            <button class="cost-time-btn${this.activePeriod === 'today' ? ' cost-time-btn--active' : ''}" data-period="today" aria-pressed="${this.activePeriod === 'today'}">今日</button>
                            <button class="cost-time-btn${this.activePeriod === 'week' ? ' cost-time-btn--active' : ''}" data-period="week" aria-pressed="${this.activePeriod === 'week'}">本周</button>
                            <button class="cost-time-btn${this.activePeriod === 'month' ? ' cost-time-btn--active' : ''}" data-period="month" aria-pressed="${this.activePeriod === 'month'}">本月</button>
                        </div>
                        <select class="cost-filters__provider" id="cost-filter-provider" aria-label="Provider 过滤">
                            <option value="">All Providers</option>
                        </select>
                    </div>

                    <div id="cost-summary-grid" class="cost-summary-grid">
                        ${this.renderSummaryPlaceholder()}
                    </div>

                    <details class="cost-fold" id="cost-trend-details">
                        <summary>${t('settings.cost.trend')}</summary>
                        <p class="cost-fold__hint">${t('settings.cost.trendHelp')}</p>
                        <div class="cost-filters__time" role="group" aria-label="${t('settings.cost.granularity')}">
                            <button class="cost-time-btn${this.trendPeriod === 'day' ? ' cost-time-btn--active' : ''}" data-trend="day" aria-pressed="${this.trendPeriod === 'day'}">${t('settings.cost.day')}</button>
                            <button class="cost-time-btn${this.trendPeriod === 'month' ? ' cost-time-btn--active' : ''}" data-trend="month" aria-pressed="${this.trendPeriod === 'month'}">${t('settings.cost.month')}</button>
                        </div>
                        <div id="cost-trend-chart" aria-live="polite"></div>
                    </details>
                    <details class="cost-fold">
                        <summary>${t('settings.cost.breakdown')}</summary>
                    <div class="cost-section">
                        <h3 class="cost-section__title">按 Provider 分组</h3>
                        <div id="cost-provider-breakdown" class="cost-provider-list">
                            <div class="cost-loading">加载中...</div>
                        </div>
                    </div>

                    <div class="cost-section">
                        <h3 class="cost-section__title">Top 10 Sessions（按费用降序）</h3>
                        <div class="cost-table-wrapper">
                            <table class="cost-table">
                                <thead>
                                    <tr>
                                        <th>Session ID</th>
                                        <th>Provider</th>
                                        <th>Model</th>
                                        <th>费用 (USD)</th>
                                        <th>Tokens</th>
                                        <th>请求数</th>
                                    </tr>
                                </thead>
                                <tbody id="cost-top-sessions">
                                    <tr><td colspan="6" class="cost-loading">加载中...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    </details>
                </div>

                <details class="cost-fold" id="cost-panel-pricing">
                    <summary>${t('settings.cost.pricing')}</summary>
                    <p class="cost-fold__hint">${t('settings.cost.pricingHelp')}</p>
                    <div class="cost-pricing-toolbar">
                        <p class="cost-pricing-toolbar__desc">
                            ${t('settings.autosave.hint')}
                        </p>
                        <div class="cost-pricing-toolbar__actions">
                            <button class="settings-btn settings-btn--secondary" id="btn-add-pricing">+ 添加条目</button>
                            <button class="settings-btn settings-btn--secondary" id="btn-reset-pricing" title="恢复为内置默认定价表">恢复默认</button>

                        </div>
                    </div>
                    <div class="cost-pricing-list" id="cost-pricing-list">
                        <div class="cost-pricing-header">
                            <span>逻辑 ID / 别名（names）</span>
                            <span>价格（USD/M tokens）: Input · Output · Cache Write · Cache Read</span>
                            <span></span>
                        </div>
                        <div id="cost-pricing-rows">
                            <div class="cost-loading">加载中...</div>
                        </div>
                    </div>
                </details>
            </div>
        `;

        this.bindFoldEvents();
        this.bindDashboardEvents();
        await this.loadDashboardData();

    }

    private bindFoldEvents(): void {
        const pricing = this.container.querySelector<HTMLDetailsElement>('#cost-panel-pricing')!;
        this.addEventListener(pricing, 'toggle', () => {
            if (pricing.open && !this.pricingInitialized) this.initPricingPanel();
        });
        const trend = this.container.querySelector<HTMLDetailsElement>('#cost-trend-details')!;
        this.addEventListener(trend, 'toggle', () => { if (trend.open) void this.loadTrend(); });
        this.container.querySelectorAll<HTMLButtonElement>('[data-trend]').forEach(button => {
            this.addEventListener(button, 'click', () => {
                this.trendPeriod = button.dataset.trend as CostTrendPeriod;
                this.container.querySelectorAll<HTMLElement>('[data-trend]').forEach(item => {
                    const active = item.dataset.trend === this.trendPeriod;
                    item.classList.toggle('cost-time-btn--active', active);
                    item.setAttribute('aria-pressed', String(active));
                });
                void this.loadTrend();
            });
        });
    }

    private async loadTrend(): Promise<void> {
        const target = this.container.querySelector<HTMLElement>('#cost-trend-chart');
        if (!target) return;
        const generation = ++this.trendGeneration;
        const period = this.trendPeriod;
        const range = costTrendRange(period);
        target.textContent = t('settings.cost.loading');
        try {
            const records = await this.service.queryCosts({ ...range, ...(this.filterProviderId ? { providerId: this.filterProviderId } : {}) });
            if (generation === this.trendGeneration && target.isConnected) target.innerHTML = renderCostTrend(records, period, range);
        } catch {
            if (generation === this.trendGeneration) target.textContent = t('settings.cost.loadFailed');
        }
    }

    // ─── Dashboard ────────────────────────────────────────────────────────────

    private bindDashboardEvents(): void {
        const timeBtns = this.container.querySelectorAll('.cost-time-btn[data-period]');
        timeBtns.forEach(btn => {
            this.addEventListener(btn as HTMLElement, 'click', () => {
                const p = (btn as HTMLElement).dataset.period as Period;
                if (p === this.activePeriod) return;
                this.activePeriod = p;
                timeBtns.forEach(b => {
                    const active = (b as HTMLElement).dataset.period === p;
                    b.classList.toggle('cost-time-btn--active', active); b.setAttribute('aria-pressed', String(active));
                });
                this.loadDashboardData();
            });
        });

        const providerSelect = this.container.querySelector('#cost-filter-provider') as HTMLSelectElement;
        if (providerSelect) {
            this.addEventListener(providerSelect, 'change', () => {
                this.filterProviderId = providerSelect.value;
                this.loadDashboardData();
                if (this.container.querySelector<HTMLDetailsElement>('#cost-trend-details')?.open) void this.loadTrend();
            });
        }
    }

    private async loadDashboardData(): Promise<void> {
        const generation = ++this.dashboardGeneration;
        const summaryEl = this.container.querySelector('#cost-summary-grid');
        const breakdownEl = this.container.querySelector('#cost-provider-breakdown');
        const sessionsEl = this.container.querySelector('#cost-top-sessions');

        if (breakdownEl) breakdownEl.innerHTML = '<div class="cost-loading">加载中...</div>';
        if (sessionsEl) sessionsEl.innerHTML = '<tr><td colspan="6" class="cost-loading">加载中...</td></tr>';

        const { dateFrom, dateTo } = this.getDateRange(this.activePeriod);
        const filter: { dateFrom?: string; dateTo?: string; providerId?: string } = { dateFrom, dateTo };
        if (this.filterProviderId) filter.providerId = this.filterProviderId;

        let records: CostRecord[] = [];
        try {
            records = await this.service.queryCosts(filter);
        } catch (e) {
            console.error('[CostEditor] queryCosts failed:', e);
            if (generation !== this.dashboardGeneration) return;
            if (summaryEl) summaryEl.textContent = t('settings.cost.loadFailed');
            if (breakdownEl) breakdownEl.textContent = t('settings.cost.loadFailed');
            if (sessionsEl) sessionsEl.innerHTML = `<tr><td colspan="6">${t('settings.cost.loadFailed')}</td></tr>`;
            return;
        }
        if (generation !== this.dashboardGeneration || !summaryEl?.isConnected) return;

        const agg = aggregateCostRecords(records);

        if (summaryEl) {
            summaryEl.innerHTML = records.length ? this.renderSummaryCards(agg) : `<p class="cost-empty">${t('settings.cost.empty')}</p>`;
        }

        this.updateProviderFilterOptions(records);

        if (breakdownEl) {
            const byProvider = this.aggregateByProvider(records);
            breakdownEl.innerHTML = this.renderProviderBreakdown(byProvider, agg.cost);
        }

        if (sessionsEl) {
            const top10 = this.getTop10Sessions(records);
            sessionsEl.innerHTML = this.renderTopSessions(top10);
        }
    }

    private getDateRange(period: Period): { dateFrom: string; dateTo: string } {
        const today = new Date();
        const fmt = (d: Date): string => {
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, '0');
            const day = String(d.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        const todayStr = fmt(today);

        if (period === 'today') return { dateFrom: todayStr, dateTo: todayStr };

        if (period === 'week') {
            const start = new Date(today);
            start.setUTCDate(today.getUTCDate() - today.getUTCDay());
            return { dateFrom: fmt(start), dateTo: todayStr };
        }

        // month
        const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        return { dateFrom: fmt(start), dateTo: todayStr };
    }

    private updateProviderFilterOptions(records: CostRecord[]): void {
        const select = this.container.querySelector('#cost-filter-provider') as HTMLSelectElement;
        if (!select) return;

        const providers = [...new Set([...Array.from(select.options).map(option => option.value), ...records.map(r => r.providerId), this.filterProviderId])].filter(Boolean).sort();
        const current = this.filterProviderId;

        select.innerHTML = `<option value="">All Providers</option>` +
            providers.map(p => `<option value="${this.escapeHtml(p)}" ${p === current ? 'selected' : ''}>${this.escapeHtml(p)}</option>`).join('');
    }

    private aggregateByProvider(records: CostRecord[]): Map<string, { cost: number; inputTokens: number; outputTokens: number; requests: number }> {
        const map = new Map<string, { cost: number; inputTokens: number; outputTokens: number; requests: number }>();
        for (const r of records) {
            const existing = map.get(r.providerId);
            if (existing) {
                existing.cost += r.cost;
                existing.inputTokens += r.inputTokens;
                existing.outputTokens += r.outputTokens;
                existing.requests += r.requests;
            } else {
                map.set(r.providerId, {
                    cost: r.cost,
                    inputTokens: r.inputTokens,
                    outputTokens: r.outputTokens,
                    requests: r.requests,
                });
            }
        }
        return map;
    }

    private getTop10Sessions(records: CostRecord[]): SessionAgg[] {
        const map = new Map<string, SessionAgg>();
        for (const r of records) {
            const existing = map.get(r.sessionId);
            if (existing) {
                existing.cost += r.cost;
                existing.inputTokens += r.inputTokens;
                existing.outputTokens += r.outputTokens;
                existing.cacheWriteTokens += r.cacheWriteTokens ?? 0;
                existing.cacheReadTokens += r.cacheReadTokens ?? 0;
                existing.requests += r.requests;
                // Keep the provider/model from the record with most requests
                if (r.requests > existing.requests) {
                    existing.providerId = r.providerId;
                    existing.modelId = r.modelId;
                }
            } else {
                map.set(r.sessionId, {
                    sessionId: r.sessionId,
                    providerId: r.providerId,
                    modelId: r.modelId,
                    cost: r.cost,
                    inputTokens: r.inputTokens,
                    outputTokens: r.outputTokens,
                    cacheWriteTokens: r.cacheWriteTokens ?? 0,
                    cacheReadTokens: r.cacheReadTokens ?? 0,
                    requests: r.requests,
                });
            }
        }

        return [...map.values()]
            .sort((a, b) => b.cost - a.cost)
            .slice(0, 10);
    }

    // ─── Dashboard Render ─────────────────────────────────────────────────────

    private renderSummaryPlaceholder(): string {
        return `
            <div class="cost-summary-card">
                <div class="cost-summary-card__label">${t('settings.cost.recordedCost')}</div>
                <div class="cost-summary-card__value cost-summary-card__value--primary">$-</div>
            </div>
            <div class="cost-summary-card">
                <div class="cost-summary-card__label">总 Tokens</div>
                <div class="cost-summary-card__value">-</div>
            </div>
            <div class="cost-summary-card">
                <div class="cost-summary-card__label">总请求数</div>
                <div class="cost-summary-card__value">-</div>
            </div>
        `;
    }

    private renderSummaryCards(agg: ReturnType<typeof aggregateCostRecords>): string {
        const cacheTotal = (agg.cacheWriteTokens ?? 0) + (agg.cacheReadTokens ?? 0);
        return `
            <div class="cost-summary-card">
                <div class="cost-summary-card__label">${t('settings.cost.recordedCost')}</div>
                <div class="cost-summary-card__value cost-summary-card__value--primary">${this.formatCost(agg.cost)}</div>
            </div>
            <div class="cost-summary-card">
                <div class="cost-summary-card__label">总 Tokens</div>
                <div class="cost-summary-card__value">
                    <div class="cost-token-badges">
                        <span class="cost-token-badge cost-token-badge--input" title="Input tokens">In: ${this.formatTokens(agg.inputTokens)}</span>
                        <span class="cost-token-badge cost-token-badge--output" title="Output tokens">Out: ${this.formatTokens(agg.outputTokens)}</span>
                        ${cacheTotal > 0 ? `<span class="cost-token-badge cost-token-badge--cache" title="Cache tokens">Cache: ${this.formatTokens(cacheTotal)}</span>` : ''}
                    </div>
                </div>
            </div>
            <div class="cost-summary-card">
                <div class="cost-summary-card__label">总请求数</div>
                <div class="cost-summary-card__value">${agg.requests.toLocaleString()}</div>
            </div>
        `;
    }

    private renderProviderBreakdown(
        byProvider: Map<string, { cost: number; inputTokens: number; outputTokens: number; requests: number }>,
        totalCost: number,
    ): string {
        if (byProvider.size === 0) {
            return '<div class="cost-empty">该时间段内暂无费用记录</div>';
        }

        const sorted = [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost);
        const maxCost = sorted[0]?.[1]?.cost ?? 1;

        return sorted.map(([providerId, data]) => {
            const pct = maxCost > 0 ? (data.cost / maxCost) * 100 : 0;
            const totalPct = totalCost > 0 ? ((data.cost / totalCost) * 100).toFixed(1) : '0';
            return `
                <div class="cost-provider-row">
                    <div class="cost-provider-row__name" title="${this.escapeHtml(providerId)}">${this.escapeHtml(providerId)}</div>
                    <div class="cost-provider-row__bar">
                        <div class="cost-provider-row__bar-fill" style="width:${pct.toFixed(1)}%"></div>
                    </div>
                    <div class="cost-provider-row__cost">${this.formatCost(data.cost)} <span style="font-size:0.75rem;font-weight:400;color:var(--st-text-secondary)">(${totalPct}%)</span></div>
                    <div class="cost-provider-row__tokens">In: ${this.formatTokens(data.inputTokens)} · Out: ${this.formatTokens(data.outputTokens)} · ${data.requests} 请求</div>
                </div>
            `;
        }).join('');
    }

    private renderTopSessions(sessions: SessionAgg[]): string {
        if (sessions.length === 0) {
            return '<tr><td colspan="6" class="cost-empty">该时间段内暂无 Session 费用记录</td></tr>';
        }

        return sessions.map((s, i) => `
            <tr>
                <td><span class="cost-table__session-id" title="${this.escapeHtml(s.sessionId)}">#${i + 1} ${this.truncateId(s.sessionId)}</span></td>
                <td>${this.escapeHtml(s.providerId)}</td>
                <td><span class="cost-table__model" title="${this.escapeHtml(s.modelId)}">${this.escapeHtml(s.modelId)}</span></td>
                <td class="cost-table__cost">${this.formatCost(s.cost)}</td>
                <td>
                    <div class="cost-token-badges">
                        <span class="cost-token-badge cost-token-badge--input" title="Input">${this.formatTokens(s.inputTokens)}</span>
                        <span class="cost-token-badge cost-token-badge--output" title="Output">${this.formatTokens(s.outputTokens)}</span>
                    </div>
                </td>
                <td>${s.requests}</td>
            </tr>
        `).join('');
    }

    // ─── Pricing Panel ────────────────────────────────────────────────────────

    private initPricingPanel(): void {
        this.pricingInitialized = true;
        const config = this.service.getPricingConfig();
        this.editablePricing = config.model_pricing.map(e => ({
            id: e.id,
            fallbackFor: e.fallbackFor ? [...e.fallbackFor] : undefined,
            price: [...e.price] as [number, number, number, number],
            providers: JSON.parse(JSON.stringify(e.providers)) as Record<string, string[]>,
            names: e.names ? [...e.names] : [],
        }));

        // Ensure a "default" entry exists
        if (!this.editablePricing.some(e => e.id === 'default')) {
            this.editablePricing.push({ id: 'default', price: [0, 0, 0, 0], providers: {}, names: [] });
        }

        this.renderPricingRows();
        this.bindPricingRowDelegates();
        this.bindPricingEvents();
        const rows = this.container.querySelector<HTMLElement>('#cost-pricing-rows');
        if (rows) this.bindAutoSave(rows, () => this.savePricing(), this.container.querySelector<HTMLElement>('.cost-pricing-toolbar__actions') ?? undefined);
    }

    private bindPricingRowDelegates(): void {
        const rowsEl = this.container.querySelector<HTMLElement>('#cost-pricing-rows');
        if (!rowsEl) return;

        // These handlers are bound once on the stable container element.
        // rowsEl's innerHTML changes but the element itself persists, so delegation works.
        rowsEl.addEventListener('input', (e) => {
            const target = e.target as HTMLInputElement;
            if (!target.dataset.idx) return;
            this.markPricingDirty();
        });

        rowsEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT') return;
            const toggle = target.closest<HTMLElement>('.cost-pricing-row__id-toggle');
            if (toggle) {
                const idx = parseInt(toggle.dataset.idx ?? '-1', 10);
                if (idx >= 0) {
                    this.syncInputsToPricingData();
                    this.expandedPricingIdx = this.expandedPricingIdx === idx ? null : idx;
                    this.renderPricingRows();
                }
                return;
            }
            const btn = target.closest<HTMLElement>('.btn-delete-pricing');
            if (btn) {
                const idx = parseInt(btn.dataset.idx ?? '-1', 10);
                if (idx >= 0) this.deletePricingEntry(idx);
            }
        });
    }

    private renderPricingRows(): void {
        const container = this.container.querySelector('#cost-pricing-rows');
        if (!container) return;

        if (this.editablePricing.length === 0) {
            container.innerHTML = '<div class="cost-empty">暂无定价条目，点击「添加条目」创建</div>';
            return;
        }

        // Separate default row from normal rows; default always renders last
        const normalEntries = this.editablePricing.filter(e => e.id !== 'default');
        const defaultEntry = this.editablePricing.find(e => e.id === 'default');

        const normalHtml = normalEntries.map((entry) => {
            const idx = this.editablePricing.indexOf(entry);
            return this.renderPricingRow(entry, idx, false);
        }).join('');

        const defaultHtml = defaultEntry
            ? this.renderPricingRow(defaultEntry, this.editablePricing.indexOf(defaultEntry), true)
            : '';

        container.innerHTML = normalHtml + defaultHtml;
    }

    private renderPricingRow(entry: ModelPricingEntry, idx: number, isDefault: boolean): string {
        const namesVal = this.escapeHtml((entry.names ?? []).join(', '));
        const isExpanded = this.expandedPricingIdx === idx;

        const idInner = isDefault
            ? `<span class="cost-pricing-row__id-static" title="全局 fallback 定价，当无其他条目匹配时使用">default <span class="cost-pricing-badge">fallback</span></span>`
            : `<input class="cost-pricing-row__id-input" type="text"
                      data-idx="${idx}" data-field="id"
                      value="${this.escapeHtml(entry.id)}"
                      placeholder="逻辑 ID，如 claude-opus"
                      aria-label="模型逻辑 ID">`;

        const idCell = `
            <div class="cost-pricing-row__id-toggle" data-idx="${idx}" role="button" tabindex="0" aria-expanded="${isExpanded}">
                ${idInner}
                <span class="cost-pricing-expand-icon">${isExpanded ? '▲' : '▼'}</span>
            </div>
            ${!isDefault ? `<input class="cost-pricing-row__names-input" type="text"
                   data-idx="${idx}" data-field="names"
                   value="${namesVal}"
                   placeholder="别名，逗号分隔，支持 * 通配符，如 claude-opus-*"
                   aria-label="模型名称别名">` : ''}
        `;

        const fallbackInput = isDefault ? '' : `<input class="cost-pricing-row__names-input" type="text"
            data-idx="${idx}" data-field="fallbackFor" value="${this.escapeHtml((entry.fallbackFor ?? []).join(', '))}"
            placeholder="${this.escapeHtml(t('settings.cost.providerDefault'))}" aria-label="${this.escapeHtml(t('settings.cost.providerDefault'))}">`;
        const deleteBtn = isDefault
            ? `<span class="cost-pricing-row__no-delete" title="default 行不可删除">—</span>`
            : `<button class="settings-btn settings-btn--danger btn-delete-pricing" data-idx="${idx}" title="删除此条目">删除</button>`;

        const hitsHtml = isExpanded
            ? `<div class="cost-pricing-hits" data-hits-for="${idx}">${this.renderPricingHits(entry)}</div>`
            : '';

        return `
            <div class="cost-pricing-row${isDefault ? ' cost-pricing-row--default' : ''}" data-idx="${idx}">
                <div class="cost-pricing-row__id-cell">
                    ${idCell}${fallbackInput}
                </div>
                <div class="cost-pricing-row__prices">
                    ${this.renderPriceField(idx, 0, 'Input', entry.price[0])}
                    ${this.renderPriceField(idx, 1, 'Output', entry.price[1])}
                    ${this.renderPriceField(idx, 2, 'Cache Write', entry.price[2])}
                    ${this.renderPriceField(idx, 3, 'Cache Read', entry.price[3])}
                </div>
                <div class="cost-pricing-row__actions">
                    ${deleteBtn}
                </div>
            </div>
            ${hitsHtml}
        `;
    }

    private renderPriceField(idx: number, field: number, label: string, value: number): string {
        return `
            <div class="cost-pricing-field">
                <span class="cost-pricing-field__label">${label}</span>
                <input class="cost-pricing-input" type="number" min="0" step="0.001"
                       data-idx="${idx}" data-field="${field}"
                       value="${value}"
                       aria-label="${label} 价格">
            </div>
        `;
    }

    private bindPricingEvents(): void {
        const addBtn = this.container.querySelector('#btn-add-pricing');
        if (addBtn) {
            this.addEventListener(addBtn as HTMLElement, 'click', () => this.addPricingEntry());
        }

        const resetBtn = this.container.querySelector('#btn-reset-pricing');
        if (resetBtn) {
            this.addEventListener(resetBtn as HTMLElement, 'click', () => this.resetPricing());
        }
    }

    private markPricingDirty(): void {
        const rows = this.container.querySelector<HTMLElement>('#cost-pricing-rows');
        if (rows) requestSettingsSave(rows);
    }

    private syncInputsToPricingData(): void {
        const rowEls = this.container.querySelectorAll('.cost-pricing-row[data-idx]');
        rowEls.forEach(row => {
            const idx = parseInt((row as HTMLElement).dataset.idx ?? '-1', 10);
            if (idx < 0 || idx >= this.editablePricing.length) return;
            const entry = this.editablePricing[idx];

            if (entry.id !== 'default') {
                const idInput = row.querySelector<HTMLInputElement>('[data-field="id"]');
                if (idInput) entry.id = idInput.value.trim();

                const fallback = row.querySelector<HTMLInputElement>('[data-field="fallbackFor"]');
                if (fallback) entry.fallbackFor = [...new Set(fallback.value.split(',').map(s => s.trim()).filter(Boolean))];
                const namesInput = row.querySelector<HTMLInputElement>('[data-field="names"]');
                if (namesInput) {
                    entry.names = namesInput.value.split(',').map(s => s.trim()).filter(Boolean);
                }
            }

            for (let f = 0; f < 4; f++) {
                const inp = row.querySelector<HTMLInputElement>(`[data-field="${f}"]`);
                if (inp) entry.price[f] = parseFloat(inp.value) || 0;
            }
        });
    }

    private addPricingEntry(): void {
        this.syncInputsToPricingData();
        // Insert before the default row to keep default last
        const defaultIdx = this.editablePricing.findIndex(e => e.id === 'default');
        const newEntry: ModelPricingEntry = { id: '', price: [0, 0, 0, 0], providers: {}, names: [] };
        if (defaultIdx >= 0) {
            this.editablePricing.splice(defaultIdx, 0, newEntry);
        } else {
            this.editablePricing.push(newEntry);
        }
        this.renderPricingRows();
        this.markPricingDirty();
    }

    private deletePricingEntry(idx: number): void {
        this.syncInputsToPricingData();
        if (this.expandedPricingIdx === idx) this.expandedPricingIdx = null;
        this.editablePricing.splice(idx, 1);
        this.renderPricingRows();
        this.markPricingDirty();
    }

    private renderPricingHits(entry: ModelPricingEntry): string {
        if (entry.fallbackFor?.length) {
            return `<div class="cost-pricing-hits__desc">${this.escapeHtml(t('settings.cost.providerDefault'))}: ${this.escapeHtml(entry.fallbackFor.join(', '))}</div>`;
        }
        if (entry.id === 'default') {
            return `<div class="cost-pricing-hits__desc">全局 fallback：当其他条目均未命中时生效</div>`;
        }

        const config = this.service.getPricingConfig();
        const providers = this.service.getProviders();

        // Exact hits from entry.providers field
        const exactHits: string[] = [];
        const exactKeys = new Set<string>();
        for (const [pid, modelIds] of Object.entries(entry.providers)) {
            const actualIds = modelIds.length === 0 ? [entry.id] : modelIds;
            const prov = providers.find(p => p.id === pid);
            for (const mid of actualIds) {
                exactKeys.add(`${pid}::${mid}`);
                const model = prov?.models.find(m => m.id === mid);
                const icon = model?.icon ?? prov?.icon ?? '';
                const label = model ? `${this.escapeHtml(model.name)} (${this.escapeHtml(mid)})` : this.escapeHtml(mid);
                exactHits.push(
                    `<span class="cost-pricing-hits__item cost-pricing-hits__item--exact" title="精确：providers.${this.escapeHtml(pid)}">`
                    + `${icon} ${this.escapeHtml(pid)} / ${label}</span>`,
                );
            }
        }

        // Names hits: reverse-verify via lookupPricingEntry (compare by id, not reference)
        const nameHits: string[] = [];
        for (const prov of providers) {
            for (const model of prov.models) {
                if (exactKeys.has(`${prov.id}::${model.id}`)) continue;
                const matched = lookupPricingEntry(config, prov.id, model.id);
                if (matched?.id === entry.id) {
                    const icon = model.icon ?? prov.icon ?? '';
                    nameHits.push(
                        `<span class="cost-pricing-hits__item cost-pricing-hits__item--names" title="通配符匹配">`
                        + `${icon} ${this.escapeHtml(prov.id)} / ${this.escapeHtml(model.id)}</span>`,
                    );
                }
            }
        }

        const exactSec = exactHits.length
            ? `<div class="cost-pricing-hits__section-title">精确命中（providers）</div><div class="cost-pricing-hits__list">${exactHits.join('')}</div>`
            : '';
        const namesSec = nameHits.length
            ? `<div class="cost-pricing-hits__section-title">名称匹配（names 通配符）</div><div class="cost-pricing-hits__list">${nameHits.join('')}</div>`
            : '';

        return (exactSec + namesSec) || `<div class="cost-pricing-hits__empty">无已注册的 provider/model 命中此条目</div>`;
    }

    private async savePricing(): Promise<void> {
        this.syncInputsToPricingData();

        // Validate non-default rows: non-empty IDs and no duplicates
        const nonDefault = this.editablePricing.filter(e => e.id !== 'default');
        const ids = nonDefault.map(e => e.id).filter(Boolean);
        if (ids.length < nonDefault.length) {
            throw new SettingsValidationError(t('settings.autosave.invalid'));
        }
        const fallbacks = this.editablePricing.flatMap(entry => entry.fallbackFor ?? []);
        if (new Set(fallbacks).size !== fallbacks.length) throw new SettingsValidationError(t('settings.autosave.invalid'));
        const unique = new Set(ids);
        if (unique.size < ids.length) {
            throw new SettingsValidationError(t('settings.autosave.invalid'));
        }

        // Ensure default row is always last in the saved config
        const sorted = [
            ...this.editablePricing.filter(e => e.id !== 'default'),
            ...this.editablePricing.filter(e => e.id === 'default'),
        ];

        const config: ModelPricingConfig = { model_pricing: sorted };
        await this.service.writePricing(structuredClone(config));
    }

    private async resetPricing(): Promise<void> {
        const confirmed = window.confirm(
            '恢复默认定价表将丢弃所有自定义修改，替换为系统内置的定价条目。\n\n是否继续？'
        );
        if (!confirmed) return;

        const defaults = this.service.getPricingDefaults();
        this.editablePricing = defaults.model_pricing.map(e => ({
            id: e.id,
            fallbackFor: e.fallbackFor ? [...e.fallbackFor] : undefined,
            price: [...e.price] as [number, number, number, number],
            providers: JSON.parse(JSON.stringify(e.providers)) as Record<string, string[]>,
            names: e.names ? [...e.names] : [],
        }));

        if (!this.editablePricing.some(e => e.id === 'default')) {
            this.editablePricing.push({ id: 'default', price: [0, 0, 0, 0], providers: {}, names: [] });
        }

        this.renderPricingRows();
        this.markPricingDirty();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private formatCost(usd: number): string {
        if (usd === 0) return '$0.00';
        if (usd < 0.0001) return `$${usd.toExponential(2)}`;
        if (usd < 0.01) return `$${usd.toFixed(4)}`;
        if (usd < 1) return `$${usd.toFixed(4)}`;
        return `$${usd.toFixed(2)}`;
    }

    private formatTokens(n: number): string {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return n.toString();
    }

    private truncateId(id: string, len = 16): string {
        if (id.length <= len) return this.escapeHtml(id);
        return this.escapeHtml(id.slice(0, len)) + '…';
    }

    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
