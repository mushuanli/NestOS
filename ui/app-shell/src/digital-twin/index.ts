import { memoryInput } from './memory-input';
import { loadOverview } from './load-overview';
import { graphView } from './graph-view';
import { escapeHTML, t } from '@itookit/common';
import type { TwinSourceSpec } from '@itookit/app-contracts';
import type { DigitalTwinService, TwinScanRuleInput } from '@itookit/app-contracts/services';
import { createWorkspaceModule } from '../workspaces/module';
import { TWIN_PAGES, label, overview, memories, type TwinSnapshot, type TwinPage } from './view';
import { scanPage, type TwinSourcesTab } from './scan-view';
import { TwinSettingsAutosave } from './settings-autosave';
import { TwinNavigation } from './navigation';
import { TwinScanLists } from './scan-list';

export interface TwinWorkbenchOptions {
    service: DigitalTwinService; sidebar: HTMLElement; editor: HTMLElement;
    connections(): Promise<Array<{ id: string; name: string }>>;
    selected(path: string): void;
}
export class TwinWorkbench {
    private page: TwinPage = 'overview';
    private selectedSession = '';
    private sourcesTab: TwinSourcesTab = 'plans';
    private snapshot?: TwinSnapshot;
    private connections: Array<{ id: string; name: string }> = [];
    private abort = new AbortController();
    private unsubscribe?: () => void;
    private generation = 0;
    private busy = false;
    private loading = false;
    private refreshQueued = false;
    private dirty = false;
    private error = '';
    private message = '';
    private readonly autosave: TwinSettingsAutosave;
    private readonly navigation: TwinNavigation;
    private readonly scanLists = new TwinScanLists();
    constructor(private readonly options: TwinWorkbenchOptions) {
        this.autosave = new TwinSettingsAutosave(options.service, () => this.renderSaveState());
        this.navigation = new TwinNavigation(options.sidebar, path => this.openResource(path), error => {
            if (this.abort.signal.aborted) return;
            this.error = label('loadError') + errorDetail(error); this.render();
        });
    }

    async start(): Promise<void> {
        const { editor } = this.options, signal = this.abort.signal;
        editor.classList.add('twin');
        editor.addEventListener('click', event => { void this.click(event); }, { signal });
        editor.addEventListener('keydown', event => this.scanTabKey(event), { signal });
        editor.addEventListener('submit', event => { event.preventDefault(); void this.submit(event); }, { signal });
        editor.addEventListener('input', event => this.search(event), { signal });
        editor.addEventListener('change', event => { if (!this.scanLists.handle(event)) this.settingsChanged(event, true); }, { signal });
        this.unsubscribe = this.options.service.onChange(() => this.serviceChanged());
        await Promise.all([this.navigation.start(), this.refresh()]);
        await this.navigation.sync('/' + this.page);
    }
    async openResource(path: string): Promise<void> {
        await this.autosave.flush();
        if (this.abort.signal.aborted) return;
        if (this.autosave.pending) { await this.navigation.sync('/' + this.page); return; }
        this.dirty = false;
        const page = path.split('/')[1] as TwinPage;
        this.page = TWIN_PAGES.includes(page) ? page : 'overview';
        this.selectedSession = path.split('/')[2] ? decodeURIComponent(path.split('/')[2]) : '';
        this.sourcesTab = ['plans', 'runs', 'sources'].includes(this.selectedSession) ? this.selectedSession as TwinSourcesTab : 'plans';
        this.options.selected(this.getActiveResourceId()); await this.refresh();
        await this.navigation.sync('/' + this.page);
    }
    getActiveResourceId(): string { return '/' + this.page + (this.selectedSession ? '/' + encodeURIComponent(this.selectedSession) : ''); }
    async destroy(): Promise<void> {
        await this.autosave.flush();
        if (this.autosave.pending) throw new Error(this.autosave.error || 'TWIN_SETTINGS_UNSAVED');
        this.generation++; this.abort.abort(); this.unsubscribe?.(); this.navigation.destroy();
    }

    private serviceChanged(): void {
        if (this.busy || this.dirty || this.error || this.autosave.pending
            || this.options.editor.querySelector('[data-scan-filter]:focus')
            || this.options.editor.querySelector('[data-form=settings]')?.contains(document.activeElement)) return;
        if (this.loading) { this.refreshQueued = true; return; }
        void this.refreshDraft();
    }
    private async refresh(): Promise<void> {
        const generation = ++this.generation;
        this.loading = true; this.refreshQueued = false;
        if (!this.snapshot) this.render();
        try {
            const [snapshot, connections] = await loadOverview(this.options, this.abort.signal);
            if (generation !== this.generation || this.abort.signal.aborted) return;
            this.snapshot = snapshot; this.connections = connections; this.error = ''; this.loading = false; this.render();
            if (this.refreshQueued && !this.dirty) void this.refreshDraft();
        } catch (error) {
            if (generation !== this.generation || this.abort.signal.aborted) return;
            console.error('[DigitalTwin] Failed to load overview data', error);
            this.loading = false;
            this.error = error instanceof Error && error.message === 'TWIN_LOAD_TIMEOUT' ? label('loadTimeout') : label('loadError') + errorDetail(error); this.render();
        }
    }
    private render(): void {
        if (this.abort.signal.aborted) return;
        const previousSettings = this.options.editor.querySelector<HTMLDetailsElement>('[data-scan-settings]');
        const snapshot = this.snapshot;
        const body = !snapshot ? '' : this.page === 'overview' ? overview(snapshot)
            : this.page === 'profile' ? graphView(snapshot, this.selectedSession) : this.page === 'sources' ? scanPage(snapshot, this.connections, this.sourcesTab) : memories(snapshot, this.page);
        this.options.editor.innerHTML = `<div class="twin__body"><h2>${escapeHTML(label(this.page))}</h2>
            <p class="twin__status" role="status">${escapeHTML(this.loading ? t('status.loading') : this.busy ? label('busy') : this.message)}</p>
            <p class="twin__error" role="alert">${escapeHTML(this.error)}</p>${this.error ? `<button type="button" data-action="refresh">${escapeHTML(label('refresh'))}</button>` : ''}${body}</div>`;
        this.options.editor.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = this.busy; });
        const settings = this.options.editor.querySelector<HTMLDetailsElement>('[data-scan-settings]');
        if (settings && previousSettings && previousSettings.dataset.configured === settings.dataset.configured) settings.open = previousSettings.open;
        this.scanLists.restore(this.options.editor);
        this.renderSaveState();
        if (this.page === 'memories' && this.selectedSession) {
            const card = [...this.options.editor.querySelectorAll<HTMLElement>('[data-memory]')].find(item => item.dataset.memory === this.selectedSession);
            card?.scrollIntoView?.({ block: 'center' });
            card?.querySelector<HTMLFormElement>('form[data-form=correct]')?.closest('details')?.setAttribute('open', '');
        }
    }
    private async act(action: () => Promise<unknown>, refreshFailure = false): Promise<void> {
        if (this.busy) return;
        if (this.autosave.pending) await this.autosave.flush();
        if (this.autosave.pending) return;
        this.generation++;
        this.busy = true; this.error = ''; this.message = '';
        this.options.editor.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
        try { await action(); this.busy = false; this.dirty = false; await this.refresh(); }
        catch (error) {
            this.busy = false; this.error = errorText(error);
            if (this.abort.signal.aborted) return;
            if (refreshFailure) await this.refreshDraft();
            this.options.editor.querySelector<HTMLElement>('[role=alert]')!.textContent = this.error;
            this.options.editor.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; });
            this.scanLists.restore(this.options.editor);
            const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.action = 'refresh'; retry.textContent = label('refresh');
            if (!this.options.editor.querySelector('[data-action=refresh]')) this.options.editor.querySelector('[role=alert]')!.after(retry);
        }
    }
    private async click(event: Event): Promise<void> {
        if (this.scanLists.handle(event)) return;
        const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
        if (!target || this.busy) return;
        const { action = '', id = '' } = target.dataset;
        if (action === 'retrySettings') return this.autosave.flush();
        if (action === 'refresh') return this.refreshDraft();
        if (!this.snapshot) return;
        if (action === 'openEntity') { event.preventDefault(); return this.openResource('/profile/' + id); }
        if (action === 'openMemories') return this.openResource('/memories/' + id);
        if (action === 'openUpdates') return this.openResource('/sources');
        if (action === 'openProfile') return this.openResource('/profile');
        if (action === 'scanTab') return this.switchScanTab(id as TwinSourcesTab);
        if (action === 'previewRule') return this.previewRule(target.closest('form')!);
        if (action === 'previewSource') return this.preview(target.closest('form')!);
        if (action === 'analyze') { void this.analyze(id); return; }
        const commands: Record<string, () => Promise<unknown>> = {
            cancelJob: () => this.options.service.cancelAnalysis(id),
            runScanPlan: () => this.options.service.runScanPlan(id), cancelScanRun: () => this.options.service.cancelScanRun(id),
            pauseScanPlan: () => this.scanPlanCommand(action, id), enableScanPlan: () => this.scanPlanCommand(action, id),
            removeScanPlan: () => this.scanPlanCommand(action, id),
            revokeSource: () => this.sourceCommand(action, id), enableSource: () => this.sourceCommand(action, id),
            removeSource: () => this.sourceCommand(action, id),
            confirm: () => this.memoryCommand(action, id), reject: () => this.memoryCommand(action, id),
            dispute: () => this.memoryCommand(action, id), suppress: () => this.memoryCommand(action, id), forget: () => this.forget(id),
            forgetSubject: () => this.forgetScope({ subjectId: id }), forgetProject: () => this.forgetScope({ project: id }),
        };
        if (commands[action]) await this.act(commands[action], ['forget', 'forgetSubject', 'forgetProject', 'removeSource', 'suppress', 'removeScanPlan'].includes(action));
    }
    private async switchScanTab(tab: TwinSourcesTab): Promise<void> {
        await this.autosave.flush();
        if (this.autosave.pending || this.abort.signal.aborted || this.page !== 'sources') return;
        this.sourcesTab = tab; this.selectedSession = tab;
        const root = this.options.editor;
        root.querySelectorAll<HTMLButtonElement>('[data-action="scanTab"]').forEach(button => {
            button.setAttribute('aria-selected', String(button.dataset.id === tab));
            button.tabIndex = button.dataset.id === tab ? 0 : -1;
        });
        root.querySelectorAll<HTMLElement>('.twin__scan-panel').forEach(panel => { panel.hidden = panel.id !== 'twin-scan-panel-' + tab; });
        this.options.selected(this.getActiveResourceId());
    }
    private scanTabKey(event: KeyboardEvent): void {
        if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-action="scanTab"]')) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...this.options.editor.querySelectorAll<HTMLButtonElement>('[data-action="scanTab"]')];
        const current = tabs.indexOf(event.target as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); tabs[index]?.focus(); tabs[index]?.click();
    }
    private async scanPlanCommand(action: string, id: string): Promise<void> {
        const plan = this.snapshot!.scans.plans.find(item => item.id === id)!;
        if (action === 'removeScanPlan') {
            if (window.confirm(label('removeScanPlanConfirm'))) await this.options.service.removeScanPlan(id, plan.revision);
        } else {
            if (action === 'enableScanPlan' && !plan.data.rules && !window.confirm(label('scanConsent'))) return;
            await this.options.service.setScanPlanEnabled(id, plan.revision, action === 'enableScanPlan');
        }
    }

    private async sourceCommand(action: string, id: string): Promise<void> {
        const source = this.snapshot!.sources.find(item => item.id === id)!;
        if (action !== 'removeSource') return this.options.service.setSourceEnabled(id, source.revision, action === 'enableSource');
        if (!window.confirm(label('removeSourceConfirm'))) return;
        await this.options.service.removeSource(id, source.revision); this.message = label('sourceRemoved');
    }
    private async memoryCommand(action: string, id: string): Promise<void> {
        const memory = this.snapshot!.memories.find(item => item.id === id)!;
        if (action !== 'suppress') return this.options.service.review(id, memory.revision, action as 'confirm' | 'reject' | 'dispute');
        if (!window.confirm(label('suppressConfirm'))) return;
        await this.options.service.suppress(id, memory.revision); this.message = label('suppressed');
    }
    private async refreshDraft(): Promise<void> {
        const resource = this.getActiveResourceId();
        const drafts = [...this.options.editor.querySelectorAll<HTMLFormElement>('form')].map(form => ({
            key: `${form.dataset.form}:${form.dataset.id ?? ''}`, open: form.closest('details')?.open, values: [...new FormData(form).entries()] }));
        await this.refresh();
        if (resource !== this.getActiveResourceId()) return;
        for (const form of this.options.editor.querySelectorAll<HTMLFormElement>('form')) {
            const draft = drafts.find(item => item.key === `${form.dataset.form}:${form.dataset.id ?? ''}`);
            if (!draft) continue;
            if (draft.open && form.dataset.form !== 'settings') form.closest('details')?.setAttribute('open', '');
            for (const control of form.elements) {
                if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) continue;
                const values = draft.values.filter(([name]) => name === control.name).map(([, value]) => String(value));
                if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = values.includes(control.value);
                else if (values.length) control.value = values[0];
            }
        }
    }
    private async analyze(id: string): Promise<void> {
        // Keep controls available while a model call is in flight so users can cancel or revoke it.
        try { await this.options.service.analyze(id); }
        catch (error) { this.error = errorText(error); }
        await this.refresh();
    }
    private async forget(id: string): Promise<void> {
        const sessions = await this.options.service.forgetPreview(id);
        if (!window.confirm(label('forgetConfirm'))) return;
        const deleteSessions = sessions.length && window.confirm(label('deleteSessionsConfirm') + '\n' + sessions.join('\n')) ? sessions : [];
        const result = await this.options.service.forget(id, deleteSessions);
        this.message = result.retainedSessions.length ? label('forgottenWithCopies') : label('forgotten');
    }
    private async forgetScope(scope: { subjectId?: string; project?: string }): Promise<void> {
        const preview = await this.options.service.forgetScopePreview(scope);
        if (!window.confirm(label('forgetScopeConfirm') + ' (' + preview.ids.length + ')')) return;
        const sessions = preview.sessions.length && window.confirm(label('deleteSessionsConfirm') + '\n' + preview.sessions.join('\n')) ? preview.sessions : [];
        const result = await this.options.service.forgetScope(scope, sessions);
        this.message = result.retainedSessions.length ? label('forgottenWithCopies') : label('forgotten');
    }
    private async preview(form: HTMLFormElement): Promise<void> {
        try {
            const content = await this.options.service.previewSource(sourceSpec(new FormData(form)));
            if (this.abort.signal.aborted || !form.isConnected) return;
            const preview = form.querySelector<HTMLElement>('[data-preview]')!;
            preview.textContent = content.text.slice(0, 4000) + (content.text.length > 4000 ? '\n' + label('previewTruncated') : '');
        } catch (error) {
            this.error = errorText(error);
            const alert = this.options.editor.querySelector<HTMLElement>('[role=alert]');
            if (alert && !this.abort.signal.aborted) alert.textContent = this.error;
        }
    }
    private async submit(event: Event): Promise<void> {
        const form = event.target as HTMLFormElement, data = new FormData(form), snapshot = this.snapshot;
        if (!snapshot) return;
        if (form.dataset.form === 'settings') { await this.autosave.flush(); return; }
        const service = this.options.service, kind = form.dataset.form ?? '';
        const handlers: Record<string, () => Promise<unknown>> = {
            mergePeople: () => service.mergePeople(form.dataset.id!, field(data, 'mergeTarget')),
            source: () => service.addSource(sourceSpec(data), field(data, 'connectionId')),
            memory: () => service.addMemory(memoryInput(data)),
            scanPlan: () => this.saveScanPlan(form, data),
            execution: () => this.saveMemory(form, data), correct: () => this.saveMemory(form, data),
        };
        await this.act(async () => {
            if (kind === 'source' && data.get('consent') !== 'on') throw new Error('TWIN_CONSENT_REQUIRED');
            await handlers[kind]?.();
        });
    }
    private saveScanPlan(form: HTMLFormElement, data: FormData) {
        const plan = this.snapshot!.scans.plans.find(item => item.id === form.dataset.id);
        const input: TwinScanRuleInput = { name: field(data, 'name'), focus: field(data, 'focus'), include: lines(data, 'include'), exclude: lines(data, 'exclude'),
            kinds: data.getAll('kinds').map(String) as TwinScanRuleInput['kinds'],
            intervalMinutes: Number(data.get('intervalMinutes')), enabled: data.get('enabled') === 'on' };
        return this.options.service.saveScanRule(plan?.id ?? null, plan?.revision ?? null, input);
    }
    private async previewRule(form: HTMLFormElement): Promise<void> {
        try {
            const data = new FormData(form), preview = await this.options.service.previewScanRule({ include: lines(data, 'include'), exclude: lines(data, 'exclude') });
            if (!form.isConnected || this.abort.signal.aborted) return;
            form.querySelector('[data-preview]')!.textContent = preview.resources.map(resource =>
                `${resource.projectName ? resource.projectName + ' (' + resource.projectId + ')' : resource.projectId} · ${resource.kind} · ${resource.path ?? resource.sessionId ?? resource.target}`).join('\n') || label('noMatches');
            form.querySelector('[data-preview]')!.textContent += '\n\n' + label('excludedSources') + '\n' + (preview.excluded.map(resource => `${resource.projectName ?? resource.projectId} · ${resource.path ?? resource.sessionId ?? resource.target}`).join('\n') || label('empty'));
            if (preview.errors.length) form.querySelector('[data-preview]')!.textContent += '\n' + label('scanIncomplete') + ': ' + preview.errors.join(', ');
        } catch (error) { this.error = errorText(error); this.options.editor.querySelector('[role=alert]')!.textContent = this.error; }
    }

    private async saveMemory(form: HTMLFormElement, data: FormData): Promise<void> {
        const memory = this.snapshot!.memories.find(item => item.id === form.dataset.id)!;
        if (form.dataset.form === 'execution') return this.options.service.linkExecution(memory.id, memory.revision,
            { sessionId: field(data, 'executionSessionId'), taskId: field(data, 'executionTaskId') });
        await this.options.service.review(memory.id, memory.revision, 'correct', memoryInput(data));
    }
    private search(event: Event): void {
        if (this.scanLists.handle(event)) return;
        const input = event.target as HTMLInputElement;
        if (input.closest('[data-form=settings]')) { this.settingsChanged(event, false); return; }
        if (!input.matches('[data-search]')) { if (input.closest('form')) this.dirty = true; return; }
        const query = input.value.trim().toLowerCase();
        this.options.editor.querySelectorAll<HTMLElement>('[data-search-text]').forEach(card => { card.hidden = !card.dataset.searchText?.includes(query); });
    }
    private settingsChanged(event: Event, immediate: boolean): void {
        const control = event.target;
        if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)
            || !control.closest('[data-form=settings]')) return;
        this.generation++; this.loading = false; this.refreshQueued = false;
        if (control.name === 'budgetUnlimited' && control instanceof HTMLInputElement) {
            const limit = this.options.editor.querySelector<HTMLElement>('[data-budget-limit]');
            if (limit) limit.hidden = control.checked;
            const amount = this.options.editor.querySelector<HTMLInputElement>('[name=tokenLimit]');
            if (amount) amount.disabled = control.checked;
        }
        this.autosave.edit(control, immediate || control instanceof HTMLSelectElement || control.type === 'checkbox');
    }
    private renderSaveState(): void {
        const status = this.options.editor.querySelector<HTMLElement>('[data-save-status]');
        if (!status) return;
        status.dataset.state = this.autosave.state;
        status.textContent = label(`autosave.${this.autosave.state}`);
        const error = this.options.editor.querySelector<HTMLElement>('[data-save-error]');
        if (error) error.textContent = this.autosave.error ? errorText(new Error(this.autosave.error)) : '';
        const retry = this.options.editor.querySelector<HTMLButtonElement>('[data-action=retrySettings]');
        if (retry) retry.hidden = this.autosave.state !== 'failed';
    }
}
const lines = (data: FormData, key: string) => String(data.get(key) ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
function sourceSpec(data: FormData): TwinSourceSpec {
    const kind = field(data, 'kind') as TwinSourceSpec['kind'];
    return { kind, target: kind === 'session' ? field(data, 'sessionTarget') : field(data, 'target'), label: field(data, 'label') };
}
function errorText(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    const specific = code === 'TWIN_CONNECTION_REQUIRED' ? 'connectionRequired' : code === 'TWIN_INVALID_SCAN_RULE' ? 'invalidScanRule' : 'operationError';
    return label(specific) + errorDetail(error);
}
function errorDetail(error: unknown): string {
    const code = error instanceof Error ? error.message : String(error);
    const known = /^TWIN_[A-Z_]+$|^Twin |^Unsupported Twin (?:schema|layout)$/.test(code);
    return known ? ' (' + code + ')' : '';
}
export function createTwinModule(options: TwinWorkbenchOptions) { return createWorkspaceModule(new TwinWorkbench(options)); }
