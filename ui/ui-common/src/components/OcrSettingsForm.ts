import { escapeHTML, randomUUID, t } from '@itookit/common';
import type { OcrControls, OcrSettingsState } from '../interfaces/OcrControls';

/** Shared fields for the host dialog and the inline chat settings. */
export function renderOcrSettings(state: OcrSettingsState, id: string): string {
    const options = (items: OcrSettingsState['connections'], selected?: string) => items.map(item =>
        `<option value="${escapeHTML(item.id)}"${item.id === (selected ?? '') ? ' selected' : ''}${item.disabled ? ' disabled' : ''}>${escapeHTML(item.label)}</option>`).join('');
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
    constructor(private readonly container: HTMLElement, private readonly controls: OcrControls) {
        this.unsubscribe = controls.subscribe(() => { if (!this.saving && !this.dirty) void this.refresh(); });
        container.addEventListener('change', () => { this.dirty = true; void this.save(); }, { signal: this.abort.signal });
        container.addEventListener('click', event => this.open(event), { signal: this.abort.signal });
    }
    async refresh(): Promise<void> {
        if (this.abort.signal.aborted || this.saving) return;
        const revision = ++this.revision;
        try {
            const state = await this.controls.readSettings();
            if (revision === this.revision && !this.abort.signal.aborted) { this.container.innerHTML = renderOcrSettings(state, this.id); this.dirty = false; }
        } catch (error) { if (revision === this.revision && !this.abort.signal.aborted) this.container.textContent = String(error); }
    }
    private async save(): Promise<void> {
        if (this.saving || this.abort.signal.aborted) return;
        this.saving = true; this.revision++;
        const inputs = this.container.querySelectorAll<HTMLSelectElement>('select'); inputs.forEach(input => { input.disabled = true; });
        try {
            await this.controls.saveSettings(readOcrSettings(this.container));
            this.saving = false; await this.refresh(); this.status(t('ocr.saved'));
        } catch (error) { this.status(error instanceof Error ? error.message : String(error)); }
        finally { this.saving = false; inputs.forEach(input => { input.disabled = false; }); }
    }
    private open(event: Event): void {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-ocr-open]');
        if (!button) return;
        const target = button.dataset.ocrOpen === 'prompt' ? 'prompt' : 'models';
        void this.controls.openSettings(target).catch(error => this.status(String(error)));
    }
    private status(text: string): void {
        if (this.abort.signal.aborted) return;
        const status = this.container.querySelector<HTMLElement>('[data-ocr-status]'); if (status) status.textContent = text;
    }
    destroy(): void { this.abort.abort(); this.revision++; this.unsubscribe(); }
}
