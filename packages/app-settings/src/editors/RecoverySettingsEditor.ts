import { InitialFilesSection, type InitialFilesPort } from './initial-files';
// @file: app-settings/editors/RecoverySettingsEditor.ts

import { t } from '@itookit/common';
import { type RestorableItem, type IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { BaseSettingsEditor, Toast, Modal, type EditorOptions } from '@itookit/ui-common';

export class RecoverySettingsEditor extends BaseSettingsEditor<IAgentManagementService> {
    constructor(container: HTMLElement, service: IAgentManagementService, options: EditorOptions,
        private readonly restoreFlows?: () => Promise<number>, initialFiles?: InitialFilesPort) {
        super(container, service, options); if (initialFiles) this.initialFiles = new InitialFilesSection(initialFiles);
    }
    private initialFiles?: InitialFilesSection;
    private restoringFlows = false;
    private selectedItems = new Set<string>(); // key = "type:id"
    private allItems: RestorableItem[] = [];

    async render() {
        this.allItems = await this.service.getRestorableItems();

        const providers   = this.allItems.filter(i => i.type === 'provider');
        const connections = this.allItems.filter(i => i.type === 'connection');
        const agents      = this.allItems.filter(i => i.type === 'agent');

        const selectedCount = this.selectedItems.size;
        const hasSelection  = selectedCount > 0;

        // Collect duplicate warnings
        const dupWarnings = this.buildDuplicateWarnings();

        this.container.innerHTML = `
            <div class="settings-page">
                <div class="settings-page__header">
                    <div>
                        <h2 class="settings-page__title">系统恢复与维护</h2>
                        <p class="settings-page__description">
                            选中项目并点击「重置选中项」可将其恢复为出厂默认值。
                            Provider 重置会保留已配置的 API Key。
                        </p>
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                        <button id="btn-reset-all" class="settings-btn settings-btn--danger">
                            🔄 强制全量重置
                        </button>
                        <button id="btn-batch-restore" class="settings-btn settings-btn--primary"
                                ${!hasSelection ? 'disabled' : ''}>
                            ↩️ 重置选中项 (${selectedCount})
                        </button>
                    </div>
                </div>

                ${dupWarnings}
                ${this.initialFiles ? `<div data-initial-files></div>` : this.restoreFlows ? `<section class="settings-section">
                    <h3>${this.escapeHtml(t('flow.library.restore'))}</h3>
                    <p>${this.escapeHtml(t('flow.library.recoveryHint'))}</p>
                    <button id="btn-restore-flows" class="settings-btn settings-btn--primary" ${this.restoringFlows ? 'disabled' : ''}>
                        ${this.escapeHtml(t('flow.library.restore'))}</button>
                </section>` : ''}

                ${this.renderSection('🏭 Provider 配置', 'provider', providers)}
                ${this.renderSection('🔗 默认连接（Connection）', 'connection', connections)}
                ${this.renderSection('🤖 默认智能体（Agent）', 'agent', agents)}
            </div>
        `;

        await this.initialFiles?.mount(this.container.querySelector<HTMLElement>('[data-initial-files]')!);
        this.updateAllSelectAllState(providers, connections, agents);
        this.bindEvents();
    }

    private buildDuplicateWarnings(): string {
        const dupItems = this.allItems.filter(i => i.duplicatePaths?.length);
        if (dupItems.length === 0) return '';

        const rows = dupItems.map(i => {
            const paths = i.duplicatePaths!.map(p => `<code>${this.escapeHtml(p)}</code>`).join(', ');
            return `<li><strong>${i.type}/${i.id}</strong> — 重复路径: ${paths}</li>`;
        }).join('');

        return `
            <div class="settings-banner settings-banner--warning" style="margin-bottom:1rem">
                ⚠️ 检测到 ${dupItems.length} 个项目存在重复文件，全量重置时将自动合并（保留 /default/ 路径，删除冗余副本）：
                <ul style="margin:8px 0 0 16px;font-size:0.875rem">${rows}</ul>
            </div>
        `;
    }

    async destroy(): Promise<void> { this.initialFiles?.destroy(); await super.destroy(); }

    private async restoreMissingFlows(): Promise<void> {
        if (!this.restoreFlows || this.restoringFlows) return;
        this.restoringFlows = true;
        const button = this.container.querySelector<HTMLButtonElement>('#btn-restore-flows');
        if (button) button.disabled = true;
        try { Toast.success(t('flow.library.restored', { count: await this.restoreFlows() })); }
        catch (error) { Toast.error(String(error)); }
        finally {
            this.restoringFlows = false;
            if (button?.isConnected) button.disabled = false;
        }
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    private renderSection(title: string, group: string, items: RestorableItem[]): string {
        return `
            <div class="recovery-section" style="margin-top:1.5rem">
                <div class="settings-section-header">
                    <h3 class="settings-section-title">${title}</h3>
                    <label class="settings-checkbox-label">
                        <input type="checkbox" class="chk-select-all" data-group="${group}"> 全选
                    </label>
                </div>
                <div class="settings-list-group">
                    ${items.length > 0
                        ? items.map(item => this.renderRow(item)).join('')
                        : '<div style="padding:12px;color:var(--st-text-disabled)">（无条目）</div>'
                    }
                </div>
            </div>
        `;
    }

    private renderRow(item: RestorableItem): string {
        const key = `${item.type}:${item.id}`;
        const isSelected = this.selectedItems.has(key);

        const { badge, cls } = {
            missing:  { badge: '<span class="settings-badge settings-badge--danger">已丢失</span>',  cls: 'status-missing' },
            modified: { badge: '<span class="settings-badge settings-badge--warning">已修改</span>', cls: 'status-modified' },
            ok:       { badge: '<span class="settings-badge settings-badge--success">正常</span>',   cls: 'status-ok' },
        }[item.status];

        const dupBadge = item.duplicatePaths?.length
            ? ` <span class="settings-badge settings-badge--danger" title="重复文件: ${item.duplicatePaths.join(', ')}">⚠️ 重复</span>`
            : '';

        return `
            <div class="settings-list-item ${cls}${isSelected ? ' settings-list-item--selected' : ''}"
                 data-key="${key}">
                <div class="settings-list-item__check">
                    <input type="checkbox" class="chk-item" value="${key}" ${isSelected ? 'checked' : ''}>
                </div>
                <div class="settings-list-item__icon">${item.icon ?? ''}</div>
                <div class="settings-list-item__content">
                    <div class="settings-list-item__title">${item.name} ${badge}${dupBadge}</div>
                    <div class="settings-list-item__desc">${item.description ?? ''} · ID: ${item.id}</div>
                </div>
            </div>
        `;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    private bindEvents() {
        // Row click → toggle checkbox
        this.container.querySelectorAll('.settings-list-item').forEach(item => {
            this.addEventListener(item, 'click', (e) => {
                if ((e.target as HTMLElement).matches('input[type="checkbox"]')) return;
                const chk = item.querySelector('.chk-item') as HTMLInputElement;
                chk.checked = !chk.checked;
                this.handleItemSelection(chk);
            });
        });

        // Checkbox change
        this.container.querySelectorAll('.chk-item').forEach(chk => {
            this.addEventListener(chk, 'change', (e) =>
                this.handleItemSelection(e.target as HTMLInputElement));
        });

        // Group select-all
        this.container.querySelectorAll('.chk-select-all').forEach(chk => {
            this.addEventListener(chk, 'change', (e) => {
                const target = e.target as HTMLInputElement;
                const group = target.dataset.group!;
                this.allItems.filter(i => i.type === group).forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    target.checked ? this.selectedItems.add(key) : this.selectedItems.delete(key);
                });
                this.render();
            });
        });

        // Batch restore
        const batchBtn = this.container.querySelector('#btn-batch-restore');
        const flowButton = this.container.querySelector('#btn-restore-flows');
        if (flowButton) this.addEventListener(flowButton, 'click', () => this.restoreMissingFlows());
        if (batchBtn) this.addEventListener(batchBtn, 'click', () => this.handleBatchRestore());

        // Force reset all
        const resetAllBtn = this.container.querySelector('#btn-reset-all');
        if (resetAllBtn) this.addEventListener(resetAllBtn, 'click', () => this.handleResetAll());
    }

    private handleItemSelection(target: HTMLInputElement) {
        target.checked ? this.selectedItems.add(target.value) : this.selectedItems.delete(target.value);
        this.refreshUIState();
    }

    private refreshUIState() {
        const btn = this.container.querySelector('#btn-batch-restore') as HTMLButtonElement | null;
        if (btn) {
            const count = this.selectedItems.size;
            btn.disabled = count === 0;
            btn.innerHTML = `↩️ 重置选中项 (${count})`;
            const hasNormal = this.getSelectedObjects().some(i => i.status === 'ok');
            btn.classList.toggle('settings-btn--danger', hasNormal);
            btn.classList.toggle('settings-btn--primary', !hasNormal);
        }

        // Update select-all checkboxes
        ['provider', 'connection', 'agent'].forEach(type => {
            const items = this.allItems.filter(i => i.type === type);
            const chk = this.container.querySelector(`.chk-select-all[data-group="${type}"]`) as HTMLInputElement | null;
            if (!chk || items.length === 0) return;
            const allSel  = items.every(i => this.selectedItems.has(`${i.type}:${i.id}`));
            const someSel = items.some(i => this.selectedItems.has(`${i.type}:${i.id}`));
            chk.checked = allSel;
            chk.indeterminate = someSel && !allSel;
        });

        // Row highlight
        this.container.querySelectorAll('.settings-list-item').forEach(row => {
            const key = (row as HTMLElement).dataset.key!;
            row.classList.toggle('settings-list-item--selected', this.selectedItems.has(key));
        });
    }

    private updateAllSelectAllState(
        providers: RestorableItem[],
        connections: RestorableItem[],
        agents: RestorableItem[],
    ) {
        [
            ['provider', providers],
            ['connection', connections],
            ['agent', agents],
        ].forEach(([type, items]) => {
            const chk = this.container.querySelector(
                `.chk-select-all[data-group="${type}"]`
            ) as HTMLInputElement | null;
            const list = items as RestorableItem[];
            if (!chk || list.length === 0) return;
            const allSel  = list.every(i => this.selectedItems.has(`${i.type}:${i.id}`));
            const someSel = list.some(i => this.selectedItems.has(`${i.type}:${i.id}`));
            chk.checked = allSel;
            chk.indeterminate = someSel && !allSel;
        });
    }

    private getSelectedObjects(): RestorableItem[] {
        return this.allItems.filter(i => this.selectedItems.has(`${i.type}:${i.id}`));
    }

    // ── Actions ─────────────────────────────────────────────────────────────────

    private handleBatchRestore() {
        if (this.selectedItems.size === 0) return;

        const selected = this.getSelectedObjects();
        const hasOk    = selected.some(i => i.status === 'ok');
        const hasProviders = selected.some(i => i.type === 'provider');
        const hasDuplicates = selected.some(i => i.duplicatePaths?.length);

        let msg = `确定要重置这 ${selected.length} 个项目吗？`;
        if (hasOk) msg += '\n\n⚠️ 注意：包含状态正常的项目，重置将覆盖当前配置。';
        if (hasProviders) msg += '\n\n✅ Provider 重置会保留已配置的 API Key，仅重置模型列表和地址。';
        if (hasDuplicates) {
            const dupItems = selected.filter(i => i.duplicatePaths?.length);
            const dupDetail = dupItems.map(i =>
                `  · ${i.type}/${i.id}: ${i.duplicatePaths!.join(', ')}`
            ).join('\n');
            msg += `\n\n⚠️ 以下项目存在重复文件，重置时将自动合并（保留 /default/ 路径）：\n${dupDetail}`;
        }

        Modal.confirm(hasOk || hasDuplicates ? '强制重置确认' : '恢复确认', msg, async () => {
            const btn = this.container.querySelector('#btn-batch-restore') as HTMLButtonElement;
            if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 处理中...'; }

            let ok = 0; let err = 0;
            await Promise.all(
                Array.from(this.selectedItems).map(async (key) => {
                    const sep = key.indexOf(':');
                    const type = key.slice(0, sep) as 'provider' | 'connection' | 'agent';
                    const id = key.slice(sep + 1);
                    try {
                        await this.service.restoreItem(type, id);
                        ok++;
                    } catch (e: unknown) {
                        err++;
                        console.error(`Restore ${key}:`, e);
                    }
                })
            );

            if (err === 0) {
                Toast.success(`成功重置 ${ok} 个项目`);
                this.selectedItems.clear();
            } else {
                Toast.warning(`完成：${ok} 成功，${err} 失败`);
            }
            await this.render();
        });
    }

    private handleResetAll() {
        const dupItems = this.allItems.filter(i => i.duplicatePaths?.length);
        let dupMsg = '';
        if (dupItems.length > 0) {
            dupMsg = '\n\n⚠️ 检测到以下项目存在重复文件，将自动合并（保留 /default/ 路径）：\n' +
                dupItems.map(i => `  · ${i.type}/${i.id}: ${i.duplicatePaths!.join(', ')}`).join('\n');
        }

        Modal.confirm(
            '强制全量重置',
            '将所有内置 Provider、Connection、Agent 恢复为出厂默认值。\n\n' +
            '✅ Provider 的 API Key 会被保留。\n' +
            '⚠️ 用户对模型列表、地址、Agent 配置的自定义修改将丢失。\n\n' +
            '建议在遇到配置混乱或版本升级后使用此功能。' +
            dupMsg,
            async () => {
                const btn = this.container.querySelector('#btn-reset-all') as HTMLButtonElement;
                if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 重置中...'; }
                try {
                    await this.service.resetAllDefaults();
                    Toast.success('已完成全量重置');
                    this.selectedItems.clear();
                } catch (e: unknown) {
                    Toast.error('重置失败：' + (e instanceof Error ? e.message : String(e)));
                } finally {
                    await this.render();
                }
            }
        );
    }
}
