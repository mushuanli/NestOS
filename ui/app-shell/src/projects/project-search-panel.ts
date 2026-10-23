import { t, FILE_BROWSER_ICONS, ACTION_ICONS } from '@itookit/common';
import type { ProjectSearchMatch, ProjectSearchQuery } from '@itookit/app-contracts/services';
import { decorateButton } from '../workbench/controls';
import type { ProjectSearch } from '@itookit/app-contracts/services';

interface SearchPanelOptions {
    scopes?: readonly (ProjectSearchQuery['scope'] | 'loaded-tree')[];
    query?: Partial<Omit<ProjectSearchQuery, 'query' | 'scope'>>;
    hint?: string;
    sessions?: boolean;
    archived?: boolean;
    compact?: boolean;
    changed?(): void;
}

/** Search options and async results driven by the shared sidebar query. */
export class ProjectSearchPanel {
    readonly element = document.createElement('div');
    readonly controls = document.createElement('div');
    private query = '';
    private appliedQuery?: (query: string) => void;
    private readonly scope = document.createElement('select');
    private readonly scopeMenu = document.createElement('details');
    private readonly listeners = new AbortController();
    private readonly archived = document.createElement('input');
    private readonly results = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly sources = document.createElement('div');
    private folder?: string;
    private request?: AbortController;
    private timer?: ReturnType<typeof setTimeout>;
    private revision = 0;
    private agentId?: string;
    constructor(private readonly search: ProjectSearch, private readonly open: (row: ProjectSearchMatch, query: string) => Promise<void>, private readonly sourceOpen?: (folder: string) => Promise<void>, private readonly options: SearchPanelOptions = {}) {
        this.element.className = 'project-search';
        this.element.hidden = true;
        for (const value of options.scopes ?? ['loaded-tree', 'file-name', 'file-path', 'file-content', 'session-title', 'session-content', 'session-prompt'] as const) {
            const option = document.createElement('option'); option.value = value; option.textContent = t(`project.search.${value}`); this.scope.append(option);
        }
        this.scope.setAttribute('aria-label', t('project.search.scope'));
        const archived = document.createElement('label'); this.archived.type = 'checkbox'; archived.append(this.archived, document.createTextNode(t('project.search.archived')));
        const cancel = document.createElement('button'); cancel.type = 'button'; decorateButton(cancel, FILE_BROWSER_ICONS.close, t('project.search.clear'), true); cancel.dataset.action = 'clear-search';
        cancel.onclick = () => { this.cancel(); this.appliedQuery?.(''); };
        this.status.setAttribute('role', 'status'); this.results.className = 'project-search__results';
        const controls = this.controls; controls.className = 'project-search__controls';
        if (options.compact) controls.append(this.scopePicker()); else controls.append(this.scope);
        if (options.sessions !== false && options.archived !== false) controls.append(archived); controls.append(cancel);
        this.element.append(controls, this.sources, this.status, this.results);
        if (options.hint) { const hint = document.createElement('p'); hint.textContent = options.hint; controls.after(hint); }
        if (options.query?.archived) this.archived.checked = true;
        this.scope.onchange = () => { this.scopeMenu.open = false; this.queue(); options.changed?.(); };
        this.archived.onchange = () => { this.queue(); options.changed?.(); };
        this.element.addEventListener('keydown', event => { if (event.key === 'Escape') this.appliedQuery?.(''); });
    }
    filterChips(): import('../workbench/navigation-filters').NavigationFilterChip[] {
        const chips: import('../workbench/navigation-filters').NavigationFilterChip[] = [];
        if (this.scope.selectedIndex > 0) chips.push({label: this.scope.selectedOptions[0].textContent!, remove: () => {
            this.scope.selectedIndex = 0; this.queue(); this.options.changed?.();
        }});
        if (this.archived.checked) chips.push({label: t('project.search.archived'), remove: () => {
            this.archived.checked = false; this.queue(); this.options.changed?.();
        }});
        return chips;
    }
    private scopePicker(): HTMLElement {
        const menu = this.scopeMenu; menu.className = 'project-search__scope-menu';
        const summary = document.createElement('summary'); summary.innerHTML = ACTION_ICONS.search;
        summary.title = t('project.search.scope'); summary.setAttribute('aria-label', summary.title); summary.dataset.action = 'search-options';
        const popup = document.createElement('div'); popup.className = 'project-search__scope-options'; popup.append(this.scope);
        menu.append(summary, popup);
        document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) menu.open = false; }, {signal: this.listeners.signal});
        menu.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { menu.open = false; event.stopPropagation(); summary.focus(); } });
        return menu;
    }
    project(folder?: string) {
        if (this.folder === folder) return;
        this.folder = folder; this.cancel(); this.results.replaceChildren(); this.element.hidden = !folder || !this.query.trim();
        this.status.textContent = folder ? t('project.search.projectScope', {name: folder}) : ''; this.queue();
    }
    setQuery(query: string, apply?: (query: string) => void) {
        this.appliedQuery = apply;
        if (this.query === query) return;
        this.query = query; this.element.hidden = !this.folder || !query.trim(); this.queue();
    }
    sessionSources(rows: readonly {path: string; name: string; displayName?: string}[]) {
        this.sources.replaceChildren();
        for (const row of rows) {
            const button = document.createElement('button'); button.type = 'button';
            button.textContent = t('harness.attachedSessions', {name: row.displayName ?? row.name});
            button.onclick = () => { void this.sourceOpen?.(row.path).catch(() => { this.status.textContent = t('project.search.navigateFailed'); }); };
            this.sources.append(button);
        }
    }
    private queue() {
        this.cancel(); this.results.replaceChildren();
        if (!this.query.trim() || !this.folder || this.scope.value === 'loaded-tree') { this.status.textContent = ''; return; }
        this.timer = setTimeout(() => { void this.run(); }, 250);
    }
    private async run() {
        const request = this.request = new AbortController(), revision = ++this.revision, query = this.query;
        const folder = this.folder!; this.status.textContent = t('project.search.loading');
        try {
            const result = await this.search.search(folder, {...this.options.query, ...(this.agentId ? {agentId: this.agentId} : {}), query, scope: this.scope.value as ProjectSearchQuery['scope'], ...(this.options.sessions === false ? {} : {archived: this.options.archived === false ? !!this.options.query?.archived : this.archived.checked})}, {signal: request.signal, timeoutMs: 20_000});
            if (request.signal.aborted || revision !== this.revision) return;
            this.status.textContent = result.unavailableSources?.length ? t('project.search.sourcesUnavailable', {count: result.matches.length, sources: result.unavailableSources.join(', ')}) : t(result.truncated ? 'project.search.partial' : result.matches.length ? 'project.search.count' : 'project.search.empty', {count: result.matches.length});
            this.results.replaceChildren(...result.matches.map(row => this.row(row, query)));
        } catch (error) {
            const failure = error as {code?: string; remoteCode?: string};
            if (!request.signal.aborted && revision === this.revision) this.status.textContent = t([failure.code, failure.remoteCode].includes('ECAPABILITY') ? 'project.search.unsupported' : 'project.search.unavailable');
        }
    }
    private row(row: ProjectSearchMatch, query: string) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'project-search__result';
        const title = document.createElement('strong'); title.textContent = row.title + (row.line ? `:${row.line}` : '') + (row.profileId ? ` · ${row.profileId}` : row.kind === 'session' ? ' · MindOS' : '');
        const detail = document.createElement('span'); detail.textContent = row.summary; button.append(title, detail);
        button.onclick = () => { void this.open(row, query).catch(() => { this.status.textContent = t('project.search.navigateFailed'); }); }; return button;
    }
    refresh() { this.queue(); }
    setSessionFilter(agentId?: string) {this.agentId = agentId; this.queue();}
    cancel(show = false) { ++this.revision; this.request?.abort(); clearTimeout(this.timer); if (show) this.status.textContent = t('project.search.cancelled'); }
    destroy() { this.listeners.abort(); this.cancel(); this.controls.remove(); this.element.remove(); }
}
