import { escapeHTML, t } from '@itookit/common';
import { TWIN_SELECTION_TYPES, selectionKinds, type DigitalTwinService, type TwinSelectionTarget, type TwinSelectionType } from '@itookit/app-core';
import { label, memoryFields } from './view';
import { memoryInput } from './memory-input';
import { analysisHTML, analysisProgress, analysisStatusHTML, type SourceInfo } from './source-results';

/** One dialog exposes membership, analysis evidence and removal without touching source data. */
export function showTwinSource(service: DigitalTwinService, target: TwinSelectionTarget, settings: () => Promise<void>, signal?: AbortSignal): void {
    if (!signal?.aborted) new TwinSourceDialog(service, target, settings, signal).open();
}
class TwinSourceDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly status = document.createElement('p');
    private readonly error = document.createElement('p');
    private readonly results = document.createElement('div');
    private readonly type = document.createElement('select');
    private readonly add = button('addAndScan');
    private readonly remove = button('removeSelection');
    private readonly progress = document.createElement('div');
    private timer?: ReturnType<typeof setInterval>;
    private historyLimit = 20;
    private info?: SourceInfo;
    private editing?: SourceInfo['memories'][number];
    private busy = false;
    private reading = false;
    private queued = false;
    private initialized = false;
    private unsubscribe?: () => void;
    constructor(private readonly service: DigitalTwinService, private readonly target: TwinSelectionTarget,
        private readonly settings: () => Promise<void>, private readonly signal?: AbortSignal) {}
    open(): void {
        this.buildLayout();
        this.add.onclick = () => { this.progress.hidden = false; this.progress.textContent = label('analysisWaiting'); void this.run(() => this.service.selectSource(this.target, this.type.value as TwinSelectionType)); };
        this.results.onclick = event => this.resultClick(event);
        this.results.onsubmit = event => { event.preventDefault(); void this.saveEdit(event.target as HTMLFormElement); };
        this.remove.onclick = () => { void this.run(() => this.service.removeSelection(this.target)); };
        const configure = this.dialog.querySelector<HTMLButtonElement>('[data-configure]')!;
        const close = this.dialog.querySelector<HTMLButtonElement>('[data-close]')!;
        configure.onclick = () => { void this.run(async () => { await this.settings(); this.dispose(); }); }; close.onclick = this.dispose;
        this.dialog.oncancel = event => { event.preventDefault(); this.dispose(); };
        this.signal?.addEventListener('abort', this.dispose, { once: true });
        this.unsubscribe = this.service.onChange(() => { if (!this.busy) void this.refresh(); });
        this.timer = setInterval(() => {
            if (this.info && !this.busy && analysisProgress(this.info).key === 'analysisRunning') this.renderProgress(this.info);
        }, 1000);
        document.body.append(this.dialog); this.dialog.showModal(); void this.refresh();
    }
    private buildLayout(): void {
        this.dialog.className = 'twin-source-dialog';
        this.dialog.setAttribute('aria-labelledby', 'twin-source-title');
        this.dialog.innerHTML = `<header class="twin-source-dialog__header"><div><h2 id="twin-source-title">${escapeHTML(label('documentAnalysis'))}</h2>
            <p class="twin-source-dialog__name">${escapeHTML(this.target.label)}</p></div></header>
            <div class="twin-source-dialog__body"><div data-state></div>
            <section class="twin-source-dialog__controls"><label data-type>${escapeHTML(label('scanKinds'))}</label><div data-add></div>
            <p class="twin-source-dialog__help">${escapeHTML(label('selectionHelp'))}</p></section><div data-results></div></div>
            <footer class="twin-source-dialog__footer"><div data-remove></div><div data-settings></div></footer>`;
        this.mountControls();
    }
    private mountControls(): void {
        const configure = button('updateSettings'), close = button('close');
        configure.dataset.configure = ''; close.dataset.close = '';
        this.type.setAttribute('aria-label', label('scanKinds'));
        for (const value of TWIN_SELECTION_TYPES) {
            const option = document.createElement('option'); option.value = value;
            option.textContent = label(`selection.${value}`); this.type.append(option);
        }
        this.add.className = 'twin-source-dialog__primary'; this.remove.className = 'twin-source-dialog__danger';
        this.status.className = 'twin-source-dialog__status'; this.status.setAttribute('role', 'status');
        this.status.textContent = label('analysisLoading'); this.error.setAttribute('role', 'alert');
        this.dialog.querySelector('header')!.append(close);
        this.dialog.querySelector('[data-state]')!.append(this.status, this.error);
        this.dialog.querySelector('[data-type]')!.append(this.type);
        this.dialog.querySelector('[data-add]')!.append(this.add);
        this.progress.className = 'twin-source-dialog__status'; this.progress.setAttribute('role', 'status');
        this.progress.hidden = true;
        this.dialog.querySelector('[data-results]')!.append(this.progress, this.results);
        this.dialog.querySelector('[data-remove]')!.append(this.remove);
        this.dialog.querySelector('[data-settings]')!.append(configure);
        this.add.disabled = this.remove.disabled = true;
    }
    private readonly dispose = () => {
        clearInterval(this.timer);
        this.unsubscribe?.(); this.signal?.removeEventListener('abort', this.dispose); this.dialog.remove();
    };
    private async refresh(): Promise<void> {
        if (this.reading) { this.queued = true; return; } this.reading = true;
        try {
            const info = await this.service.selectionInfo(this.target); if (!this.dialog.isConnected) return;
            if (!this.initialized && info.plan) this.type.value = TWIN_SELECTION_TYPES.find(value => JSON.stringify(selectionKinds(value)) === JSON.stringify(info.plan!.data.kinds)) ?? 'all';
            this.initialized = true; this.info = info;
            this.status.dataset.included = String(info.included && !info.ignored);
            this.remove.disabled = this.busy || !!this.editing || (!info.memories.length && !info.included);
            this.status.textContent = [label(info.ignored ? 'selectionRemoved' : info.included ? 'selectionAdded' : 'selectionAbsent'),
                !info.settings.data.connectionId ? label('connectionRequired') : '', info.settings.data.paused ? label('paused') : '', info.worker.error, ...info.discoveryErrors].filter(Boolean).join(' · ');
            this.renderProgress(info);
            if (!this.editing) this.renderResults(info);
            const active = analysisProgress(info).key === 'analysisRunning';
            this.add.textContent = label(active ? 'analysisRunning' : info.included ? 'analysisUpdateNow' : 'addAndScan');
            this.add.disabled = this.busy || !!this.editing || active || !info.settings.data.connectionId;
        } catch (error) { this.error.textContent = message(error); }
        finally { this.reading = false; if (this.queued && this.dialog.isConnected) { this.queued = false; void this.refresh(); } }
    }
    private renderProgress(info: SourceInfo): void {
        this.progress.hidden = !info.included && !info.ignored;
        this.progress.dataset.state = analysisProgress(info).key;
        const html = analysisStatusHTML(info);
        if (this.progress.innerHTML !== html) this.progress.innerHTML = html;
    }
    private renderResults(info: SourceInfo): void {
        const expanded = this.results.querySelector('details')?.open;
        const html = analysisHTML(info, this.historyLimit);
        if (this.results.innerHTML === html) return;
        this.results.innerHTML = html;
        const details = this.results.querySelector('details'); if (details && expanded) details.open = true;
    }
    private resultClick(event: MouseEvent): void {
        if (this.busy) return;
        const target = event.target as HTMLElement;
        if (target.closest('[data-show-history]') && this.info) { this.historyLimit = Infinity; this.renderResults(this.info); return; }
        if (target.closest('[data-cancel-edit]')) { this.editing = undefined; this.error.textContent = ''; void this.refresh(); return; }
        const id = target.closest<HTMLButtonElement>('[data-edit]')?.dataset.edit;
        const memory = this.info?.memories.find(memory => memory.id === id);
        if (!memory || this.editing) return;
        this.editing = memory; this.add.disabled = this.remove.disabled = true;
        const card = target.closest('article')!;
        const form = document.createElement('form'); form.className = 'twin-source-dialog__edit';
        form.innerHTML = `<p class="twin-source-dialog__help">${escapeHTML(label('analysisEditHelp'))}</p>
            ${memoryFields(memory)}<div><button type="submit" class="twin-source-dialog__primary">${escapeHTML(label('save'))}</button>
            <button type="button" data-cancel-edit>${escapeHTML(label('cancel'))}</button></div>`;
        card.replaceChildren(form); form.querySelector('textarea')?.focus();
    }
    private async saveEdit(form: HTMLFormElement): Promise<void> {
        const memory = this.editing; if (!memory || this.busy || !form.reportValidity()) return;
        const input = memoryInput(new FormData(form));
        await this.run(async () => {
            await this.service.review(memory.id, memory.revision, 'correct', input);
            this.editing = undefined;
        });
    }
    private async run(action: () => Promise<void>): Promise<void> {
        if (this.busy) return; this.busy = true; this.type.disabled = true; this.add.disabled = this.remove.disabled = true; this.error.textContent = '';
        const controls = [...this.results.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')];
        controls.forEach(control => { control.disabled = true; });
        try { await action(); }
        catch (error) { this.error.textContent = message(error); }
        finally { controls.forEach(control => { control.disabled = false; }); this.busy = false; this.type.disabled = false; await this.refresh(); }
    }
}
function button(key: string): HTMLButtonElement { const value = document.createElement('button'); value.type = 'button'; value.textContent = label(key); return value; }
function message(error: unknown): string {
    if (error instanceof Error && error.message === 'TWIN_REVIEW_CONFLICT') return label('analysisConflict') + ' (TWIN_REVIEW_CONFLICT)';
    return error instanceof Error ? error.message : t('twin.loadTimeout');
}
