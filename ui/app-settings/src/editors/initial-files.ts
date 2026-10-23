import {createModuleLogger, escapeHTML, escapeAttr, randomUUID, t, type LocaleKey} from '@itookit/common';

interface InitialDependencyIssue {code: string; field?: string; message: string}
interface InitialDependencyReport {
    flowId: string;
    name?: string;
    status: 'ready' | 'needsConfiguration' | 'missingTools' | 'failed';
    tools: Array<{id: string; version?: string; status: 'ready' | 'missing' | 'failed'; code?: string; reason?: string}>;
    parameters: InitialDependencyIssue[];
    connections: InitialDependencyIssue[];
    errors: InitialDependencyIssue[];
}

export interface InitialFilesPort {
    list(): Promise<Array<{ id: string; group: 'notes' | 'flows'; name: string; path: string; exists: boolean }>>;
    restore(ids: string[]): Promise<Array<{id: string; status: 'restored' | 'preserved' | 'failed'; error?: string; dependencies?: InitialDependencyReport}>>;
    prepareDependencies?(ids: string[]): Promise<InitialDependencyReport[]>;
}
interface InitialFilesControls {
    externalActions?: boolean;
    selectionChanged?: () => void;
    manageDependencies?: () => void;
}
const label = (key: string) => t(`initialFiles.${key}` as LocaleKey);
const log = createModuleLogger('initial-file-dependencies');

/** Recovery starts unselected and preserves explicit choices across list refreshes. */
export class InitialFilesSection {
    private container?: HTMLElement;
    private entries: Awaited<ReturnType<InitialFilesPort['list']>> = [];
    private results: Awaited<ReturnType<InitialFilesPort['restore']>> = [];
    private selected = new Set<string>();
    private expanded = new Set<string>();
    private busy = false;
    private disabled = false;
    private error = '';
    private generation = 0;
    constructor(private readonly port: InitialFilesPort, private readonly changed: () => Promise<unknown> = async () => {},
        private readonly controls: InitialFilesControls = {}) {}
    get selectedCount(): number { return this.entries.filter(entry => this.selected?.has(entry.id)).length; }
    setDisabled(disabled: boolean): void { this.rememberExpansion(); this.disabled = disabled; this.render(); }
    async mount(container: HTMLElement): Promise<void> { this.rememberExpansion(); this.unbind(); this.container = container; await this.refresh(); }
    destroy(): void { this.generation++; this.unbind(); this.container = undefined; }
    private unbind(): void { if (this.container) { this.container.onclick = null; this.container.onchange = null; } }
    async refresh(): Promise<void> {
        this.rememberExpansion(); this.error = '';
        const generation = ++this.generation;
        try {
            const entries = await this.port.list(); if (generation !== this.generation) return;
            this.entries = entries;
            this.selected = new Set(entries.filter(entry => this.selected.has(entry.id)).map(entry => entry.id));
        } catch (error) { if (generation === this.generation) this.error = String(error); }
        if (generation === this.generation) this.render();
    }
    private render(): void {
        if (!this.container) return;
        const count = this.selectedCount, disabled = this.busy || this.disabled;
        this.container.innerHTML = `<section class="settings-section initial-files"><h3>${escapeHTML(label('title'))}</h3>
            <p>${escapeHTML(label('help'))}</p><p>${escapeHTML(label('demoHelp'))}</p>
            ${['notes', 'flows'].map(group => this.group(group)).join('')}
            ${this.controls.externalActions ? '' : `<button type="button" class="settings-btn settings-btn--primary" data-initial-restore ${disabled || !count ? 'disabled' : ''}>${escapeHTML(label(this.busy ? 'restoring' : 'restore'))} (${count})</button>
            <button type="button" class="settings-btn settings-btn--secondary" data-initial-refresh ${disabled ? 'disabled' : ''}>${escapeHTML(label('refresh'))}</button>`}
            <p role="alert">${escapeHTML(this.error)}</p><ul class="initial-files__results" role="status">${this.results.map(result => this.resultRow(result, disabled)).join('')}</ul></section>`;
        this.container.querySelectorAll<HTMLInputElement>('[data-initial-group]').forEach(input => {
            const entries = this.entries.filter(entry => entry.group === input.dataset.initialGroup);
            const selected = entries.filter(entry => this.selected?.has(entry.id)).length;
            input.indeterminate = selected > 0 && selected < entries.length;
        });
        this.container.onchange = event => this.change(event);
        this.container.onclick = event => { const element = event.target as HTMLElement;
            if (element.closest('[data-initial-restore]')) void this.restore();
            if (element.closest('[data-initial-refresh]')) { this.error = ''; void this.refresh(); }
            const retry = element.closest<HTMLElement>('[data-initial-dependencies]');
            if (retry) void this.prepareDependencies(retry.dataset.initialDependencies!);
            if (element.closest('[data-initial-manage-dependencies]')) this.controls.manageDependencies?.();
        };
        this.container.querySelectorAll<HTMLDetailsElement>('details[data-group]').forEach(detail => {
            detail.ontoggle = () => { if (detail.isConnected) detail.open ? this.expanded.add(detail.dataset.group!) : this.expanded.delete(detail.dataset.group!); };
        });
        this.controls.selectionChanged?.();
    }
    private resultRow(result: Awaited<ReturnType<InitialFilesPort['restore']>>[number], disabled: boolean): string {
        const title = `${this.entries.find(entry => entry.id === result.id)?.name ?? result.id} — ${label(result.status)}`;
        return `<li data-initial-result="${escapeAttr(result.id)}"><strong>${escapeHTML(title)}</strong>${result.error ? `<p>${escapeHTML(result.error)}</p>` : ''}
            ${result.dependencies ? dependencyResult(result.dependencies, result.id, disabled, !!this.port.prepareDependencies, !!this.controls.manageDependencies) : ''}</li>`;
    }
    private group(group: string): string {
        const entries = this.entries.filter(entry => entry.group === group); if (!entries.length) return '';
        const count = entries.filter(entry => this.selected?.has(entry.id)).length;
        return `<details data-group="${group}" ${this.expanded.has(group) ? 'open' : ''}><summary>${escapeHTML(label(group))} (${count}/${entries.length})
            <label class="initial-files__select-all"><input type="checkbox" data-initial-group="${group}" ${count === entries.length ? 'checked' : ''} ${this.busy || this.disabled ? 'disabled' : ''}>${escapeHTML(label('all'))}</label></summary>
            ${entries.map(entry => `<label class="initial-files__entry"><input type="checkbox" data-initial-id="${escapeAttr(entry.id)}" ${this.selected?.has(entry.id) ? 'checked' : ''} ${this.busy || this.disabled ? 'disabled' : ''}>
                <span>${escapeHTML(entry.name)} — ${escapeHTML(label(entry.exists ? 'exists' : 'missing'))}<code>${escapeHTML(entry.path)}</code></span></label>`).join('')}</details>`;
    }
    private change(event: Event): void {
        if (this.busy || this.disabled) return; const input = event.target as HTMLInputElement;
        if (input.dataset.initialGroup) this.entries.filter(entry => entry.group === input.dataset.initialGroup).forEach(entry => {
            input.checked ? this.selected?.add(entry.id) : this.selected?.delete(entry.id);
        });
        else if (input.dataset.initialId) input.checked ? this.selected?.add(input.dataset.initialId) : this.selected?.delete(input.dataset.initialId);
        this.rememberExpansion(); this.render();
    }
    private rememberExpansion(): void {
        this.container?.querySelectorAll<HTMLDetailsElement>('details[data-group]').forEach(detail => {
            detail.open ? this.expanded.add(detail.dataset.group!) : this.expanded.delete(detail.dataset.group!);
        });
    }
    async restore(): Promise<boolean> {
        if (this.busy) return false; const ids = this.entries.filter(entry => this.selected?.has(entry.id)).map(entry => entry.id); if (!ids.length) return true;
        this.rememberExpansion(); this.busy = true; this.error = ''; this.results = []; this.render();
        try { this.results = await this.port.restore(ids); await this.changed(); }
        catch (error) { this.error = String(error); }
        finally { this.busy = false; const error = this.error; await this.refresh(); if (error) { this.error = error; this.render(); } }
        return !this.error && this.results.every(result => result.status !== 'failed' && (!result.dependencies || result.dependencies.status === 'ready'));
    }
    private async prepareDependencies(id: string): Promise<void> {
        if (this.busy || this.disabled || !this.port.prepareDependencies) return;
        const generation = this.generation, started = performance.now(), operationId = randomUUID();
        this.busy = true; this.error = ''; this.rememberExpansion(); this.render();
        log.info('flow.dependencies.prepare', {operationId, operation: 'flow.dependencies.prepare', stage: 'request', result: 'start'});
        try {
            const reports = await this.port.prepareDependencies([id]);
            if (!this.container || generation !== this.generation) return;
            const result = this.results.find(item => item.id === id), report = reports.find(item => item.flowId === result?.dependencies?.flowId) ?? reports[0];
            if (result && report) result.dependencies = report;
            await this.changed();
            log.info('flow.dependencies.prepare', {operationId, operation: 'flow.dependencies.prepare', stage: 'result', result: report?.status ?? 'failed', durationMs: Math.round(performance.now() - started)});
        } catch (error) {
            if (this.container && generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
            log.error('flow.dependencies.prepare.failed', {operationId, operation: 'flow.dependencies.prepare', stage: 'request', result: 'failure', errorType: error instanceof Error ? error.name : typeof error, durationMs: Math.round(performance.now() - started)});
        } finally {this.busy = false; if (this.container && generation === this.generation) this.render();}
    }
}

function dependencyResult(report: InitialDependencyReport, id: string, disabled: boolean, retry: boolean, manage: boolean): string {
    const tools = report.tools.filter(tool => tool.status !== 'ready').map(tool => `${tool.id}${tool.version ? '@' + tool.version : ''}${tool.reason ? ': ' + tool.reason : ''}`);
    return `<section class="initial-files__dependencies" data-dependencies-status="${report.status}"><p>${escapeHTML(t(`flow.dependencies.${report.status}` as LocaleKey))}</p>
        ${tools.length ? `<p>${escapeHTML(t('flow.dependencies.tools'))}</p><ul>${tools.map(tool => `<li>${escapeHTML(tool)}</li>`).join('')}</ul>` : ''}
        ${dependencyIssues('flow.dependencies.parameters', report.parameters)}${dependencyIssues('flow.dependencies.connections', report.connections)}
        ${dependencyIssues('flow.dependencies.failed', report.errors)}
        ${report.status !== 'ready' ? `<div class="initial-files__dependency-actions">${retry ? `<button type="button" class="settings-btn settings-btn--secondary" data-initial-dependencies="${escapeAttr(id)}" ${disabled ? 'disabled' : ''}>${escapeHTML(t('flow.dependencies.retry'))}</button>` : ''}
        ${manage ? `<button type="button" class="settings-btn settings-btn--secondary" data-initial-manage-dependencies ${disabled ? 'disabled' : ''}>${escapeHTML(t('flow.dependencies.manage'))}</button>` : ''}</div>` : ''}</section>`;
}

function dependencyIssues(title: LocaleKey, issues: InitialDependencyIssue[]): string {
    return issues.length ? `<p>${escapeHTML(t(title))}</p><ul>${issues.map(issue => `<li>${escapeHTML(`${issue.field ? issue.field + ': ' : ''}${issue.message}`)}</li>`).join('')}</ul>` : '';
}
