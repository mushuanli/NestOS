import { ENTITY_ICONS, escapeHTML, t } from '@itookit/common';
import type { DigitalTwinService, TwinMemoryData, TwinSourceSpec, TwinScanRuleInput } from '@itookit/app-core';
import { createWorkspaceModule } from '../workspaces/module';
import { TWIN_PAGES, label, overview, memories, type TwinSnapshot, type TwinPage } from './view';
import { scanPage, type TwinSourcesTab } from './scan-view';

export interface TwinWorkbenchOptions {
    service: DigitalTwinService; sidebar: HTMLElement; editor: HTMLElement;
    connections(): Promise<Array<{ id: string; name: string }>>;
    agents?(): Promise<Array<{ id: string; name: string }>>;
    selected(path: string): void;
}
export class TwinWorkbench {
    private page: TwinPage = 'overview';
    private selectedSession = '';
    private sourcesTab: TwinSourcesTab = 'plans';
    private agents: Array<{ id: string; name: string }> = [];
    private snapshot?: TwinSnapshot;
    private connections: Array<{ id: string; name: string }> = [];
    private abort = new AbortController();
    private unsubscribe?: () => void;
    private generation = 0;
    private busy = false;
    private error = '';
    private message = '';
    constructor(private readonly options: TwinWorkbenchOptions) {}

    async start(): Promise<void> {
        const { sidebar, editor } = this.options, signal = this.abort.signal;
        sidebar.classList.add('twin__sidebar'); editor.classList.add('twin');
        sidebar.innerHTML = `<h2>${ENTITY_ICONS.agent} ${escapeHTML(t('twin.title'))}</h2>${TWIN_PAGES.map(page => `<button type="button" data-page="${page}">${escapeHTML(label(page))}</button>`).join('')}`;
        sidebar.addEventListener('click', event => {
            const page = (event.target as HTMLElement).closest<HTMLElement>('[data-page]')?.dataset.page;
            if (page) void this.openResource('/' + page);
        }, { signal });
        editor.addEventListener('click', event => { void this.click(event); }, { signal });
        editor.addEventListener('submit', event => { event.preventDefault(); void this.submit(event); }, { signal });
        editor.addEventListener('input', event => this.search(event), { signal });
        this.unsubscribe = this.options.service.onChange(() => { if (!this.busy) void this.refresh(); });
        await this.refresh();
    }
    async openResource(path: string): Promise<void> {
        const page = path.split('/')[1] as TwinPage;
        this.page = TWIN_PAGES.includes(page) ? page : 'overview';
        this.selectedSession = path.split('/')[2] ? decodeURIComponent(path.split('/')[2]) : '';
        this.sourcesTab = ['plans', 'runs', 'sources'].includes(this.selectedSession) ? this.selectedSession as TwinSourcesTab : 'plans';
        this.options.selected(this.getActiveResourceId()); await this.refresh();
    }
    getActiveResourceId(): string { return '/' + this.page + (this.selectedSession ? '/' + encodeURIComponent(this.selectedSession) : ''); }
    async destroy(): Promise<void> { this.generation++; this.abort.abort(); this.unsubscribe?.(); }

    private async refresh(): Promise<void> {
        const generation = ++this.generation;
        try {
            const [snapshot, connections, agents] = await Promise.all([this.options.service.snapshot(), this.options.connections(), this.options.agents?.() ?? Promise.resolve([])]);
            if (generation !== this.generation || this.abort.signal.aborted) return;
            this.snapshot = snapshot; this.connections = connections; this.agents = agents; this.error = ''; this.render();
        } catch (error) {
            if (generation !== this.generation || this.abort.signal.aborted) return;
            console.error('[DigitalTwin] Failed to load overview data', error);
            this.error = label('loadError') + errorDetail(error); this.render();
        }
    }
    private render(): void {
        if (this.abort.signal.aborted) return;
        const snapshot = this.snapshot;
        this.options.sidebar.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => {
            button.setAttribute('aria-current', String(button.dataset.page === this.page));
        });
        const body = !snapshot ? '' : this.page === 'overview' ? overview(snapshot, this.connections, this.selectedSession, this.agents)
            : this.page === 'sources' ? scanPage(snapshot, this.connections, this.sourcesTab) : memories(snapshot, this.page);
        this.options.editor.innerHTML = `<div class="twin__body"><h2>${escapeHTML(label(this.page))}</h2>
            <p class="twin__status" role="status">${escapeHTML(this.busy ? label('busy') : this.message)}</p>
            <p class="twin__error" role="alert">${escapeHTML(this.error)}</p>${this.error ? `<button type="button" data-action="refresh">${escapeHTML(label('refresh'))}</button>` : ''}${body}</div>`;
        this.options.editor.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = this.busy; });
    }
    private async act(action: () => Promise<unknown>, refreshFailure = false): Promise<void> {
        if (this.busy) return;
        this.generation++;
        this.busy = true; this.error = ''; this.message = '';
        this.options.editor.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
        try { await action(); this.busy = false; await this.refresh(); }
        catch (error) {
            this.busy = false; this.error = errorText(error);
            if (this.abort.signal.aborted) return;
            if (refreshFailure) await this.refreshDraft();
            this.options.editor.querySelector<HTMLElement>('[role=alert]')!.textContent = this.error;
            this.options.editor.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; });
            const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.action = 'refresh'; retry.textContent = label('refresh');
            if (!this.options.editor.querySelector('[data-action=refresh]')) this.options.editor.querySelector('[role=alert]')!.after(retry);
        }
    }
    private async click(event: Event): Promise<void> {
        const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
        if (!target || this.busy) return;
        const { action = '', id = '' } = target.dataset;
        if (action === 'refresh') return this.refreshDraft();
        if (!this.snapshot) return;
        if (action === 'scanTab') return this.openResource('/sources/' + id);
        if (action === 'previewRule') return this.previewRule(target.closest('form')!);
        if (action === 'previewSource') return this.preview(target.closest('form')!);
        if (action === 'analyze') { void this.analyze(id); return; }
        const commands: Record<string, () => Promise<unknown>> = {
            cancelJob: () => this.options.service.cancelAnalysis(id), revokeGrant: () => this.revokeGrant(id),
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
    private async scanPlanCommand(action: string, id: string): Promise<void> {
        const plan = this.snapshot!.scans.plans.find(item => item.id === id)!;
        if (action === 'removeScanPlan') {
            if (window.confirm(label('removeScanPlanConfirm'))) await this.options.service.removeScanPlan(id, plan.revision);
        } else {
            if (action === 'enableScanPlan' && !plan.data.rules && !window.confirm(label('scanConsent'))) return;
            await this.options.service.setScanPlanEnabled(id, plan.revision, action === 'enableScanPlan');
        }
    }
    private async revokeGrant(id: string): Promise<void> {
        const grant = this.snapshot!.grants.find(item => item.id === id)!;
        await this.options.service.grant({ ...grant.data, enabled: false }, grant.revision);
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
        const drafts = [...this.options.editor.querySelectorAll<HTMLFormElement>('form')].map(form => ({
            key: `${form.dataset.form}:${form.dataset.id ?? ''}`, values: [...new FormData(form).entries()] }));
        await this.refresh();
        for (const form of this.options.editor.querySelectorAll<HTMLFormElement>('form')) {
            const draft = drafts.find(item => item.key === `${form.dataset.form}:${form.dataset.id ?? ''}`);
            if (!draft) continue;
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
        const service = this.options.service, kind = form.dataset.form ?? '';
        const handlers: Record<string, () => Promise<unknown>> = {
            source: () => service.addSource(sourceSpec(data), field(data, 'connectionId')),
            grant: () => this.saveGrant(data),
            settings: () => service.configure({ tokenLimit: Number(data.get('tokenLimit')), paused: data.get('paused') === 'on',
                useEnabled: data.get('useEnabled') === 'on', ...(field(data, 'connectionId') ? { connectionId: field(data, 'connectionId') } : {}),
                globalExclude: lines(data, 'globalExclude') }, snapshot.settings.revision),
            memory: () => service.addMemory(memoryInput(data)),
            scanPlan: () => this.saveScanPlan(form, data),
            execution: () => this.saveMemory(form, data), correct: () => this.saveMemory(form, data),
        };
        await this.act(async () => {
            if (['source', 'grant'].includes(kind) && data.get('consent') !== 'on') throw new Error('TWIN_CONSENT_REQUIRED');
            await handlers[kind]?.();
        });
    }
    private saveScanPlan(form: HTMLFormElement, data: FormData) {
        const plan = this.snapshot!.scans.plans.find(item => item.id === form.dataset.id);
        const input: TwinScanRuleInput = { name: field(data, 'name'), include: lines(data, 'include'), exclude: lines(data, 'exclude'),
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
            if (preview.errors.length) form.querySelector('[data-preview]')!.textContent += '\n' + label('scanIncomplete') + ': ' + preview.errors.join(', ');
        } catch (error) { this.error = errorText(error); this.options.editor.querySelector('[role=alert]')!.textContent = this.error; }
    }
    private async saveGrant(data: FormData): Promise<void> {
        const sessionId = field(data, 'sessionId'), current = this.snapshot!.grants.find(grant => grant.id === sessionId);
        await this.options.service.grant({ sessionId, agentId: field(data, 'agentId'), connectionId: field(data, 'connectionId'),
            project: field(data, 'project'), enabled: true }, current?.revision ?? null);
    }
    private async saveMemory(form: HTMLFormElement, data: FormData): Promise<void> {
        const memory = this.snapshot!.memories.find(item => item.id === form.dataset.id)!;
        if (form.dataset.form === 'execution') return this.options.service.linkExecution(memory.id, memory.revision,
            { sessionId: field(data, 'executionSessionId'), taskId: field(data, 'executionTaskId') });
        await this.options.service.review(memory.id, memory.revision, 'correct', memoryInput(data));
    }
    private search(event: Event): void {
        const input = event.target as HTMLInputElement;
        if (!input.matches('[data-search]')) return;
        const query = input.value.trim().toLowerCase();
        this.options.editor.querySelectorAll<HTMLElement>('[data-search-text]').forEach(card => { card.hidden = !card.dataset.searchText?.includes(query); });
    }
}
const lines = (data: FormData, key: string) => String(data.get(key) ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
function sourceSpec(data: FormData): TwinSourceSpec {
    const kind = field(data, 'kind') as TwinSourceSpec['kind'];
    return { kind, target: kind === 'session' ? field(data, 'sessionTarget') : field(data, 'target'), label: field(data, 'label') };
}
function memoryInput(data: FormData): Partial<TwinMemoryData> {
    return { content: field(data, 'content'), kind: field(data, 'kind') as TwinMemoryData['kind'], subject: field(data, 'subject'),
        project: field(data, 'project'), eventTime: field(data, 'eventTime'), goalStatus: field(data, 'goalStatus') as TwinMemoryData['goalStatus'],
        successCondition: field(data, 'successCondition'), deadline: field(data, 'deadline') };
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
