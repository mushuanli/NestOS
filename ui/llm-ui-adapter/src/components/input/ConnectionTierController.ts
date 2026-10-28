import {getLocale} from '@itookit/common';
import { TOOLBOX_ICONS, t } from '@itookit/common';
import type { ModelTier } from '@itookit/driver-llm/contracts';
import { ChatInputTemplates } from '../templates/ChatInputTemplates';
import { PopupPanel, type PopupItem } from '@itookit/llm-ui';
import type { ConnectionOption } from '../../domain/types';

interface ConnectionTierDeps {
    onNavigateSettings: (target: { resourceId: string }) => void;
    onChange: () => void;
    onReasoning?: (capabilities: import('@itookit/driver-llm/contracts').ReasoningCapabilities | undefined, identity: string, selected: boolean) => void;
    onRefreshConnections?: () => Promise<void>;
}

export interface ConnectionIssue {
    kind: 'noDefault' | 'unavailable' | 'disabled' | 'credentials' | 'noModel';
    name?: string;
    target: {resourceId: string; anchor?: string};
}

/** Model choices bind a connection and its configured tier in one action. */
export class ConnectionTierController {
    private connections: ConnectionOption[] = [];
    private connectionId?: string;
    private agentDefaultConnectionId?: string;
    private modelTier: ModelTier | 'auto' = 'auto';
    private readonly trigger: HTMLButtonElement;
    private readonly label: HTMLElement;
    private readonly connectionSelect: HTMLSelectElement;
    private readonly tierCards: HTMLElement;
    private popup?: PopupPanel;

    constructor(container: HTMLElement, private readonly deps: ConnectionTierDeps) {
        this.trigger = container.querySelector('.llm-input__model-trigger')!;
        this.label = container.querySelector('.llm-input__model-label')!;
        this.connectionSelect = container.querySelector('.llm-input__connection-select')!;
        this.tierCards = container.querySelector('.llm-input__tier-cards')!;
        this.trigger.addEventListener('click', () => this.popup?.isVisible ? this.hidePopups() : this.openConnPicker());
        this.connectionSelect.addEventListener('change', () => {
            this.connectionId = this.connectionSelect.value || undefined;
            this.updateUI(true); this.deps.onChange();
        });
        this.tierCards.addEventListener('click', event => {
            const card = (event.target as Element).closest<HTMLButtonElement>('[data-tier]');
            if (card && !card.disabled) { this.modelTier = card.dataset.tier as 'auto' | ModelTier; this.updateUI(true); this.deps.onChange(); }
        });
    }
    getConnectionId(): string | undefined { return this.connectionId; }
    getModelTier(): ModelTier | 'auto' { return this.modelTier; }
    getConnections(): ConnectionOption[] { return this.connections; }
    getIssue(): ConnectionIssue | undefined {
        const connection = this.effectiveConnection(), requested = this.connectionId ?? this.agentDefaultConnectionId;
        if (!connection) return {kind: requested ? 'unavailable' : 'noDefault', name: requested,
            target: {resourceId: 'connections', ...(requested ? {anchor: 'conn:' + requested} : {})}};
        if (connection.enabled === false) return {kind: 'disabled', name: connection.name, target: {resourceId: 'connections', anchor: 'conn:' + connection.id}};
        if (!(connection.credentialsReady ?? connection.hasApiKey)) return {kind: 'credentials', name: connection.name,
            target: connection.provider ? {resourceId: 'providers', anchor: connection.provider} : {resourceId: 'connections', anchor: 'conn:' + connection.id}};
        if (!this.modelName(connection)) return {kind: 'noModel', name: connection.name,
            target: {resourceId: 'connections', anchor: 'conn:' + connection.id}};
        return undefined;
    }
    setConnectionId(id: string | undefined): void { this.connectionId = id; this.updateUI(); }
    setAgentDefaultConnectionId(id: string | undefined): void {
        if (this.agentDefaultConnectionId === id) return;
        this.agentDefaultConnectionId = id; this.updateUI();
        if (this.popup?.isVisible) this.popup.updateItems(this.buildItems());
    }
    setModelTier(tier: ModelTier | 'auto'): void { this.modelTier = tier; this.updateUI(); }
    setSelection(id: string | undefined, tier: ModelTier | 'auto'): void {
        this.connectionId = id; this.modelTier = tier; this.updateUI();
    }
    setConnections(connections: ConnectionOption[]): void {
        this.connections = connections;
        this.connectionSelect.innerHTML = ChatInputTemplates.renderConnectionOptions(connections, this.connectionId);
        this.updateUI(); if (this.popup?.isVisible) this.popup.updateItems(this.buildItems());
    }
    hidePopups(): void { this.popup?.hide(); }
    setLoading(loading: boolean): void {
        this.trigger.disabled = this.connectionSelect.disabled = loading;
        for (const card of this.tierCards.querySelectorAll<HTMLButtonElement>('button')) card.disabled = loading;
        if (loading) this.hidePopups(); else this.updateUI();
    }
    destroy(): void { this.popup?.destroy(); }
    private effectiveConnection(): ConnectionOption | undefined {
        return this.connectionId ? this.connections.find(c => c.id === this.connectionId) : this.defaultConnection();
    }
    private defaultConnection(): ConnectionOption | undefined {
        return this.agentDefaultConnectionId ? this.connections.find(c => c.id === this.agentDefaultConnectionId) : this.connections.find(c => c.isDefault);
    }
    private tierLabel(tier: string): string {
        return ({auto: t('chatSettings.followDefault'), optimal: t('ocr.tier.optimal'),
            standard: t('ocr.tier.standard'), fast: t('ocr.tier.fast')} as Record<string, string>)[tier] ?? tier;
    }
    private modelName(connection: ConnectionOption | undefined, tier = this.modelTier): string | undefined {
        if (connection?.resolvedTiers) return connection.resolvedTiers[tier === 'auto' ? 'optimal' : tier] ?? undefined;
        const tiers = connection?.tiers;
        if (tier === 'fast' && tiers?.fast) return tiers.fast;
        if ((tier === 'fast' || tier === 'standard') && tiers?.standard) return tiers.standard;
        return tiers?.optimal;
    }
    private updateUI(selected = false): void {
        const connection = this.effectiveConnection(), model = this.modelName(connection);
        this.deps.onReasoning?.(connection?.reasoningByTier?.[this.modelTier === 'auto' ? 'optimal' : this.modelTier], `${connection?.id ?? ''}/${model ?? ''}`, selected);
        const requested = this.connectionId ?? this.agentDefaultConnectionId;
        const source = connection?.name ?? (requested ? t('connection.unavailable', {id: requested}) : t('connection.unset'));
        const inherited = this.agentDefaultConnectionId ? t('connection.followAgentDefault', {name: source}) : t('connection.followDefault', {name: source});
        this.label.textContent = model ? `${model} · ${this.connectionId ? source : inherited}` : !this.connectionId && this.agentDefaultConnectionId ? inherited : source;
        this.trigger.title = [t('chatInput.modelHint'), source, connection?.providerName ?? connection?.provider, this.tierLabel(this.modelTier)].filter(Boolean).join(' · ');
        this.trigger.setAttribute('aria-label', `${t('chatInput.model')}: ${this.label.textContent} · ${this.trigger.title}`);
        this.connectionSelect.value = this.connectionId ?? '';
        const defaultOption = this.connectionSelect.querySelector<HTMLOptionElement>('option[value=""]');
        if (defaultOption) defaultOption.textContent = this.agentDefaultConnectionId
            ? t('connection.followAgentDefault', {name: this.defaultConnection()?.name ?? this.agentDefaultConnectionId}) : t('connection.followDefaultShort');
        for (const card of this.tierCards.querySelectorAll<HTMLButtonElement>('[data-tier]')) {
            const tier = card.dataset.tier!;
            card.classList.toggle('active', tier === this.modelTier); card.setAttribute('aria-pressed', String(tier === this.modelTier));
            card.disabled = this.trigger.disabled || (tier !== 'auto' && tier !== 'optimal' && !connection?.tiers?.[tier as ModelTier]);
            const label = card.querySelector('[data-tier-model]'); if (label) label.textContent = this.modelName(connection, tier as 'auto' | ModelTier) ?? '';
        }
    }
    openConnPicker(): void {
        if (this.trigger.disabled || this.trigger.hidden) return;
        void this.deps.onRefreshConnections?.();
        this.popup ??= new PopupPanel(this.trigger, {locale: getLocale(), positionAnchor: this.trigger.closest<HTMLElement>('.llm-input') ?? undefined, showSearch: true, animated: true, maxVisible: 50,
            searchPlaceholder: t('chatInput.searchModels'), emptyText: t('chatInput.noModels')});
        this.trigger.setAttribute('aria-expanded', 'true');
        this.popup.show(this.buildItems(), {onSelect: item => this.select(item.id), onClose: () => {
            this.trigger.setAttribute('aria-expanded', 'false');
            if (document.activeElement?.closest('.llm-popup')) this.trigger.focus();
        }});
    }
    private select(id: string): void {
        if (id === 'manage') { this.deps.onNavigateSettings({resourceId: 'connections'}); return; }
        if (id === 'default') {
            const connection = this.defaultConnection();
            if (connection?.enabled === false || !(connection?.credentialsReady ?? connection?.hasApiKey) || !this.modelName(connection, 'auto')) return;
            this.connectionId = undefined; this.modelTier = 'auto';
        }
        else {
            const [connectionId, tier] = JSON.parse(decodeURIComponent(id.slice('model:'.length))) as [string, ModelTier];
            const connection = this.connections.find(c => c.id === connectionId);
            if (connection?.enabled === false || !(connection?.credentialsReady ?? connection?.hasApiKey) || !connection?.tiers?.[tier]) return;
            this.connectionId = connectionId; this.modelTier = tier;
        }
        this.updateUI(true); this.deps.onChange();
    }
    private buildItems(): PopupItem[] {
        const connection = this.defaultConnection();
        return [{id: 'default', label: t('chatSettings.followDefault'),
            description: [this.agentDefaultConnectionId ? t('connection.followAgentDefault', {name: connection?.name ?? this.agentDefaultConnectionId}) : connection?.name,
                connection?.providerName ?? connection?.provider, this.modelName(connection, 'auto')].filter(Boolean).join(' · '),
            disabled: connection?.enabled === false || !(connection?.credentialsReady ?? connection?.hasApiKey) || !this.modelName(connection, 'auto')},
            ...[...this.connections].sort((a, b) => this.priority(a) - this.priority(b) || Number(!!b.isDefault) - Number(!!a.isDefault)).flatMap(c => this.connectionItems(c)),
            {id: 'manage', label: t('chatInput.manageConnections'), icon: TOOLBOX_ICONS.connections}];
    }
    private connectionItems(connection: ConnectionOption): PopupItem[] {
        const ready = connection.enabled !== false && (connection.credentialsReady ?? connection.hasApiKey);
        const unavailable = connection.enabled === false ? t('connection.status.disabled') : t('connection.credentialsRequired');
        const group = [connection.isDefault ? t('connection.default') : '', connection.name, connection.providerName ?? connection.provider].filter(Boolean).join(' · ');
        const tiers = (['optimal', 'standard', 'fast'] as const).filter(tier => connection.tiers?.[tier]);
        if (!tiers.length) return [{id: `unavailable:${connection.id}`, label: connection.name, group,
            description: ready ? t('chatInput.noModels') : unavailable, disabled: true}];
        return tiers.map(tier => ({id: 'model:' + encodeURIComponent(JSON.stringify([connection.id, tier])),
            label: connection.tiers![tier]!, group, disabled: !ready,
            description: ready ? this.tierLabel(tier) : unavailable,
            searchText: [connection.id, connection.provider, group, tier].join(' '),
            icon: this.connectionId === connection.id && this.modelTier === tier ? TOOLBOX_ICONS.connections : undefined}));
    }
    private priority(connection: ConnectionOption): number {
        if (connection.enabled === false) return 2;
        return (connection.credentialsReady ?? connection.hasApiKey) && Object.values(connection.tiers ?? {}).some(Boolean) ? 0 : 1;
    }
}
