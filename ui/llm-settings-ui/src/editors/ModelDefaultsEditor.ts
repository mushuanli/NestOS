import { escapeAttr, escapeHTML, randomUUID, t } from '@itookit/common';
import { BaseSettingsEditor, OcrSettingsForm, type EditorOptions, type OcrControls } from '@itookit/ui-common';
import { MODEL_OPERATIONS, hasConnectionCredentials, modelForOperation, type IConnectionService, type ModelDefaults, type ModelOperation, type MediaProbeExamples } from '@itookit/kernel-adapters/contracts';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import { mountMediaProbe } from './provider-media-probe';
import { providerTestResult } from './provider-test-result';
import { matchesModelQuery, modelChoiceLabel, modelPriceLabel } from '../utils/modelChoice';
import { renderModelCapabilityBadges } from '../utils/modelBadges';
import { modelPriceSource } from '../utils/modelPrice';
import type { ModelPricingConfig } from '@itookit/kernel-adapters/contracts';
import './model-defaults.css';

export class ModelDefaultsEditor extends BaseSettingsEditor<IConnectionService> {
    protected supportsFormRecovery = true;
    private connections: ConnectionMeta[] = [];
    private providers: LLMProvider[] = [];
    private defaults: ModelDefaults = {};
    private stops: Array<() => void> = [];
    private pending?: Promise<void>;
    private closed = false;
    private generation = 0;
    private fingerprint?: string;
    private ocrForm?: OcrSettingsForm;
    private pricing?: ModelPricingConfig;
    private query = '';
    private recoveringDraft = false;
    private verifying = 0;
    private readonly choices = new WeakMap<HTMLSelectElement, HTMLOptionElement[]>();
    private readonly ocrContainer = document.createElement('section');

    constructor(container: HTMLElement, service: IConnectionService, options: EditorOptions,
        private readonly ocr?: OcrControls, private readonly mediaProbeExamples: MediaProbeExamples = {}) { super(container, service, options); }

    protected onServiceChange(): void { if (!this.pending && !this.recoveringDraft) void this.render(); }
    async render(): Promise<void> {
        const generation = ++this.generation;
        try {
            const [connections, defaults] = await Promise.all([this.service.getConnections(), this.service.getModelDefaults()]);
            if (this.closed || generation !== this.generation) return;
            this.connections = connections; this.defaults = defaults; this.providers = this.service.getProviders();
            this.pricing = this.service.getPricingConfig?.();
            const fingerprint = JSON.stringify([defaults, this.pricing, connections.map(({ id, name, providerId, enabled, credentialsReady, hasApiKey, model, tiers, protocol, baseURL }) => ({ id, name, providerId, enabled, credentialsReady, hasApiKey, model, tiers, protocol, baseURL })),
                this.providers.map(({ id, name, enabled, models, media, baseURL, defaultProtocol, implementation }) => ({ id, name, enabled, models, media, baseURL, defaultProtocol, implementation }))]);
            if (fingerprint === this.fingerprint) return;
            this.fingerprint = fingerprint;
            this.stops.splice(0).forEach(stop => stop()); this.clearListeners();
            this.container.innerHTML = `<section class="model-defaults"><h2>${t('modelDefaults.title')}</h2>
                <p>${t('modelDefaults.description')}</p>${this.searchField()}${MODEL_OPERATIONS.map(operation => this.row(operation)).join('')}
                ${this.ocr ? '<section data-ocr-default></section>' : ''}
                <p role="status" data-defaults-result></p><div class="model-defaults__actions">
                <button type="button" class="settings-btn settings-btn--secondary" data-manage="connections">${t('modelDefaults.manageModels')}</button>
                <button type="button" class="settings-btn settings-btn--secondary" data-manage="providers">${t('modelDefaults.manageServices')}</button></div>
                <details><summary>${t('modelDefaults.advanced')}</summary><p>${t('modelDefaults.priority')}</p><p>${t('modelDefaults.harness')}</p></details></section>`;
            this.bind(); this.filterChoices();
            await this.mountOcr();
        } catch (error) { if (!this.closed && generation === this.generation) { this.fingerprint = undefined; this.showError(error); } }
    }

    private searchField(): string {
        return `<label class="model-defaults__search">${t('connection.modelSearch')}
            <input type="search" class="settings-form__input" data-default-search data-autosave-ignore value="${escapeAttr(this.query)}"
                placeholder="${t('modelDefaults.searchPlaceholder')}" aria-describedby="model-defaults-search-help"></label>
            <p class="settings-form__help" id="model-defaults-search-help">${t('connection.modelSearchHelp')}</p>`;
    }

    private async mountOcr(): Promise<void> {
        if (!this.ocr) return;
        this.ocrContainer.className = 'model-defaults__row';
        this.container.querySelector('[data-ocr-default]')!.replaceWith(this.ocrContainer);
        if (!this.ocrForm) {
            this.ocrForm = new OcrSettingsForm(this.ocrContainer, this.ocr, true);
            await this.ocrForm.refresh();
        }
    }

    private row(operation: ModelOperation): string {
        const selected = this.defaults[operation], current = this.connections.find(item => item.id === selected);
        const candidates = this.connections.filter(item => modelForOperation(item, this.provider(item), operation));
        const options = candidates.sort((a, b) => Number(!available(a)) - Number(!available(b)) || a.name.localeCompare(b.name))
            .map(item => `<option value="${escapeAttr(item.id)}" ${item.id === selected ? 'selected' : ''} ${available(item) ? '' : 'disabled'}>${escapeHTML(this.label(item, operation))}${available(item) ? '' : ` · ${escapeHTML(unavailableReason(item))}`}</option>`).join('');
        const missing = selected && !candidates.some(item => item.id === selected)
            ? `<option selected value="${escapeAttr(selected)}">${escapeHTML(t('connection.unavailable', { id: selected }))}</option>` : '';
        const ready = current && available(current) && modelForOperation(current, this.provider(current), operation);
        return `<section class="model-defaults__row" data-purpose="${operation}"><label for="default-${operation}">${purposeLabel(operation)}</label>
            <select id="default-${operation}" class="settings-form__select" data-default-operation="${operation}"><option value="">${t('modelDefaults.unset')}</option>${missing}${options}</select>
            <div class="model-defaults__model" data-default-model="${operation}">${this.modelInfo(operation, current)}</div>
            <p class="model-defaults__status">${this.selectionStatus(operation, current)}</p>
            ${this.verification(operation, !!ready)}</section>`;
    }

    private selectionStatus(operation: ModelOperation, current?: ConnectionMeta): string {
        if (!this.defaults[operation]) return t('modelDefaults.notConfigured');
        if (!current) return t('modelDefaults.incompatible');
        if (!available(current)) return unavailableReason(current);
        return t(modelForOperation(current, this.provider(current), operation) ? 'modelDefaults.unverified' : 'modelDefaults.incompatible');
    }
    private verification(operation: ModelOperation, ready: boolean): string {
        if (!ready) return '';
        if (operation === 'chat') return `<button type="button" class="settings-btn settings-btn--secondary" data-chat-probe>${t('modelDefaults.verify')}</button><p role="status" data-chat-result></p>`;
        return `<details data-media-probe><summary>${t('modelDefaults.verify')}</summary><form><div data-provider-panel="overview"></div></form></details>`;
    }

    private label(connection: ConnectionMeta, operation: ModelOperation): string {
        const provider = this.provider(connection), model = modelForOperation(connection, provider, operation);
        return `${connection.name} · ${provider?.name ?? connection.providerId} · ${model ? modelChoiceLabel(model, connection.providerId, this.pricing) : ''}`;
    }
    private modelInfo(operation: ModelOperation, connection?: ConnectionMeta): string {
        if (!connection) return '';
        const model = modelForOperation(connection, this.provider(connection), operation);
        if (!model) return '';
        const source = modelPriceSource(connection.providerId, this.pricing, model.id);
        return `${renderModelCapabilityBadges(model)}<span>${escapeHTML(modelPriceLabel(model, connection.providerId, this.pricing))}</span>
            ${source ? `<a href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(t('connection.modelPriceSource', {date: source.reviewedAt}))}</a>` : ''}`;
    }
    private matches(connection: ConnectionMeta, operation: ModelOperation): boolean {
        const model = modelForOperation(connection, this.provider(connection), operation);
        return !!model && matchesModelQuery({...model, name: [connection.name, this.provider(connection)?.name, model.name].join(' ')}, this.query);
    }
    private filterChoices(): void {
        for (const select of this.container.querySelectorAll<HTMLSelectElement>('[data-default-operation]')) {
            const value = select.value, operation = select.dataset.defaultOperation as ModelOperation;
            const choices = this.choices.get(select) ?? [...select.options]; this.choices.set(select, choices);
            const options = choices.flatMap(option => {
                const connection = this.connections.find(item => item.id === option.value);
                const matches = !option.value || !!connection && this.matches(connection, operation);
                if (!matches && option.value !== value) return [];
                const copy = option.cloneNode(true) as HTMLOptionElement;
                if (!matches) copy.textContent += ` · ${t('connection.modelSelectedOutsideFilter', {model: ''}).trim()}`;
                return [copy];
            });
            select.replaceChildren(...options); select.value = value;
        }
    }
    private provider(connection: ConnectionMeta): LLMProvider | undefined { return this.providers.find(item => item.id === connection.providerId); }
    private bind(): void {
        this.addEventListener(this.container.querySelector('[data-default-search]'), 'input', event => {
            this.query = (event.target as HTMLInputElement).value; this.filterChoices();
        });
        this.addEventListener(this.container, 'change', event => {
            const select = event.target as HTMLSelectElement, operation = select.dataset.defaultOperation as ModelOperation | undefined;
            if (operation) this.save(operation, select.value || null);
        });
        for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-manage]')) button.onclick = () => {
            const kind = button.dataset.manage!;
            void this.options.hostContext?.navigate({ target: 'toolbox', resourceId: '/' + kind });
        };
        const chat = this.container.querySelector<HTMLButtonElement>('[data-chat-probe]');
        if (chat) chat.onclick = () => { void this.probeChat(chat); };
        for (const root of this.container.querySelectorAll<HTMLElement>('[data-media-probe]')) this.mountProbe(root);
    }

    private save(operation: ModelOperation, id: string | null): void {
        if (this.pending) return;
        this.recoveringDraft = false;
        this.container.querySelectorAll<HTMLSelectElement>('[data-default-operation]').forEach(select => { select.disabled = true; });
        this.pending = this.service.setModelDefault(operation, id).then(async () => {
            if (!this.closed) { await this.render(); this.result().textContent = t('modelDefaults.saved'); }
        }).catch(error => { if (!this.closed) { this.restoreSelections(); this.showError(error); } })
            .finally(() => { this.pending = undefined; if (!this.closed) this.container.querySelectorAll<HTMLSelectElement>('[data-default-operation]').forEach(select => { select.disabled = false; }); });
    }
    private restoreSelections(): void {
        this.container.querySelectorAll<HTMLSelectElement>('[data-default-operation]').forEach(select => { select.value = this.defaults[select.dataset.defaultOperation as ModelOperation] ?? ''; });
    }
    private mountProbe(root: HTMLElement): void {
        const operation = root.closest<HTMLElement>('[data-purpose]')!.dataset.purpose as ModelOperation;
        const connection = this.connections.find(item => item.id === this.defaults[operation])!, provider = this.provider(connection)!;
        const model = modelForOperation(connection, provider, operation)!;
        const draft = { ...provider, baseURL: connection.baseURL ?? provider.baseURL,
            models: [{ ...model, operations: { [operation]: model.operations?.[operation as 'image.generate' | 'speech.synthesize'] } }] };
        this.stops.push(mountMediaProbe(root.querySelector('form')!, () => draft,
            request => {
                this.verifying++;
                return this.service.testConnection({ ...request, protocol: connection.protocol }).then(response => {
                    this.showVerification(root, response.success); return response;
                }, error => { this.showVerification(root, false); throw error; }).finally(() => { this.verifying--; });
            }, this.mediaProbeExamples, this.service.getProviderReferences?.()[provider.id]));
    }
    private async probeChat(button: HTMLButtonElement): Promise<void> {
        const connection = this.connections.find(item => item.id === this.defaults.chat)!;
        const provider = this.provider(connection)!, model = modelForOperation(connection, provider, 'chat')!;
        const result = this.container.querySelector<HTMLElement>('[data-chat-result]')!, operationId = randomUUID(), started = performance.now();
        button.disabled = true; this.verifying++; result.textContent = t('provider.protocol.testing');
        try {
            const response = await this.service.testConnection({ provider: provider.id, model: model.id, baseURL: connection.baseURL, protocol: connection.protocol });
            if (!this.closed && result.isConnected) { result.textContent = providerTestResult(response); this.showVerification(result, response.success); }
        } catch (error) {
            console.error('model.defaults.probe.failed', { operation: 'model.defaults.verify', operationId, stage: 'request', code: 'MODEL_DEFAULT_PROBE_FAILED', durationMs: Math.round(performance.now() - started) });
            if (!this.closed && result.isConnected) { result.textContent = error instanceof Error ? error.message : String(error); this.showVerification(result, false); }
        } finally { this.verifying--; if (!this.closed) button.disabled = false; }
    }
    private showVerification(root: HTMLElement, success: boolean): void {
        const status = root.closest('[data-purpose]')?.querySelector<HTMLElement>('.model-defaults__status');
        if (!this.closed && root.isConnected && status) status.textContent = t(success ? 'modelDefaults.verified' : 'modelDefaults.verificationFailed');
    }
    private result(): HTMLElement { return this.container.querySelector<HTMLElement>('[data-defaults-result]')!; }
    private showError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        const result = this.container.querySelector<HTMLElement>('[data-defaults-result]');
        if (result) { result.textContent = message; return; }
        const description = document.createElement('p'), retry = document.createElement('button');
        description.textContent = message; description.setAttribute('role', 'alert');
        retry.type = 'button'; retry.className = 'settings-btn settings-btn--secondary'; retry.textContent = t('settings.autosave.retry');
        retry.onclick = () => { void this.render(); };
        this.container.replaceChildren(description, retry);
    }
    captureRecovery(): unknown {
        const uploading = [...this.container.querySelectorAll<HTMLInputElement>('input[type=file]')].some(input => input.files?.length);
        if (this.pending || this.ocrForm?.isDirty() || this.verifying || uploading)
            throw Object.assign(new Error(t('httpApp.recoveryBusy')), {code: 'RECOVERY_BUSY'});
        return super.captureRecovery();
    }
    restoreRecovery(snapshot: unknown): void {
        const state = snapshot as {model: {ocrId?: string}};
        if (state.model.ocrId || !this.ocrContainer.querySelector('[name=ocr-connection]')) {
            super.restoreRecovery(snapshot); return;
        }
        // A failed initial OCR read contained no editable OCR fields to restore.
        const placeholder = document.createComment('OCR configuration'); this.ocrContainer.replaceWith(placeholder);
        try { super.restoreRecovery(snapshot); }
        finally { placeholder.replaceWith(this.ocrContainer); }
    }
    protected captureRecoveryModel(): unknown {
        return {query: this.container.querySelector<HTMLInputElement>('[data-default-search]')?.value ?? this.query,
            ocrId: this.container.querySelector<HTMLSelectElement>('[name=ocr-connection]')?.id,
            expanded: [...this.container.querySelectorAll<HTMLDetailsElement>('[data-media-probe][open]')].map(root => root.closest<HTMLElement>('[data-purpose]')!.dataset.purpose)};
    }
    protected restoreRecoveryModel(snapshot: unknown): void {
        const state = snapshot as {query: string; ocrId?: string; expanded: string[]}; this.query = state.query;
        const select = this.container.querySelector<HTMLSelectElement>('[name=ocr-connection]');
        if (select && state.ocrId) {
            const label = this.ocrContainer.querySelector<HTMLLabelElement>('label');
            select.id = state.ocrId; if (label) label.htmlFor = state.ocrId;
        }
        for (const root of this.container.querySelectorAll<HTMLDetailsElement>('[data-media-probe]'))
            root.open = state.expanded.includes(root.closest<HTMLElement>('[data-purpose]')!.dataset.purpose!);
    }
    protected afterRestoreRecovery(): void {
        this.recoveringDraft = true; this.filterChoices();
        for (const root of this.container.querySelectorAll<HTMLElement>('[data-default-model]')) {
            const operation = root.dataset.defaultModel as ModelOperation;
            const value = this.container.querySelector<HTMLSelectElement>(`[data-default-operation="${operation}"]`)!.value;
            root.innerHTML = this.modelInfo(operation, this.connections.find(item => item.id === value));
        }
    }
    suspendForRecovery(): void {
        this.closed = true; ++this.generation; this.ocrForm?.destroy();
        this.stops.splice(0).forEach(stop => stop()); super.suspendForRecovery();
    }
    async flushPendingSave(): Promise<void> { await Promise.all([this.pending, this.ocrForm?.flushPendingSave()]); }
    isDirty(): boolean { return !!this.pending || !!this.ocrForm?.isDirty() || super.isDirty(); }
    async navigateToAnchor(anchor: string): Promise<void> {
        if (anchor === 'ocr') { this.ocrContainer.querySelector('select')?.focus(); this.ocrContainer.scrollIntoView?.({ block: 'nearest' }); return; }
        const select = [...this.container.querySelectorAll<HTMLSelectElement>('[data-default-operation]')].find(select => select.dataset.defaultOperation === anchor);
        select?.focus(); select?.scrollIntoView?.({ block: 'nearest' });
    }
    async destroy(): Promise<void> {
        await this.flushPendingSave(); this.closed = true; ++this.generation; this.ocrForm?.destroy();
        this.stops.splice(0).forEach(stop => stop()); await super.destroy();
    }
}

function available(connection: ConnectionMeta): boolean { return connection.enabled !== false && hasConnectionCredentials(connection); }
function unavailableReason(connection: ConnectionMeta): string { return t(connection.enabled === false ? 'modelDefaults.disabled' : 'modelDefaults.credentials'); }
function purposeLabel(operation: ModelOperation): string { return t(`modelDefaults.purpose.${operation}`); }
