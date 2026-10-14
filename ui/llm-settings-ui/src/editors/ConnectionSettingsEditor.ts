import { SettingsValidationError } from '@itookit/ui-common';
import { renderProtocolOptions } from './provider-form';
import { getProviderProtocols } from '@itookit/driver-llm/contracts';
import { resolveModelForTier } from '@itookit/kernel-adapters/contracts';
import { showConfigurationForm, addConfigurationAction, addConfigurationEnabled } from './configuration-form';
import { t } from '@itookit/common';
// @file: llm-ui/editors/ConnectionSettingsEditor.ts
//
// 三层架构：Provider → Connection → Agent
// 此编辑器负责 Connection 层：绑定 Provider + 配置 apiKey + 自定义 tier 映射。
// 模型目录由 Provider 统一管理，不在 Connection 中存储/编辑。

import {generateShortUUID} from '@itookit/common';
import { BaseSettingsEditor } from '@itookit/ui-common';
import type { IConnectionService } from '@itookit/kernel-adapters/contracts';
import type { ConnectionMeta, LLMConnection, LLMProvider, ModelTier, ApiProtocol } from '@itookit/driver-llm/contracts';
import { Toast } from '@itookit/ui-common';
import { fromConnectionDef, serializeLLMConfig } from '@itookit/kernel-adapters/llm/config';
import { runLLMImport } from './llm-import';
import { escapeAttr, escapeHTML } from '@itookit/common';

export class ConnectionSettingsEditor extends BaseSettingsEditor<IConnectionService> {
    private defaultConnectionId?: string;
    private currentEditTiers: Partial<Record<ModelTier, string>> = {};
    private currentEditModelEfforts: Record<string, string> = {};
    private providers: Record<string, LLMProvider> = {};
    private _checkedIds = new Set<string>();
    private _selectedProviderId: string | null = null;

    private get formOnly(): boolean { return this.options.target?.kind === 'entity' && this.options.target.entityType === 'connection'; }

    async render() {
        if (!await this.prepareRender()) return;
        this.providers = Object.fromEntries(
            this.service.getProviders().map(p => [p.id, p])
        );
        const allConnections = await this.service.getConnections();
        this.defaultConnectionId = (await this.service.getDefaultConnection())?.id;
        if (this.formOnly) {
            const target = this.options.target;
            const connection = await this.service.getFullConnection(target?.kind === 'entity' ? target.id : '');
            if (connection) this.showEditModal(connection); else this.container.textContent = t('toolbox.resourceMissing');
            return;
        }

        // Sort: has-apiKey first → enabled first → alphabetical
        allConnections.sort((a, b) => {
            if (a.hasApiKey && !b.hasApiKey) return -1;
            if (!a.hasApiKey && b.hasApiKey) return 1;
            const aOn = a.enabled !== false;
            const bOn = b.enabled !== false;
            if (aOn && !bOn) return -1;
            if (!aOn && bOn) return 1;
            return (a.name || '').localeCompare(b.name || '');
        });

        // Filter by selected provider
        const connections = this._selectedProviderId
            ? allConnections.filter(c => (c.providerId) === this._selectedProviderId)
            : allConnections;

        const checkedCount = this._checkedIds.size;
        const pageTitle = this._selectedProviderId
            ? `${this.providers[this._selectedProviderId]?.name ?? ''} 连接`
            : 'LLM 连接配置';

        this.container.innerHTML = `
            <div class="settings-split conn-split-sidebar${this._selectedProviderId ? ' has-detail' : ''}">
                <aside class="settings-split__sidebar">
                    <div class="settings-split__header">
                        <h3>Provider</h3>
                    </div>
                    <div class="settings-split__list">
                        ${this.renderProviderSidebar(allConnections)}
                    </div>
                </aside>
                <div class="settings-split__content">
                    <button class="settings-mobile-back" data-action="mobile-back">&#8592; Providers</button>
                    <div class="settings-page__header">
                        <div>
                            <h2 class="settings-page__title">${pageTitle}</h2>
                            <p class="settings-page__description">把 Provider 绑定到 Agent 并设置模型层级（optimal / standard / fast）；API Key 属于 Provider，在「LLM Provider」页配置</p>
                        </div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                            <input type="file" id="llm-conn-import-file"
                                   accept=".llm,.yaml,.yml" multiple style="display:none">
                            <button id="btn-import-conn-llm" class="settings-btn settings-btn--secondary"
                                    title="从 .llm 文件导入连接（和可选的 Provider 定义）">
                                ↑ 导入 .llm
                            </button>
                            <button id="btn-export-conn-llm" class="settings-btn settings-btn--secondary"
                                    ${checkedCount === 0 ? 'disabled' : ''}
                                    title="将选中连接导出为 .llm 文件">
                                ↓ 导出${checkedCount > 0 ? ` (${checkedCount})` : ''}
                            </button>
                            <button id="btn-delete-conn-batch" class="settings-btn settings-btn--danger"
                                    ${checkedCount === 0 ? 'disabled' : ''}
                                    title="删除选中的连接（默认连接不可删除）">
                                🗑️ 删除${checkedCount > 0 ? ` (${checkedCount})` : ''}
                            </button>
                            <button id="btn-add-connection" class="settings-btn settings-btn--primary">
                                <span class="settings-btn__icon">+</span> 添加连接
                            </button>
                        </div>
                    </div>

                    <div id="connections-list" class="settings-connection-grid">
                        ${connections.map(conn => this.renderConnectionCard(conn)).join('')}
                    </div>

                    ${connections.length === 0 ? `
                        <div class="settings-empty">
                            <div class="settings-empty__icon">🔌</div>
                            <h3 class="settings-empty__title">还没有配置连接</h3>
                            <p class="settings-empty__text">点击"添加连接"按钮，选择云提供商并填写 API Key</p>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        this.bindEvents();
        await this.consumeAnchor(allConnections);
    }

    /**
     * Consumes the one-shot `settings_anchor` from sessionStorage.
     * anchor format: `conn:<connectionId>` — highlights the card and opens its edit modal.
     * Stale entries (> 5s) are discarded.
     */
    private async consumeAnchor(allConnections: ConnectionMeta[]): Promise<void> {
        const raw = sessionStorage.getItem('settings_anchor');
        if (!raw) return;
        try {
            const { target, anchor, timestamp } = JSON.parse(raw) as { target: string; anchor: string; timestamp: number };
            if (target !== 'settings' || Date.now() - timestamp > 5000) {
                sessionStorage.removeItem('settings_anchor');
                return;
            }
            sessionStorage.removeItem('settings_anchor');
            if (!anchor.startsWith('conn:')) return;
            const connId = anchor.slice(5);
            const conn = allConnections.find(c => c.id === connId);
            if (!conn) return;

            // Pre-select the provider sidebar so the card is visible
            const pid = conn.providerId;
            if (pid && this._selectedProviderId !== pid) {
                this._selectedProviderId = pid;
                await this.render();
                // render() will call consumeAnchor again but sessionStorage is already cleared,
                // so we post the highlight/modal work via setTimeout to run after the DOM settles.
                setTimeout(() => this.highlightAndOpenConn(connId), 50);
                return;
            }
            this.highlightAndOpenConn(connId);
        } catch {
            sessionStorage.removeItem('settings_anchor');
        }
    }

    private async highlightAndOpenConn(connId: string): Promise<void> {
        const card = this.container.querySelector(`.settings-connection-card[data-id="${CSS.escape(connId)}"]`) as HTMLElement | null;
        if (card) {
            card.classList.add('settings-card--anchored');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => card.classList.remove('settings-card--anchored'), 2000);
        }
        const connection = await this.service.getFullConnection(connId);
        if (connection) setTimeout(() => this.showEditModal(connection), 120);
    }

    /** Navigate to a specific connection by anchor string (`conn:<id>`). Called by the host when
     *  the settings page is already open and openFile() would be a no-op. */
    async navigateToAnchor(anchor: string): Promise<void> {
        if (!anchor.startsWith('conn:')) return;
        const connId = anchor.slice(5);
        const allConnections = await this.service.getConnections();
        this.defaultConnectionId = (await this.service.getDefaultConnection())?.id;
        const conn = allConnections.find(c => c.id === connId);
        if (!conn) return;
        const pid = conn.providerId;
        if (pid && this._selectedProviderId !== pid) {
            this._selectedProviderId = pid;
            await this.render();
            setTimeout(() => this.highlightAndOpenConn(connId), 50);
            return;
        }
        this.highlightAndOpenConn(connId);
    }

    // ── Provider Sidebar ────────────────────────────────────────────────────────

    private renderProviderSidebar(allConnections: ConnectionMeta[]): string {
        const allItem = `
            <div class="conn-provider-item ${!this._selectedProviderId ? 'conn-provider-item--active' : ''}"
                 data-provider-id="">
                <span class="conn-provider-item__icon">🔗</span>
                <span class="conn-provider-item__name">全部</span>
                <span class="conn-provider-item__count">${allConnections.length}</span>
            </div>
            <div class="conn-provider-divider"></div>
        `;

        // Sort sidebar: providers with hasApiKey connections first, then alphabetical
        const sortedProviders = Object.entries(this.providers).sort(([, pa], [, pb]) => {
            const aHasKey = allConnections.some(c => (c.providerId) === pa.id && c.hasApiKey);
            const bHasKey = allConnections.some(c => (c.providerId) === pb.id && c.hasApiKey);
            if (aHasKey && !bHasKey) return -1;
            if (!aHasKey && bHasKey) return 1;
            return (pa.name || '').localeCompare(pb.name || '');
        });
        const providerItems = sortedProviders.map(([id, p]) => {
            const provConns = allConnections.filter(c => (c.providerId) === id);
            const count = provConns.length;
            // A provider has no key if it has connections and ALL of them report !hasApiKey
            const noKey = count > 0 && provConns.every(c => !c.hasApiKey);
            const isActive = this._selectedProviderId === id;
            return `
                <div class="conn-provider-item ${isActive ? 'conn-provider-item--active' : ''} ${noKey ? 'conn-provider-item--no-key' : ''}"
                     data-provider-id="${id}"
                     title="${noKey ? 'Provider 未配置 API Key，相关连接均无效' : p.name}">
                    <span class="conn-provider-item__icon">${p.icon ?? '🤖'}</span>
                    <span class="conn-provider-item__name">${p.name}</span>
                    ${noKey
                        ? '<span class="conn-provider-item__nokey-badge">无 Key</span>'
                        : `<span class="conn-provider-item__count ${count === 0 ? 'conn-provider-item__count--empty' : ''}">${count}</span>`
                    }
                </div>
            `;
        }).join('');

        return allItem + providerItems;
    }

    // ── Card rendering ─────────────────────────────────────────────────────────

    private renderConnectionCard(conn: ConnectionMeta) {
        const isDefault    = conn.id === this.defaultConnectionId;
        const hasKey       = conn.hasApiKey;
        const enabled      = conn.enabled !== false;
        const pid          = conn.providerId;
        const provider     = this.providers[pid];
        const statusClass  = !hasKey ? 'settings-connection-card--incomplete' : '';
        const disabledStyle = enabled ? '' : 'opacity:0.55;';

        let badgeHtml = '';
        if (isDefault) {
            badgeHtml = '<span class="settings-badge settings-badge--success">默认</span>';
        } else if (!hasKey) {
            badgeHtml = '<span class="settings-badge settings-badge--warning">需配置</span>';
        }

        const isChecked = this._checkedIds.has(conn.id);

        return `
            <div class="settings-connection-card ${isDefault ? 'settings-connection-card--default' : ''} ${statusClass}"
                 data-id="${conn.id}" data-name="${conn.name}" style="${disabledStyle}">
                <div class="settings-connection-card__header">
                    <div style="display:flex;align-items:center;gap:6px;min-width:0">
                        <input type="checkbox" class="chk-conn-select" data-id="${conn.id}"
                               ${isChecked ? 'checked' : ''}
                               title="选中以批量导出"
                               style="flex-shrink:0;cursor:pointer;width:15px;height:15px">
                        <h3 class="settings-connection-card__title"
                            style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                            ${conn.name}
                        </h3>
                    </div>
                    <div style="display:flex;gap:4px;align-items:center">
                        ${badgeHtml}
                        <label class="llm-enable-toggle" title="${enabled ? '点击禁用' : '点击启用'}">
                            <input type="checkbox" class="chk-conn-enabled" data-id="${conn.id}"
                                   ${enabled ? 'checked' : ''} style="display:none">
                            <span class="llm-enable-toggle__track ${enabled ? 'llm-enable-toggle__track--on' : ''}">
                                <span class="llm-enable-toggle__thumb"></span>
                            </span>
                        </label>
                    </div>
                </div>

                <div class="settings-connection-card__details">
                    <div class="settings-detail-item">
                        <span class="settings-detail-item__label">提供商</span>
                        <span class="settings-detail-item__value">${provider?.icon ?? ''} ${provider?.name ?? pid}</span>
                    </div>
<div class="settings-detail-item" style="align-items:flex-start">
                        <span class="settings-detail-item__label" style="padding-top:2px">质量层级</span>
                        <span class="settings-detail-item__value">${this.renderTierBadges(conn)}</span>
                    </div>
                    <div class="settings-detail-item">
                        <span class="settings-detail-item__label">Provider Key</span>
                        <span class="settings-detail-item__value">
                            ${hasKey
                                ? '<span style="color:var(--st-color-success,#10b981)">✓ 已配置</span>'
                                : `<button class="settings-btn-goto-providers" data-provider-id="${pid}"
                                          style="padding:0;background:none;border:none;cursor:pointer;
                                                 color:var(--st-primary,#6366f1);font-size:inherit;text-decoration:underline">
                                       未配置 → 去设置
                                   </button>`
                            }
                        </span>
                    </div>
                </div>

                <div class="settings-page__actions" style="margin-top:auto; width:100%">
                    <button class="settings-btn settings-btn--secondary settings-btn--sm settings-btn-edit" style="flex:1">✏️ 编辑</button>
                    ${'<button class="settings-btn settings-btn--danger settings-btn--sm settings-btn-delete" style="flex:1">🗑️ 删除</button>'}
                </div>
            </div>
        `;
    }

    private renderTierBadges(conn: ConnectionMeta): string {
        const tiers = conn.tiers;
        if (!tiers || (!tiers.optimal && !tiers.standard && !tiers.fast)) {
            return '<span style="color:var(--st-text-disabled)">未配置</span>';
        }
        const pid = conn.providerId;
        const provider = this.providers[pid];
        const modelName = (modelId: string) => {
            if (!modelId) return '';
            const def = provider?.models.find(m => m.id === modelId);
            return def ? def.name : modelId;
        };

        const rows: string[] = [];
        const addRow = (_tier: string, badgeClass: string, label: string, modelId: string | undefined) => {
            if (!modelId) return;
            rows.push(`
                <div style="display:flex;align-items:center;gap:4px;min-width:0">
                    <span class="settings-tier-badge ${badgeClass}" style="flex-shrink:0">${label}</span>
                    <span style="font-size:0.78rem;color:var(--st-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                          title="${modelId}">${modelName(modelId)}</span>
                </div>`);
        };
        addRow('optimal',  'settings-tier-badge--optimal',  '最优', tiers.optimal);
        addRow('standard', 'settings-tier-badge--standard', '标准', tiers.standard);
        addRow('fast',     'settings-tier-badge--fast',     '快速', tiers.fast);
        return `<div style="display:flex;flex-direction:column;gap:3px;width:100%">${rows.join('')}</div>`;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    private bindEvents() {
        this.clearListeners();
        this.bindButton('#btn-add-connection', () => this.showEditModal(null));

        // Mobile: back button clears provider selection
        const mobileBack = this.container.querySelector<HTMLButtonElement>('[data-action="mobile-back"]');
        mobileBack?.addEventListener('click', () => { this._selectedProviderId = null; this.render(); });

        // Provider sidebar filter
        const sidebarList = this.container.querySelector('.settings-split__list');
        if (sidebarList) {
            this.addEventListener(sidebarList, 'click', (e) => {
                const item = (e.target as HTMLElement).closest('.conn-provider-item') as HTMLElement | null;
                if (!item) return;
                this._selectedProviderId = item.dataset.providerId || null;
                this.render();
            });
        }
        this.bindButton('#btn-import-conn-llm', () => {
            (this.container.querySelector('#llm-conn-import-file') as HTMLInputElement)?.click();
        });
        this.bindButton('#btn-export-conn-llm', () => this.exportSelected());
        this.bindButton('#btn-delete-conn-batch', () => this.batchDelete());

        const fileInput = this.container.querySelector('#llm-conn-import-file') as HTMLInputElement | null;
        if (fileInput) {
            this.addEventListener(fileInput, 'change', async () => {
                if (fileInput.files?.length) {
                    await this.importLLMFiles(fileInput.files);
                    fileInput.value = '';
                }
            });
        }

        const list = this.container.querySelector('#connections-list');
        if (list) {
            this.addEventListener(list, 'change', async (e) => {
                const target = e.target as HTMLInputElement;

                // Multi-select checkbox
                if (target.classList.contains('chk-conn-select')) {
                    const id = target.dataset.id!;
                    if (target.checked) this._checkedIds.add(id);
                    else this._checkedIds.delete(id);
                    const count = this._checkedIds.size;
                    const exportBtn = this.container.querySelector('#btn-export-conn-llm') as HTMLButtonElement | null;
                    if (exportBtn) { exportBtn.disabled = count === 0; exportBtn.textContent = `↓ 导出${count > 0 ? ` (${count})` : ''}`; }
                    const deleteBtn = this.container.querySelector('#btn-delete-conn-batch') as HTMLButtonElement | null;
                    if (deleteBtn) { deleteBtn.disabled = count === 0; deleteBtn.textContent = `🗑️ 删除${count > 0 ? ` (${count})` : ''}`; }
                    return;
                }

                // Enable/disable toggle
                if (target.classList.contains('chk-conn-enabled')) {
                    const id = target.dataset.id!;
                    const full = await this.service.getFullConnection(id);
                    if (!full) return;
                    await this.service.saveConnection({ ...full, enabled: target.checked });
                    this.render();
                }
            });

            this.addEventListener(list, 'click', async (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.llm-enable-toggle') || target.classList.contains('chk-conn-select')) return;

                // Navigate to Providers settings page — carry providerId as anchor
                const gotoBtn = target.closest('.settings-btn-goto-providers') as HTMLElement | null;
                if (gotoBtn) {
                    const providerId = gotoBtn.dataset.providerId;
                    this.options.hostContext?.navigate?.({
                        target: 'settings',
                        resourceId: 'providers',
                        ...(providerId ? { state: { anchor: providerId } } : {}),
                    });
                    return;
                }

                const card = target.closest('.settings-connection-card') as HTMLElement;
                if (!card) return;
                const id = card.dataset.id!;
                if (target.closest('.settings-btn-edit')) {
                    const connection = await this.service.getFullConnection(id);
                    this.showEditModal(connection ?? null);
                } else if (target.closest('.settings-btn-delete')) {
                    this.deleteConnection(id, card.dataset.name ?? id);
                }
            });
        }
    }

    // ── Import / Export ────────────────────────────────────────────────────────

    private async importLLMFiles(files: FileList): Promise<void> {
        const imported = await runLLMImport(files, this.service);
        if (imported) this.render();
    }

    private async exportSelected(): Promise<void> {
        const ids = [...this._checkedIds];
        if (!ids.length) return;

        const allConns = await this.service.getConnections();
        const selected = allConns.filter(c => ids.includes(c.id));
        const connDefs = selected.map(c =>
            fromConnectionDef({ id: c.id, name: c.name, providerId: c.providerId, tiers: c.tiers }),
        );

        const yaml = serializeLLMConfig({ connections: connDefs });
        const filename = selected.length === 1 ? `${selected[0].id}.llm` : 'connections-export.llm';
        const blob = new Blob([yaml], { type: 'text/yaml' });
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(blob), download: filename,
        });
        a.click();
        URL.revokeObjectURL(a.href);
    }

    private async batchDelete(): Promise<void> {
        const ids = [...this._checkedIds];
        if (!ids.length) return;

        const allConns = await this.service.getConnections();
        // Default connection cannot be deleted
        const deletable = allConns.filter(c => ids.includes(c.id));

        if (!deletable.length) {
            Toast.error('选中的连接均不可删除（默认连接不可删除）');
            return;
        }

        const request = this.options.hostContext?.requestDelete;
        if (!request) throw new Error('Configuration deletion is not connected');
        await request(deletable.map(item => ({ kind: 'entity', entityType: 'connection', id: item.id })));
        this._checkedIds.clear(); await this.render();
    }

    // ── Edit modal ─────────────────────────────────────────────────────────────

    private showEditModal(connection: LLMConnection | null) {
        let savedConnection = connection;
        const connectionId = connection?.id ?? `conn-${generateShortUUID()}`;
        const providerKeys = Object.keys(this.providers);
        const initialPid = connection?.providerId ?? this._selectedProviderId ?? providerKeys[0];
        const initialProvider = this.providers[initialPid] ?? this.providers[providerKeys[0]];

        this.currentEditTiers = connection?.tiers ? { ...connection.tiers } : {};
        this.currentEditModelEfforts = { ...(connection?.metadata?.modelReasoningEfforts ?? {}) };
        if (connection?.metadata?.reasoningEffort) {
            for (const tier of ['optimal', 'standard', 'fast'] as ModelTier[]) {
                const modelId = this.tierModelId(tier, initialProvider);
                if (modelId && !this.currentEditModelEfforts[modelId]) this.currentEditModelEfforts[modelId] = connection.metadata.reasoningEffort;
            }
        }

        const modalContent = `
            <form id="connection-form" class="settings-form">
                <!-- Provider selection (configure providers in "LLM Providers" settings) -->
                <div class="settings-form__group">
                    <label class="settings-form__label">云提供商 *</label>
                    <select class="settings-form__select" id="conn-provider" name="providerId" required>
                        ${providerKeys.map(k => {
                            const p = this.providers[k];
                            return `<option value="${k}" ${initialPid === k ? 'selected' : ''}>${p.icon ?? ''} ${p.name}</option>`;
                        }).join('')}
                    </select>
                    <small class="settings-form__help">
                        Provider 的模型列表和地址在
                        <strong>${this.formOnly ? t('toolbox.providerLocation') : '设置 → LLM Providers'}</strong> 中管理。
                    </small>
                </div>

                <!-- Connection name -->
                <div class="settings-form__group">
                    <label class="settings-form__label">连接名称 *</label>
                    <input type="text" class="settings-form__input" name="name"
                           value="${connection?.name || ''}" required
                           placeholder="例如: RDSec-Claude、RDSec-Gemini">
                    <small class="settings-form__help">
                        同一 Provider 可创建多个连接，用于配置不同的模型层级组合。
                    </small>
                </div>

                <!-- Temperature override -->
                <div class="settings-form__group">
                    <label class="settings-form__label">温度 (0-2)</label>
                    <input type="number" class="settings-form__input" name="temperature"
                           value="${connection?.temperature ?? ''}"
                           min="0" max="2" step="0.1" placeholder="未设置（使用 Provider 默认）"
                           style="max-width:120px">
                    <small class="settings-form__help">
                        覆盖 Provider 的默认温度。留空则使用 Provider 设置。
                    </small>
                </div>

                <!-- Tier configuration (Connection's core responsibility) -->
                <div class="settings-form__group">
                    <label class="settings-form__label" style="display:flex;align-items:center;gap:6px">
                        模型层级配置
                        <span class="settings-help-icon"
                              title="为此连接指定各层级使用的模型：&#10;• 最优（optimal）— 复杂推理（必填）&#10;• 标准（standard）— 日常工作&#10;• 快速（fast）— 简单廉价任务&#10;预算超过 80% 时系统自动向下降级。">?</span>
                    </label>
                    <div class="settings-tier-config" id="tier-config-section">
                        ${this.renderTierForm(initialProvider)}
                    </div>
                    <small class="settings-form__help">${t('connection.reasoningHelp')}</small>
                    <small class="settings-form__help">
                        API Key 和模型列表在 <strong>${this.formOnly ? t('toolbox.providerLocation') : '设置 → LLM Providers'}</strong> 中管理。
                    </small>
                </div>

                <div class="settings-form__group">
                    <label class="settings-form__label">${t('provider.protocol.connection')}</label>
                    <select class="settings-form__select" name="protocol">
                        ${initialProvider ? renderProtocolOptions(initialProvider, connection?.protocol) : ''}
                    </select>
                    <small class="settings-form__help">${t('provider.protocol.connectionHelp')}</small>
                </div>
            </form>
        `;

        showConfigurationForm(this.container, connection?.name ?? '添加连接', modalContent, {
            width: '560px',
            confirmText: '',
            onAutoSave: save => this.trackAutoSave(save),
            onClose: () => { void this.render(); },
            onConfirm: async () => {
                const form = document.getElementById('connection-form') as HTMLFormElement;
                if (!form.checkValidity()) return false;

                const formData = new FormData(form);
                const data = Object.fromEntries(formData) as Record<string, string>;
                if (!data.name.trim()) throw new SettingsValidationError(t('settings.autosave.invalid'));
                const pid = data.providerId;
                data.protocol = form.querySelector<HTMLSelectElement>('[name="protocol"]')!.value;

                // Read all three tier selections
                const tierOptimal  = (document.getElementById('tier-optimal')  as HTMLSelectElement)?.value || '';
                const tierStandard = (document.getElementById('tier-standard') as HTMLSelectElement)?.value || '';
                const tierFast     = (document.getElementById('tier-fast')     as HTMLSelectElement)?.value || '';
                const tiers: Partial<Record<ModelTier, string>> = {};
                if (tierOptimal)  tiers.optimal  = tierOptimal;
                if (tierStandard) tiers.standard = tierStandard;
                if (tierFast)     tiers.fast     = tierFast;

                const tempVal = parseFloat(data.temperature);
                const metadata: Record<string, unknown> = { ...(savedConnection?.metadata ?? {}) };
                delete metadata.reasoningEffort;
                delete metadata.tierThinking;
                const efforts = Object.fromEntries(Object.entries(this.currentEditModelEfforts).filter(([, value]) => value));
                if (Object.keys(efforts).length) metadata.modelReasoningEfforts = efforts;
                else delete metadata.modelReasoningEfforts;
                if (data.protocol && !getProviderProtocols(this.providers[pid]).includes(data.protocol as ApiProtocol)) {
                    throw new SettingsValidationError(t('provider.protocol.unavailable'));
                }
                const newConn: LLMConnection = {
                    ...savedConnection,
                    enabled: this.formOnly ? data.enabled === 'on' : connection?.enabled,
                    id: connectionId,
                    name: data.name.trim(),
                    providerId: pid,
                    tiers: Object.keys(tiers).length > 0 ? tiers : undefined,
                    temperature: !isNaN(tempVal) ? tempVal : undefined,
                    protocol: (data.protocol as ApiProtocol) || undefined,
                    dailyCosts: connection?.dailyCosts,
                    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
                };

                await this.service.saveConnection(newConn);
                savedConnection = structuredClone(newConn);
                const heading = this.container.querySelector('.settings-page__title');
                if (this.formOnly && heading) heading.textContent = newConn.name;
            },
        }, this.formOnly);

        if (this.formOnly) {
            this.bindModalEvents(connection, initialPid);
            addConfigurationEnabled(this.container, connection?.enabled !== false);
            addConfigurationAction(this.container, t('toolbox.configureProvider'), () => {
                const id = this.container.querySelector<HTMLSelectElement>('[name="providerId"]')?.value;
                if (id) void this.options.hostContext?.navigate({ target: 'toolbox', resourceId: '/providers/' + encodeURIComponent(id) });
            });
            if (connection) addConfigurationAction(this.container,
                t(connection.id === this.defaultConnectionId ? 'connection.clearDefault' : 'connection.setDefault'), async () => {
                    await this.service.setDefaultConnection(connection.id === this.defaultConnectionId ? null : connection.id);
                    await this.render();
                });
            if (connection) addConfigurationAction(this.container, t('action.delete'), () => this.deleteConnection(connection.id, connection.name));
        } else setTimeout(() => this.bindModalEvents(connection, initialPid), 100);
    }

    private tierModelId(tier: ModelTier, provider: LLMProvider | undefined): string {
        return resolveModelForTier({ tiers: this.currentEditTiers,
            model: provider?.models.find(model => (model.category ?? 'chat') === 'chat')?.id || '' }, tier);
    }

    private renderModelEffort(tier: ModelTier, provider: LLMProvider | undefined): string {
        const modelId = this.tierModelId(tier, provider);
        if (!modelId) return '';
        const value = this.currentEditModelEfforts[modelId] || '';
        const options = ['', 'low', 'medium', 'high', 'xhigh'].map(effort =>
            `<option value="${effort}" ${value === effort ? 'selected' : ''}>${effort || t('connection.reasoningDefault')}</option>`).join('');
        return `<select class="settings-form__select settings-form__select--sm" data-effort-tier="${tier}"
            aria-label="${t('connection.reasoningEffort')}" title="${t('connection.reasoningEffort')}">${options}</select>`;
    }

    private renderTierForm(provider: LLMProvider | undefined): string {
        // tier 是对话质量分层，只列 chat 类模型（缺省 category 视为 chat）
        const models = (provider?.models ?? []).filter(m => (m.category ?? 'chat') === 'chat');
        const noneOpt = '<option value="">— 未指定（使用 Provider 首个模型）—</option>';
        const modelOpts = models.map(m =>
            `<option value="${escapeAttr(m.id)}">${escapeHTML(m.name)}</option>`
        ).join('');

        const tierRow = (tier: ModelTier, label: string, badgeClass: string) => {
            return `
                <div class="settings-tier-row">
                    <span class="settings-tier-badge ${badgeClass}">${label}</span>
                    <select class="settings-form__select settings-form__select--sm" id="tier-${tier}" data-tier="${tier}" style="flex:1">${noneOpt}${modelOpts}</select>
                    <div id="tier-effort-${tier}">${this.renderModelEffort(tier, provider)}</div>
                </div>`;
        };

        return `
            ${tierRow('optimal',  '最优', 'settings-tier-badge--optimal')}
            ${tierRow('standard', '标准', 'settings-tier-badge--standard')}
            ${tierRow('fast',     '快速', 'settings-tier-badge--fast')}
        `;
    }

    private bindModalEvents(connection: LLMConnection | null, initialPid: string) {
        const providerSelect = document.getElementById('conn-provider') as HTMLSelectElement | null;
        const tierSection    = document.getElementById('tier-config-section') as HTMLElement | null;

        const refreshEffortSlots = (provider: LLMProvider | undefined) => {
            for (const tier of ['optimal', 'standard', 'fast'] as ModelTier[]) {
                const slot = this.container.querySelector(`#tier-effort-${tier}`);
                if (slot) slot.innerHTML = this.renderModelEffort(tier, provider);
            }
        };

        const refreshTierSelects = (provider: LLMProvider | undefined, tiers: Partial<Record<ModelTier, string>>) => {
            if (!tierSection) return;
            tierSection.innerHTML = this.renderTierForm(provider);
            const optSel  = document.getElementById('tier-optimal')  as HTMLSelectElement | null;
            const stdSel  = document.getElementById('tier-standard') as HTMLSelectElement | null;
            const fastSel = document.getElementById('tier-fast')     as HTMLSelectElement | null;
            if (optSel  && tiers.optimal)  optSel.value  = tiers.optimal;
            if (stdSel  && tiers.standard) stdSel.value  = tiers.standard;
            if (fastSel && tiers.fast)     fastSel.value = tiers.fast;
            refreshEffortSlots(provider);
        };

        // Initialize tier selects with current connection tiers
        const initTiers = connection?.tiers ?? {};
        refreshTierSelects(this.providers[initialPid], initTiers);

        // Single delegated handler for all tier-section changes.
        tierSection?.addEventListener('change', (e) => {
            const target = e.target as HTMLElement;
            const sel = target.closest('select[data-tier]') as HTMLSelectElement | null;
            if (sel) {
                const tier = sel.dataset.tier as ModelTier;
                this.currentEditTiers[tier] = sel.value || undefined;
                const pid = providerSelect?.value || initialPid;
                refreshEffortSlots(this.providers[pid]);
                return;
            }
            const effort = target.closest('select[data-effort-tier]') as HTMLSelectElement | null;
            if (effort) {
                const provider = this.providers[providerSelect?.value || initialPid];
                const modelId = this.tierModelId(effort.dataset.effortTier as ModelTier, provider);
                if (modelId) this.currentEditModelEfforts[modelId] = effort.value;
                for (const select of tierSection!.querySelectorAll<HTMLSelectElement>('select[data-effort-tier]')) {
                    const id = this.tierModelId(select.dataset.effortTier as ModelTier, provider);
                    select.value = this.currentEditModelEfforts[id] || '';
                }
            }
        });

        // Provider switch → refresh tier selects
        providerSelect?.addEventListener('change', () => {
            const provider = this.providers[providerSelect.value];
            const protocolSelect = document.querySelector<HTMLSelectElement>('#connection-form [name="protocol"]');
            if (protocolSelect && provider) protocolSelect.innerHTML = renderProtocolOptions(provider);
            this.currentEditTiers = {};
            this.currentEditModelEfforts = {};
            refreshTierSelects(provider, this.currentEditTiers);
        });

        // Receive anchor navigation when the settings page is already open (openFile is a no-op)
        const wsEl = this.container.closest<HTMLElement>('[id]');
        if (wsEl) {
            this.addEventListener(wsEl, 'consume-anchor', ((e: CustomEvent) => {
                void this.navigateToAnchor(e.detail.anchor as string);
            }) as EventListener);
        }
    }

    private async deleteConnection(id: string, _name: string): Promise<void> {
        await this.discardAutoSave();
        const request = this.options.hostContext?.requestDelete;
        if (!request) throw new Error('Configuration deletion is not connected');
        await request([{ kind: 'entity', entityType: 'connection', id }]);
        await this.render();
    }

    private bindButton(selector: string, handler: () => void) {
        const btn = this.container.querySelector(selector);
        if (btn) this.addEventListener(btn, 'click', handler);
    }
}
