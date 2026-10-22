import { escapeHTML, escapeAttr, t } from '@itookit/common';
import { type RestorableItem, type IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { BaseSettingsEditor, Toast, Modal, type EditorOptions } from '@itookit/ui-common';
import { InitialFilesSection, type InitialFilesPort } from './initial-files';

type ItemType = RestorableItem['type'];
const groups: ItemType[] = ['agent'];

export class RecoverySettingsEditor extends BaseSettingsEditor<IAgentManagementService> {
    private initialFiles?: InitialFilesSection;
    private selectedItems = new Set<string>();
    private allItems: RestorableItem[] = [];
    private expandedGroups = new Set<ItemType>(groups);
    private busy = false;
    private disposed = false;
    private generation = 0;

    constructor(container: HTMLElement, service: IAgentManagementService, options: EditorOptions,
        private readonly restoreFlows?: () => Promise<number>, initialFiles?: InitialFilesPort) {
        super(container, service, options);
        if (initialFiles) this.initialFiles = new InitialFilesSection(initialFiles, undefined,
            { externalActions: true, selectionChanged: () => this.refreshUIState() });
    }

    async render(): Promise<void> {
        const generation = ++this.generation, items = (await this.service.getRestorableItems()).filter(item => groups.includes(item.type));
        if (this.disposed || generation !== this.generation) return;
        this.allItems = items;
        this.selectedItems = new Set(items.filter(item => this.selectedItems.has(this.key(item))).map(item => this.key(item)));
        this.rememberExpansion();
        this.clearListeners();
        this.container.innerHTML = `<div class="settings-page">
            ${this.renderHeader()}<div data-recovery-warnings>${this.buildDuplicateWarnings()}</div>
            ${this.initialFiles ? '<div data-initial-files></div>' : this.renderLegacyFlows()}
            <section class="settings-section"><h3>${escapeHTML(t('recovery.configuration'))}</h3>
                <p>${escapeHTML(t('recovery.configurationHelp'))}</p>
                ${groups.map(group => this.renderSection(group)).join('')}</section></div>`;
        if (this.initialFiles) await this.initialFiles.mount(this.container.querySelector<HTMLElement>('[data-initial-files]')!);
        if (this.disposed || generation !== this.generation) return;
        this.bindEvents(); this.refreshUIState();
    }

    private renderHeader(): string {
        return `<div class="settings-page__header"><div>
            <h2 class="settings-page__title">${escapeHTML(t('recovery.title'))}</h2>
            <p class="settings-page__description">${escapeHTML(t('recovery.help'))}</p></div>
            <div class="recovery-page__actions">
                <button id="btn-refresh-recovery" class="settings-btn settings-btn--secondary">${escapeHTML(t('recovery.refresh'))}</button>
                <button id="btn-batch-restore" class="settings-btn settings-btn--primary" disabled></button>
                <button id="btn-reset-all" class="settings-btn settings-btn--danger">${escapeHTML(t('recovery.resetAll'))}</button>
            </div></div>`;
    }

    private renderLegacyFlows(): string {
        if (!this.restoreFlows) return '';
        return `<section class="settings-section"><h3>${escapeHTML(t('flow.library.restore'))}</h3>
            <p>${escapeHTML(t('flow.library.recoveryHint'))}</p>
            <button id="btn-restore-flows" class="settings-btn settings-btn--secondary">${escapeHTML(t('flow.library.restore'))}</button></section>`;
    }

    private buildDuplicateWarnings(): string {
        const items = this.allItems.filter(item => item.duplicatePaths?.length);
        if (!items.length) return '';
        return `<div class="recovery-page__warning">${escapeHTML(t('recovery.duplicates', { count: items.length }))}
            <ul>${items.map(item => `<li>${escapeHTML(this.key(item))}: ${item.duplicatePaths!.map(path => `<code>${escapeHTML(path)}</code>`).join(', ')}</li>`).join('')}</ul></div>`;
    }

    private renderSection(group: ItemType): string {
        const items = this.allItems.filter(item => item.type === group);
        return `<details class="recovery-page__group" data-recovery-group="${group}" ${this.expandedGroups.has(group) ? 'open' : ''}><summary>
            <span class="settings-section-title">${escapeHTML(t(`recovery.${group}`))}</span>
            <label class="settings-checkbox-label"><input type="checkbox" class="chk-select-all" data-group="${group}" ${!items.length ? 'disabled' : ''}>${escapeHTML(t('initialFiles.all'))}</label>
            </summary><div class="settings-list-group">${items.length ? items.map(item => this.renderRow(item)).join('') : escapeHTML(t('recovery.empty'))}</div></details>`;
    }

    private renderRow(item: RestorableItem): string {
        const key = this.key(item), selected = this.selectedItems.has(key);
        const style = { missing: 'danger', modified: 'warning', ok: 'success' }[item.status];
        const duplicate = item.duplicatePaths?.length ? `<span class="settings-badge settings-badge--danger" title="${escapeAttr(item.duplicatePaths.join(', '))}">${escapeHTML(t('recovery.duplicate'))}</span>` : '';
        return `<div class="settings-list-item${selected ? ' settings-list-item--selected' : ''}" data-key="${escapeAttr(key)}">
            <div class="settings-list-item__check"><input type="checkbox" class="chk-item" value="${escapeAttr(key)}" ${selected ? 'checked' : ''}></div>
            <div class="settings-list-item__icon">${escapeHTML(item.icon ?? '')}</div>
            <div class="settings-list-item__content"><div class="settings-list-item__title">${escapeHTML(item.name)}
                <span class="settings-badge settings-badge--${style}">${escapeHTML(t(`recovery.${item.status}`))}</span>${duplicate}</div>
                <div class="settings-list-item__desc">${escapeHTML(item.description ?? '')} · ID: ${escapeHTML(item.id)}</div></div></div>`;
    }

    private bindEvents(): void {
        this.addEventListener(this.container.querySelector('#btn-refresh-recovery'), 'click', () => { void this.runBusy(() => this.refreshAll()); });
        this.addEventListener(this.container.querySelector('#btn-batch-restore'), 'click', () => this.handleBatchRestore());
        this.addEventListener(this.container.querySelector('#btn-reset-all'), 'click', () => this.handleResetAll());
        this.addEventListener(this.container.querySelector('#btn-restore-flows'), 'click', () => { void this.runBusy(async () => {
            Toast.success(t('flow.library.restored', { count: await this.restoreFlows!() }));
        }); });
        this.container.querySelectorAll<HTMLElement>('.settings-list-item').forEach(row => {
            this.addEventListener(row, 'click', event => {
                if (this.busy || (event.target as HTMLElement).matches('input')) return;
                const input = row.querySelector<HTMLInputElement>('.chk-item')!;
                input.checked = !input.checked; this.selectItem(input);
            });
        });
        this.container.querySelectorAll<HTMLInputElement>('.chk-item').forEach(input => {
            this.addEventListener(input, 'change', () => this.selectItem(input));
        });
        this.container.querySelectorAll<HTMLInputElement>('.chk-select-all').forEach(input => {
            this.addEventListener(input, 'change', () => {
                if (this.busy) return;
                this.allItems.filter(item => item.type === input.dataset.group).forEach(item => {
                    input.checked ? this.selectedItems.add(this.key(item)) : this.selectedItems.delete(this.key(item));
                });
                this.refreshUIState();
            });
        });
    }

    private key(item: RestorableItem): string { return `${item.type}:${item.id}`; }
    private selectItem(input: HTMLInputElement): void {
        if (this.busy) return;
        input.checked ? this.selectedItems.add(input.value) : this.selectedItems.delete(input.value);
        this.refreshUIState();
    }

    private refreshUIState(): void {
        const count = this.selectedItems.size + (this.initialFiles?.selectedCount ?? 0);
        const button = this.container.querySelector<HTMLButtonElement>('#btn-batch-restore');
        if (button) { button.textContent = t(this.busy ? 'recovery.processing' : 'recovery.restoreSelected', { count }); button.disabled = this.busy || !count; }
        this.container.querySelectorAll<HTMLButtonElement>('#btn-refresh-recovery, #btn-reset-all, #btn-restore-flows').forEach(input => { input.disabled = this.busy; });
        this.container.querySelectorAll<HTMLInputElement>('.chk-item').forEach(input => {
            input.checked = this.selectedItems.has(input.value); input.disabled = this.busy;
            input.closest('.settings-list-item')?.classList.toggle('settings-list-item--selected', input.checked);
        });
        this.container.querySelectorAll<HTMLInputElement>('.chk-select-all').forEach(input => {
            const items = this.allItems.filter(item => item.type === input.dataset.group);
            const selected = items.filter(item => this.selectedItems.has(this.key(item))).length;
            input.checked = !!items.length && selected === items.length;
            input.indeterminate = selected > 0 && selected < items.length; input.disabled = this.busy || !items.length;
        });
    }

    private handleBatchRestore(): void {
        if (this.busy || this.disposed) return;
        const items = this.allItems.filter(item => this.selectedItems.has(this.key(item)));
        const files = this.initialFiles?.selectedCount ?? 0;
        if (!items.length && !files) return;
        const messages = [t('recovery.confirmSelection', { files, configurations: items.length })];
        if (files) messages.push(t('recovery.filesHelp'));
        if (items.length) messages.push(t('recovery.configurationHelp'));
        if (items.some(item => item.duplicatePaths?.length)) messages.push(t('recovery.mergeDuplicates'));
        new Modal(t('recovery.confirmTitle'), messages.map(message => `<p>${escapeHTML(message)}</p>`).join(''), {
            type: items.length ? 'danger' : 'default', confirmText: t('action.confirm'), cancelText: t('action.cancel'),
            onConfirm: () => this.runBusy(() => this.restoreSelection(items, files > 0)),
        }).show();
    }

    private async restoreSelection(items: RestorableItem[], files: boolean): Promise<void> {
        const operations = items.map(item => (async () => {
            await this.service.restoreItem(item.type, item.id); this.selectedItems.delete(this.key(item)); return true;
        })());
        if (files) operations.push(this.initialFiles!.restore());
        const results = await Promise.allSettled(operations);
        const failures = results.filter(result => result.status === 'rejected' || !result.value);
        if (failures.length) Toast.warning(t('recovery.partialFailure', { count: failures.length }));
        else Toast.success(t('recovery.completed'));
        // InitialFilesSection already refreshed its own results and existence state.
        await this.refreshConfigurations();
    }

    private async refreshConfigurations(): Promise<void> {
        const items = (await this.service.getRestorableItems()).filter(item => groups.includes(item.type)); if (this.disposed) return;
        this.rememberExpansion();
        this.allItems = items;
        this.selectedItems = new Set(items.filter(item => this.selectedItems.has(this.key(item))).map(item => this.key(item)));
        const warnings = this.container.querySelector('[data-recovery-warnings]');
        if (warnings) warnings.innerHTML = this.buildDuplicateWarnings();
        groups.forEach(group => {
            const header = this.container.querySelector(`.chk-select-all[data-group="${group}"]`)?.closest('.recovery-page__group');
            if (header) header.outerHTML = this.renderSection(group);
        });
        this.clearListeners(); this.bindEvents(); this.refreshUIState();
    }

    private rememberExpansion(): void {
        this.container.querySelectorAll<HTMLDetailsElement>('details[data-recovery-group]').forEach(detail => {
            const group = detail.dataset.recoveryGroup as ItemType;
            detail.open ? this.expandedGroups.add(group) : this.expandedGroups.delete(group);
        });
    }

    private async refreshAll(): Promise<void> {
        const results = await Promise.allSettled([this.refreshConfigurations(), this.initialFiles?.refresh()]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
    }

    private handleResetAll(): void {
        if (this.busy || this.disposed) return;
        new Modal(t('recovery.resetAll'), `<p>${escapeHTML(t('recovery.resetHelp'))}</p><p>${escapeHTML(t('recovery.mergeDuplicates'))}</p>`, {
            type: 'danger', confirmText: t('action.confirm'), cancelText: t('action.cancel'),
            onConfirm: () => this.runBusy(() => this.restoreSelection(this.allItems, false)),
        }).show();
    }

    private async runBusy(action: () => Promise<void>): Promise<void> {
        if (this.busy || this.disposed) return;
        this.busy = true; this.initialFiles?.setDisabled(true); this.refreshUIState();
        try { await action(); }
        catch (error) { Toast.error(String(error)); }
        finally { this.busy = false; this.initialFiles?.setDisabled(false); this.refreshUIState(); }
    }

    protected override onServiceChange(): void { if (!this.busy && !this.disposed) void this.runBusy(() => this.refreshAll()); }
    async destroy(): Promise<void> { this.disposed = true; this.generation++; this.initialFiles?.destroy(); await super.destroy(); }
}
