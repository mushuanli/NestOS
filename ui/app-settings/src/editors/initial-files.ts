import { escapeHTML, escapeAttr, t, type LocaleKey } from '@itookit/common';

export interface InitialFilesPort {
    list(): Promise<Array<{ id: string; group: 'notes' | 'flows'; name: string; path: string; exists: boolean }>>;
    restore(ids: string[]): Promise<Array<{ id: string; status: 'restored' | 'preserved' | 'failed'; error?: string }>>;
}
const label = (key: string) => t(`initialFiles.${key}` as LocaleKey);

/** Recovery selection is explicit, initially all checked, and survives list refreshes. */
export class InitialFilesSection {
    private container?: HTMLElement;
    private entries: Awaited<ReturnType<InitialFilesPort['list']>> = [];
    private results: Awaited<ReturnType<InitialFilesPort['restore']>> = [];
    private selected?: Set<string>;
    private expanded = new Set<string>();
    private busy = false;
    private error = '';
    private generation = 0;
    constructor(private readonly port: InitialFilesPort, private readonly changed: () => Promise<unknown> = async () => {}) {}
    async mount(container: HTMLElement): Promise<void> { this.unbind(); this.container = container; await this.refresh(); }
    destroy(): void { this.generation++; this.unbind(); this.container = undefined; }
    private unbind(): void { if (this.container) { this.container.onclick = null; this.container.onchange = null; } }
    private async refresh(): Promise<void> {
        const generation = ++this.generation;
        try {
            const entries = await this.port.list(); if (generation !== this.generation) return;
            this.entries = entries; this.selected ??= new Set(entries.map(entry => entry.id));
        } catch (error) { if (generation === this.generation) this.error = String(error); }
        if (generation === this.generation) this.render();
    }
    private render(): void {
        if (!this.container) return;
        const count = this.entries.filter(entry => this.selected?.has(entry.id)).length;
        this.container.innerHTML = `<section class="settings-section initial-files"><h3>${escapeHTML(label('title'))}</h3>
            <p>${escapeHTML(label('help'))}</p><p>${escapeHTML(label('demoHelp'))}</p>
            <label><input type="checkbox" data-initial-all ${count === this.entries.length && count ? 'checked' : ''} ${this.busy ? 'disabled' : ''}>${escapeHTML(label('all'))}</label>
            ${['notes', 'flows'].map(group => this.group(group)).join('')}
            <button type="button" class="settings-btn settings-btn--primary" data-initial-restore ${this.busy || !count ? 'disabled' : ''}>${escapeHTML(label(this.busy ? 'restoring' : 'restore'))} (${count})</button>
            <button type="button" class="settings-btn settings-btn--secondary" data-initial-refresh ${this.busy ? 'disabled' : ''}>${escapeHTML(label('refresh'))}</button>
            <p role="alert">${escapeHTML(this.error)}</p><ul role="status">${this.results.map(result => `<li>${escapeHTML(this.entries.find(entry => entry.id === result.id)?.name ?? result.id)} — ${escapeHTML(label(result.status))}${result.error ? ': ' + escapeHTML(result.error) : ''}</li>`).join('')}</ul></section>`;
        const all = this.container.querySelector<HTMLInputElement>('[data-initial-all]')!; all.indeterminate = count > 0 && count < this.entries.length;
        this.container.onchange = event => this.change(event);
        this.container.onclick = event => { const element = event.target as HTMLElement;
            if (element.closest('[data-initial-restore]')) void this.restore();
            if (element.closest('[data-initial-refresh]')) { this.error = ''; void this.refresh(); }
        };
        this.container.querySelectorAll<HTMLDetailsElement>('details[data-group]').forEach(detail => {
            detail.ontoggle = () => { if (detail.isConnected) detail.open ? this.expanded.add(detail.dataset.group!) : this.expanded.delete(detail.dataset.group!); };
        });
    }
    private group(group: string): string {
        const entries = this.entries.filter(entry => entry.group === group); if (!entries.length) return '';
        const count = entries.filter(entry => this.selected?.has(entry.id)).length;
        return `<details data-group="${group}" ${this.expanded.has(group) ? 'open' : ''}><summary>${escapeHTML(label(group))} (${count}/${entries.length})</summary>
            ${entries.map(entry => `<label class="initial-files__entry"><input type="checkbox" data-initial-id="${escapeAttr(entry.id)}" ${this.selected?.has(entry.id) ? 'checked' : ''} ${this.busy ? 'disabled' : ''}>
                <span>${escapeHTML(entry.name)} — ${escapeHTML(label(entry.exists ? 'exists' : 'missing'))}<code>${escapeHTML(entry.path)}</code></span></label>`).join('')}</details>`;
    }
    private change(event: Event): void {
        if (this.busy) return; const input = event.target as HTMLInputElement;
        if (input.hasAttribute('data-initial-all')) this.selected = new Set(input.checked ? this.entries.map(entry => entry.id) : []);
        else if (input.dataset.initialId) input.checked ? this.selected?.add(input.dataset.initialId) : this.selected?.delete(input.dataset.initialId);
        this.rememberExpansion(); this.render();
    }
    private rememberExpansion(): void {
        this.container?.querySelectorAll<HTMLDetailsElement>('details[data-group]').forEach(detail => {
            detail.open ? this.expanded.add(detail.dataset.group!) : this.expanded.delete(detail.dataset.group!);
        });
    }
    private async restore(): Promise<void> {
        if (this.busy) return; const ids = this.entries.filter(entry => this.selected?.has(entry.id)).map(entry => entry.id); if (!ids.length) return;
        this.rememberExpansion(); this.busy = true; this.error = ''; this.results = []; this.render();
        try { this.results = await this.port.restore(ids); await this.changed(); }
        catch (error) { this.error = String(error); }
        finally { this.busy = false; await this.refresh(); }
    }
}
