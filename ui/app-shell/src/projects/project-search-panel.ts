import { t } from '@itookit/common';
import type { ProjectSearchMatch, ProjectSearchQuery } from '@itookit/app-contracts/services';
import type { ProjectSearch } from '@itookit/app-contracts/services';

/** Search options and async results driven by the shared sidebar query. */
export class ProjectSearchPanel {
    readonly element = document.createElement('div');
    private query = '';
    private appliedQuery?: (query: string) => void;
    private readonly scope = document.createElement('select');
    private readonly archived = document.createElement('input');
    private readonly results = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly sources = document.createElement('div');
    private folder?: string;
    private request?: AbortController;
    private timer?: ReturnType<typeof setTimeout>;
    private revision = 0;
    constructor(private readonly search: ProjectSearch, private readonly open: (row: ProjectSearchMatch, query: string) => Promise<void>, private readonly sourceOpen?: (folder: string) => Promise<void>) {
        this.element.className = 'project-search';
        this.element.hidden = true;
        for (const value of ['loaded-tree', 'file-path', 'file-content', 'session-title', 'session-content'] as const) {
            const option = document.createElement('option'); option.value = value; option.textContent = t(`project.search.${value}`); this.scope.append(option);
        }
        this.scope.setAttribute('aria-label', t('project.search.scope'));
        const archived = document.createElement('label'); this.archived.type = 'checkbox'; archived.append(this.archived, document.createTextNode(t('project.search.archived')));
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('project.search.cancel'); cancel.onclick = () => this.cancel(true);
        this.status.setAttribute('role', 'status'); this.results.className = 'project-search__results';
        const controls = document.createElement('div'); controls.className = 'project-search__controls'; controls.append(this.scope, archived, cancel);
        this.element.append(controls, this.sources, this.status, this.results);
        this.scope.onchange = () => this.queue(); this.archived.onchange = () => this.queue();
        this.element.addEventListener('keydown', event => { if (event.key === 'Escape') this.appliedQuery?.(''); });
    }
    project(folder?: string) {
        if (this.folder === folder) return;
        this.folder = folder; this.cancel(); this.results.replaceChildren(); this.element.hidden = !folder || !this.query;
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
            const result = await this.search.search(folder, {query, scope: this.scope.value as ProjectSearchQuery['scope'], archived: this.archived.checked}, {signal: request.signal, timeoutMs: 20_000});
            if (request.signal.aborted || revision !== this.revision) return;
            this.status.textContent = t(result.truncated ? 'project.search.partial' : result.matches.length ? 'project.search.count' : 'project.search.empty', {count: result.matches.length});
            this.results.replaceChildren(...result.matches.map(row => this.row(row, query)));
        } catch (error) {
            const failure = error as {code?: string; remoteCode?: string};
            if (!request.signal.aborted && revision === this.revision) this.status.textContent = t([failure.code, failure.remoteCode].includes('ECAPABILITY') ? 'project.search.unsupported' : 'project.search.unavailable');
        }
    }
    private row(row: ProjectSearchMatch, query: string) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'project-search__result';
        const title = document.createElement('strong'); title.textContent = row.title + (row.line ? `:${row.line}` : '') + (row.profileId ? ` · ${row.profileId}` : '');
        const detail = document.createElement('span'); detail.textContent = row.summary; button.append(title, detail);
        button.onclick = () => { void this.open(row, query).catch(() => { this.status.textContent = t('project.search.navigateFailed'); }); }; return button;
    }
    cancel(show = false) { ++this.revision; this.request?.abort(); clearTimeout(this.timer); if (show) this.status.textContent = t('project.search.cancelled'); }
    destroy() { this.cancel(); this.element.remove(); }
}
