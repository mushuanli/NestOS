import { escapeHTML, randomUUID, t, TOOLBOX_ICONS } from '@itookit/common';
import type { OcrControls, OcrSettingsState } from '../interfaces/OcrControls';

/** Shared fields for the host dialog and the inline chat settings. */
export function renderOcrSettings(state: OcrSettingsState, id: string, compact = false): string {
    const options = (items: OcrSettingsState['connections'], selected?: string) => items.map(item =>
        `<option value="${escapeHTML(item.id)}"${item.id === (selected ?? '') ? ' selected' : ''}${item.disabled ? ' disabled' : ''}>${escapeHTML(item.label)}</option>`).join('');
    if (compact) return `<label for="${id}-connection">${t('ocr.section')}</label>
        <div class="ocr-settings__selection"><select class="settings-form__select" id="${id}-connection" name="ocr-connection">
            ${options(state.connections.filter(item => item.supported !== false || item.id === state.value.connectionId), state.value.connectionId)}</select>
        <button type="button" class="settings-btn settings-btn--secondary ocr-settings__prompt" data-ocr-open="prompt"
            title="${t('ocr.editPrompt')}" aria-label="${t('ocr.editPrompt')}" aria-haspopup="dialog">${TOOLBOX_ICONS.prompts}</button></div>
        <p class="settings-form__help" data-ocr-status role="status" aria-live="polite"></p>`;
    return `<div class="settings-form">
        <p class="settings-form__help">${t('ocr.help')}</p>
        <div class="settings-form__group"><label class="settings-form__label" for="${id}-connection">${t('ocr.connection')}</label>
            <select class="settings-form__select" id="${id}-connection" name="ocr-connection">${options(state.connections, state.value.connectionId)}</select>
            <button type="button" class="settings-btn settings-btn--secondary" data-ocr-open="models">${t('ocr.manageModels')}</button></div>
        <button type="button" class="settings-btn settings-btn--secondary" data-ocr-open="prompt">${t('ocr.editPrompt')}</button>
        <p class="settings-form__help" data-ocr-status role="status" aria-live="polite"></p>
    </div>`;
}
export function readOcrSettings(element: HTMLElement): OcrSettingsState['value'] {
    return { connectionId: element.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!.value || undefined };
}

/** Inline form: save immediately, retain drafts on failure, and discard stale async renders. */
export class OcrSettingsForm {
    private readonly id = 'ocr-' + randomUUID();
    private readonly abort = new AbortController();
    private readonly unsubscribe: () => void;
    private revision = 0;
    private saving = false;
    private dirty = false;
    private rendered?: string;
    private pending?: Promise<void>;
    private failure?: unknown;
    constructor(private readonly container: HTMLElement, private readonly controls: Pick<OcrControls, 'readSettings' | 'saveSettings' | 'openSettings' | 'subscribe'>,
        private readonly compact = false) {
        this.unsubscribe = controls.subscribe(() => { if (!this.saving && !this.dirty) void this.refresh(); });
        container.addEventListener('change', () => { this.dirty = true; this.pending = this.save(); }, { signal: this.abort.signal });
        container.addEventListener('click', event => this.open(event), { signal: this.abort.signal });
    }
    async refresh(): Promise<void> {
        if (this.abort.signal.aborted || this.saving) return;
        const revision = ++this.revision, operationId = randomUUID(), started = performance.now();
        try {
            const state = await this.controls.readSettings();
            if (revision === this.revision && !this.abort.signal.aborted) {
                const markup = renderOcrSettings(state, this.id, this.compact);
                if (this.dirty || this.rendered !== markup) { this.container.innerHTML = markup; this.rendered = markup; }
                this.dirty = false;
            }
        } catch (error) {
            if (revision === this.revision && !this.abort.signal.aborted) {
                console.error('ocr.settings.read', { operation: 'ocr.settings.read', operationId, stage: 'read', outcome: 'failure', code: 'OCR_SETTINGS_READ_FAILED', errorType: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now() - started) });
                this.rendered = undefined; this.container.textContent = error instanceof Error ? error.message : String(error);
                const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.ocrRetry = '';
                retry.className = 'settings-btn settings-btn--secondary'; retry.textContent = t('settings.autosave.retry'); this.container.append(retry);
            }
        }
    }
    private async save(): Promise<void> {
        if (this.saving || this.abort.signal.aborted) return;
        this.saving = true; this.failure = undefined; this.revision++;
        const operationId = randomUUID(), started = performance.now();
        const inputs = this.container.querySelectorAll<HTMLSelectElement>('select'); inputs.forEach(input => { input.disabled = true; });
        try {
            await this.controls.saveSettings(readOcrSettings(this.container));
            console.info('ocr.settings.save', { operation: 'ocr.settings.save', operationId, stage: 'persistence', outcome: 'success', durationMs: Math.round(performance.now() - started) });
            this.saving = false; await this.refresh(); this.status(t('ocr.saved'));
        } catch (error) {
            this.failure = error;
            console.error('ocr.settings.save', { operation: 'ocr.settings.save', operationId, stage: 'persistence', outcome: 'failure', code: 'OCR_SETTINGS_SAVE_FAILED', errorType: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now() - started) });
            this.status(error instanceof Error ? error.message : String(error));
        }
        finally { this.saving = false; inputs.forEach(input => { input.disabled = false; }); }
    }
    private open(event: Event): void {
        if ((event.target as Element).closest('[data-ocr-retry]')) { void this.refresh(); return; }
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-ocr-open]');
        if (!button) return;
        const target = button.dataset.ocrOpen === 'prompt' ? 'prompt' : 'models';
        button.disabled = true;
        void this.controls.openSettings(target).catch(error => this.status(error instanceof Error ? error.message : String(error)))
            .finally(() => { button.disabled = false; });
    }
    async flushPendingSave(): Promise<void> {
        await this.pending;
        if (this.dirty) throw this.failure ?? new Error(t('settings.autosave.invalid'));
    }
    isDirty(): boolean { return this.dirty || this.saving; }
    private status(text: string): void {
        if (this.abort.signal.aborted) return;
        const status = this.container.querySelector<HTMLElement>('[data-ocr-status]'); if (status) status.textContent = text;
    }
    destroy(): void { this.abort.abort(); this.revision++; this.unsubscribe(); }
}
