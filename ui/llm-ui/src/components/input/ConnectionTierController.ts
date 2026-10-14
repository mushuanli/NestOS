// @file: llm-ui/components/input/ConnectionTierController.ts
// 连接 + 模型层级选择：快速按钮/弹窗 + 设置面板的 connection select / tier cards。
// 从 ChatInputView 抽出，自包含（状态 + DOM + 弹窗渲染），变更通过 onChange 回调通知宿主。

import { t } from '@itookit/common';
import { type ModelTier } from '@itookit/driver-llm/contracts';
import { ChatInputTemplates } from '../templates/ChatInputTemplates';
import { PopupPanel, type PopupItem } from './plugins/PopupPanel';
import type { ConnectionOption } from '../../domain/types';

export interface ConnectionTierDeps {
    onNavigateSettings: (target: { resourceId: string }) => void;
    onChange: () => void;
    onRefreshConnections?: () => Promise<void>;
}

export class ConnectionTierController {
    private connections: ConnectionOption[] = [];
    private connectionId: string | undefined;
    private modelTier: ModelTier | 'auto' = 'auto';

    private readonly connQuickBtn: HTMLButtonElement;
    private readonly connQuickLabel: HTMLSpanElement;
    private readonly connQuickClear: HTMLElement;
    private readonly tierQuickBtn: HTMLButtonElement;
    private readonly tierQuickLabel: HTMLSpanElement;
    private readonly tierQuickClear: HTMLElement;
    private readonly connectionSelect: HTMLSelectElement;
    private readonly tierPillsContainer: HTMLElement;

    private connPopup: PopupPanel | null = null;
    private tierPopup: PopupPanel | null = null;

    constructor(container: HTMLElement, private readonly deps: ConnectionTierDeps) {
        this.connQuickBtn = container.querySelector('.llm-input__conn-quick')!;
        this.connQuickLabel = container.querySelector('.llm-input__conn-quick-label')!;
        this.connQuickClear = container.querySelector('.llm-input__conn-quick-clear')!;
        this.tierQuickBtn = container.querySelector('.llm-input__tier-quick')!;
        this.tierQuickLabel = container.querySelector('.llm-input__tier-quick-label')!;
        this.tierQuickClear = container.querySelector('.llm-input__tier-quick-clear')!;
        this.connectionSelect = container.querySelector('.llm-input__connection-select')!;
        this.tierPillsContainer = container.querySelector('.llm-input__tier-cards')!;

        this.connQuickBtn.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.llm-input__conn-quick-clear')) { this.selectConnection(''); return; }
            this.toggleConnPicker();
        });
        this.tierQuickBtn.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.llm-input__tier-quick-clear')) { this.selectTier('auto'); return; }
            this.toggleTierPicker();
        });
        this.connectionSelect.addEventListener('change', () => {
            this.selectConnection(this.connectionSelect.value);
        });
        this.tierPillsContainer.addEventListener('click', (e) => {
            const pill = (e.target as HTMLElement).closest('.llm-input__tier-card') as HTMLElement | null;
            if (!pill) return;
            const tier = pill.dataset.tier as 'auto' | ModelTier;
            if (!tier) return;
            this.selectTier(tier);
        });
    }

    getConnectionId(): string | undefined { return this.connectionId; }
    getModelTier(): ModelTier | 'auto' { return this.modelTier; }
    getConnections(): ConnectionOption[] { return this.connections; }

    /** 初始同步（不触发 onChange）。 */
    setConnectionId(id: string | undefined): void {
        this.connectionId = id;
        if (this.connectionSelect) this.connectionSelect.value = id ?? '';
        this.updateConnQuick();
    }

    setModelTier(tier: ModelTier | 'auto'): void {
        this.modelTier = tier;
        this.updateTierQuick();
        this.updateTierPills(tier);
    }

    /** 连接列表就绪后刷新所有连接/tier UI。 */
    setConnections(connections: ConnectionOption[]): void {
        this.connections = connections;
        this.updateConnectionOptions();
        this.updateConnQuick();
        this.updateTierQuick();
        this.updateTierCardModels();
        this.updateTierPills(this.modelTier);
        if (this.connPopup?.isVisible) this.connPopup.updateItems(this.buildConnItems());
    }

    /** 关闭连接/tier 弹窗（供其它弹窗互斥时调用）。 */
    hidePopups(): void {
        this.connPopup?.hide();
        this.tierPopup?.hide();
    }

    setLoading(loading: boolean): void {
        this.connQuickBtn.disabled = loading;
        this.tierQuickBtn.disabled = loading;
        this.connectionSelect.disabled = loading;
    }

    destroy(): void {
        this.connPopup?.destroy();
        this.connPopup = null;
        this.tierPopup?.destroy();
        this.tierPopup = null;
    }

    // ── 连接选择 ──────────────────────────────────────────────────────────────

    private selectConnection(id: string): void {
        this.connectionId = id || undefined;
        if (this.connectionSelect) this.connectionSelect.value = id;
        this.updateConnQuick();
        this.updateTierQuick();
        this.updateTierCardModels();
        this.deps.onChange();
    }

    private updateConnQuick(): void {
        if (!this.connQuickLabel) return;
        const id = this.connectionId;
        if (id) {
            const conn = this.connections.find(c => c.id === id);
            this.connQuickLabel.textContent = conn?.name ?? t('connection.unavailable', { id });
            this.connQuickClear.style.display = '';
            this.connQuickBtn.classList.add('llm-input__conn-quick--active');
        } else {
            this.connQuickLabel.textContent = this.defaultLabel();
            this.connQuickClear.style.display = 'none';
            this.connQuickBtn.classList.remove('llm-input__conn-quick--active');
        }
    }

    private updateConnectionOptions(): void {
        if (!this.connectionSelect) return;
        this.connectionSelect.innerHTML = ChatInputTemplates.renderConnectionOptions(
            this.connections, this.connectionId
        );
    }

    private getOrCreateConnPopup(): PopupPanel {
        if (!this.connPopup) {
            this.connPopup = new PopupPanel(this.connQuickBtn, {
                emptyText: 'No connections configured',
                showSearch: true,
                animated: true,
                maxVisible: 30,
            });
        }
        return this.connPopup;
    }

    openConnPicker(): void {
        void this.deps.onRefreshConnections?.();
        const popup = this.getOrCreateConnPopup();
        popup.show(this.buildConnItems(), {
            onSelect: (item) => {
                if (item.id === '__manage') {
                    this.deps.onNavigateSettings({ resourceId: 'connections' });
                    return;
                }
                this.selectConnection(item.id);
            },
        });
    }

    private defaultLabel(): string {
        return t('connection.followDefault', { name: this.connections.find(c => c.isDefault)?.name ?? t('connection.unset') });
    }

    private toggleConnPicker(): void {
        const popup = this.getOrCreateConnPopup();
        if (popup.isVisible) popup.hide();
        else this.openConnPicker();
    }

    private buildConnItems(): PopupItem[] {
        const currentId = this.connectionId ?? '';
        const items: PopupItem[] = [
            { id: '', label: this.defaultLabel(), icon: currentId === '' ? '✓' : '' },
        ];

        const withKey    = this.connections.filter(c => c.hasApiKey);
        const withoutKey = this.connections.filter(c => !c.hasApiKey);

        for (const c of withKey) {
            items.push({
                id: c.id,
                label: c.name,
                description: c.provider,
                icon: c.id === currentId ? '✓' : (c.hasTiers ? '⚡' : ''),
            });
        }
        for (const c of withoutKey) {
            items.push({
                id: c.id,
                label: c.name,
                description: c.provider,
                icon: c.id === currentId ? '✓' : '',
                group: '⚠️ 需配置 API Key',
            });
        }

        items.push(
            { id: '__manage', label: '管理连接 →', icon: '⚙️', description: '配置 Provider 和模型层级' },
        );
        return items;
    }

    // ── 层级选择 ──────────────────────────────────────────────────────────────

    private selectTier(tier: 'auto' | ModelTier): void {
        this.modelTier = tier;
        this.updateTierQuick();
        this.updateTierPills(tier);
        this.deps.onChange();
    }

    private updateTierQuick(): void {
        if (!this.tierQuickLabel) return;
        const tier = this.modelTier;
        const TIER_LABELS: Record<string, string> = { optimal: '最优', standard: '标准', fast: '快速' };
        if (tier === 'auto') {
            const autoModel = this.resolveEffectiveTiers().optimal;
            this.tierQuickLabel.textContent = autoModel ? `Auto (${autoModel})` : 'Auto';
        } else {
            this.tierQuickLabel.textContent = TIER_LABELS[tier] ?? tier;
        }
        if (tier !== 'auto') {
            this.tierQuickClear.style.display = '';
            this.tierQuickBtn.classList.add('llm-input__tier-quick--active');
        } else {
            this.tierQuickClear.style.display = 'none';
            this.tierQuickBtn.classList.remove('llm-input__tier-quick--active');
        }
    }

    private updateTierPills(tier: 'auto' | ModelTier): void {
        this.tierPillsContainer?.querySelectorAll('.llm-input__tier-card').forEach(card => {
            card.classList.toggle('active', (card as HTMLElement).dataset.tier === tier);
        });
    }

    /** Refresh the model-name subtitle on each tier card to match the currently selected connection. */
    private updateTierCardModels(): void {
        const tiers = this.resolveEffectiveTiers();
        const modelLabels: Record<string, string> = {
            auto:     tiers.optimal ?? '',
            optimal:  tiers.optimal ?? '',
            standard: tiers.standard ?? '',
            fast:     tiers.fast ?? '',
        };
        this.tierPillsContainer?.querySelectorAll('[data-tier-model]').forEach(el => {
            const t = (el as HTMLElement).dataset.tierModel ?? '';
            el.textContent = modelLabels[t] ?? '';
        });
    }

    /**
     * Resolve the effective tier→modelName map for the current session.
     * Priority: connection override → agent's default connection → first available connection.
     */
    private resolveEffectiveTiers(): Partial<Record<string, string>> {
        const conn = this.connectionId ? this.connections.find(c => c.id === this.connectionId)
            : this.connections.find(c => c.isDefault);
        return conn?.tiers ?? {};
    }

    private getOrCreateTierPopup(): PopupPanel {
        if (!this.tierPopup) {
            this.tierPopup = new PopupPanel(this.tierQuickBtn, {
                emptyText: 'No tiers configured',
                animated: true,
            });
        }
        return this.tierPopup;
    }

    private openTierPicker(): void {
        this.connPopup?.hide();
        const popup = this.getOrCreateTierPopup();
        popup.show(this.buildTierItems(), {
            onSelect: (item) => this.selectTier(item.id as 'auto' | ModelTier),
        });
    }

    private toggleTierPicker(): void {
        const popup = this.getOrCreateTierPopup();
        if (popup.isVisible) popup.hide();
        else this.openTierPicker();
    }

    private buildTierItems(): PopupItem[] {
        const currentTier = this.modelTier;
        const tierMap = this.resolveEffectiveTiers();

        const items: PopupItem[] = [
            { id: 'auto', label: 'Auto', description: tierMap.optimal || 'Use agent default', icon: currentTier === 'auto' ? '✓' : '' },
            { id: 'optimal', label: '最优', description: tierMap.optimal, icon: currentTier === 'optimal' ? '✓' : '' },
        ];
        if (tierMap.standard) {
            items.push({ id: 'standard', label: '标准', description: tierMap.standard, icon: currentTier === 'standard' ? '✓' : '' });
        }
        if (tierMap.fast) {
            items.push({ id: 'fast', label: '快速', description: tierMap.fast, icon: currentTier === 'fast' ? '✓' : '' });
        }
        return items;
    }
}
