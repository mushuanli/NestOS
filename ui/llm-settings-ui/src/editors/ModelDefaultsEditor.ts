import { escapeAttr, escapeHTML, randomUUID, t } from '@itookit/common';
import { BaseSettingsEditor, OcrSettingsForm, type EditorOptions, type OcrControls } from '@itookit/ui-common';
import { MODEL_OPERATIONS, hasConnectionCredentials, modelForOperation, type IConnectionService, type ModelDefaults, type ModelOperation, type MediaProbeExamples } from '@itookit/kernel-adapters/contracts';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import { mountMediaProbe } from './provider-media-probe';
import { providerTestResult } from './provider-test-result';
import './model-defaults.css';

export class ModelDefaultsEditor extends BaseSettingsEditor<IConnectionService> {
    private connections: ConnectionMeta[] = [];
    private providers: LLMProvider[] = [];
    private defaults: ModelDefaults = {};
    private stops: Array<() => void> = [];
    private pending?: Promise<void>;
    private closed = false;
    private generation = 0;
    private fingerprint?: string;
    private ocrForm?: OcrSettingsForm;
    private readonly ocrContainer = document.createElement('section');

    constructor(container: HTMLElement, service: IConnectionService, options: EditorOptions,
        private readonly ocr?: OcrControls, private readonly mediaProbeExamples: MediaProbeExamples = {}) { super(container, service, options); }

    protected onServiceChange(): void { if (!this.pending) void this.render(); }
    async render(): Promise<void> {
        const generation = ++this.generation;
        try {
            const [connections, defaults] = await Promise.all([this.service.getConnections(), this.service.getModelDefaults()]);
            if (this.closed || generation !== this.generation) return;
            this.connections = connections; this.defaults = defaults; this.providers = this.service.getProviders();
            const fingerprint = JSON.stringify([defaults, connections.map(({ id, name, providerId, enabled, credentialsReady, hasApiKey, model, tiers, protocol, baseURL }) => ({ id, name, providerId, enabled, credentialsReady, hasApiKey, model, tiers, protocol, baseURL })),
                this.providers.map(({ id, name, enabled, models, media, baseURL, defaultProtocol, implementation }) => ({ id, name, enabled, models, media, baseURL, defaultProtocol, implementation }))]);
            if (fingerprint === this.fingerprint) return;
            this.fingerprint = fingerprint;
            this.stops.splice(0).forEach(stop => stop()); this.clearListeners();
            this.container.innerHTML = `<section class="model-defaults"><h2>${t('modelDefaults.title')}</h2>
                <p>${t('modelDefaults.description')}</p>${MODEL_OPERATIONS.map(operation => this.row(operation)).join('')}
                ${this.ocr ? '<section data-ocr-default></section>' : ''}
                <p role="status" data-defaults-result></p><div class="model-defaults__actions">
                <button type="button" class="settings-btn settings-btn--secondary" data-manage="connections">${t('modelDefaults.manageModels')}</button>
                <button type="button" class="settings-btn settings-btn--secondary" data-manage="providers">${t('modelDefaults.manageServices')}</button></div>
                <details><summary>${t('modelDefaults.advanced')}</summary><p>${t('modelDefaults.priority')}</p><p>${t('modelDefaults.harness')}</p></details></section>`;
            this.bind();
            await this.mountOcr();
        } catch (error) { if (!this.closed && generation === this.generation) { this.fingerprint = undefined; this.showError(error); } }
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
        return `${provider?.name ?? connection.providerId} · ${model?.name || model?.id} · ${connection.name}`;
    }
    private provider(connection: ConnectionMeta): LLMProvider | undefined { return this.providers.find(item => item.id === connection.providerId); }
    private bind(): void {
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
            request => this.service.testConnection({ ...request, protocol: connection.protocol }).then(response => {
                this.showVerification(root, response.success); return response;
            }, error => { this.showVerification(root, false); throw error; }), this.mediaProbeExamples, this.service.getProviderReferences?.()[provider.id]));
    }
    private async probeChat(button: HTMLButtonElement): Promise<void> {
        const connection = this.connections.find(item => item.id === this.defaults.chat)!;
        const provider = this.provider(connection)!, model = modelForOperation(connection, provider, 'chat')!;
        const result = this.container.querySelector<HTMLElement>('[data-chat-result]')!, operationId = randomUUID(), started = performance.now();
        button.disabled = true; result.textContent = t('provider.protocol.testing');
        try {
            const response = await this.service.testConnection({ provider: provider.id, model: model.id, baseURL: connection.baseURL, protocol: connection.protocol });
            if (!this.closed && result.isConnected) { result.textContent = providerTestResult(response); this.showVerification(result, response.success); }
        } catch (error) {
            console.error('model.defaults.probe.failed', { operation: 'model.defaults.verify', operationId, stage: 'request', code: 'MODEL_DEFAULT_PROBE_FAILED', durationMs: Math.round(performance.now() - started) });
            if (!this.closed && result.isConnected) { result.textContent = error instanceof Error ? error.message : String(error); this.showVerification(result, false); }
        } finally { if (!this.closed) button.disabled = false; }
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
