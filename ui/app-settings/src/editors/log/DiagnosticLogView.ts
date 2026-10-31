import {createModuleLogger, randomUUID, t} from '@itookit/common';
import type {ApplicationDiagnostics, DiagnosticEvent, DiagnosticQuery} from '@itookit/app-contracts/services';

const pageSize = 20;
const log = createModuleLogger('diagnostic-log-view');

/** The host query is scoped to its runtime; never read another process's global logger. */
export class DiagnosticLogView {
    private readonly status = document.createElement('p');
    private readonly list = document.createElement('ol');
    private readonly search = document.createElement('input');
    private readonly level = document.createElement('select');
    private readonly copy = document.createElement('button');
    private readonly pagination = document.createElement('nav');
    private readonly previous = document.createElement('button');
    private readonly next = document.createElement('button');
    private readonly pageInfo = document.createElement('span');
    private offset = 0;
    private displayedOffset = 0;
    private matchingGroups = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private stop?: () => void;
    private closed = false;
    private running?: Promise<void>;
    private dirty = false;
    private events: DiagnosticEvent[] = [];
    constructor(private readonly container: HTMLElement, private readonly diagnostics?: ApplicationDiagnostics,
        private readonly query: DiagnosticQuery = {}) {}
    async init(): Promise<void> {
        this.container.classList.add('diagnostic-log');
        const heading = document.createElement('h3'); heading.textContent = t('diagnostics.events');
        const controls = document.createElement('div'); controls.className = 'diagnostic-log__controls';
        this.search.type = 'search'; this.search.placeholder = t('diagnostics.search'); this.search.setAttribute('aria-label', this.search.placeholder);
        this.search.oninput = () => {this.offset = 0; void this.refresh();};
        for (const value of ['', 'error', 'warn', 'info'] as const) {
            const option = document.createElement('option'); option.value = value; option.textContent = t(value ? `diagnostics.level.${value}` : 'diagnostics.all'); this.level.append(option);
        }
        this.level.setAttribute('aria-label', t('diagnostics.level')); this.level.onchange = () => {this.offset = 0; void this.refresh();};
        const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = t('action.refresh'); refresh.onclick = () => {void this.refresh();};
        this.copy.type = 'button'; this.copy.textContent = t('diagnostics.copy');
        this.copy.onclick = () => {void this.copyEvents();};
        controls.append(this.search, this.level, refresh, this.copy);
        this.status.setAttribute('role', 'status'); this.list.className = 'diagnostic-log__events';
        this.setupPagination(); this.container.append(heading, controls, this.status, this.pagination, this.list);
        if (!this.diagnostics) {this.status.textContent = t('diagnostics.unavailable'); this.copy.disabled = true; this.pagination.hidden = true; return;}
        this.stop = this.diagnostics.onChange(() => {
            this.timer ??= setTimeout(() => {this.timer = undefined; void this.refresh();}, 100);
        });
        await this.refresh();
    }
    private setupPagination(): void {
        this.pagination.className = 'diagnostic-log__pagination'; this.pagination.setAttribute('aria-label', t('diagnostics.pagination'));
        this.previous.type = this.next.type = 'button';
        this.previous.textContent = t('diagnostics.previousPage'); this.next.textContent = t('diagnostics.nextPage');
        this.previous.onclick = () => {this.offset = Math.max(0, this.offset - pageSize); void this.refresh();};
        this.next.onclick = () => {this.offset += pageSize; void this.refresh();};
        this.pageInfo.setAttribute('role', 'status'); this.pagination.append(this.previous, this.pageInfo, this.next);
        this.updatePagination();
    }
    private updatePagination(): void {
        this.previous.disabled = this.offset === 0;
        this.next.disabled = this.offset + pageSize >= this.matchingGroups;
        this.pageInfo.textContent = t('diagnostics.pageInfo', {page: Math.floor(this.offset / pageSize) + 1,
            pages: Math.max(1, Math.ceil(this.matchingGroups / pageSize)), groups: this.matchingGroups, size: pageSize});
    }
    refresh(): Promise<void> {
        this.dirty = true;
        return this.running ??= this.read().finally(() => {this.running = undefined;});
    }
    private async read(): Promise<void> {
        while (this.dirty && !this.closed && this.diagnostics) {
            this.dirty = false;
            const operationId = randomUUID(), started = Date.now(), offset = this.offset; this.previous.disabled = this.next.disabled = true;
            try {
                const page = await this.diagnostics.query({...this.query, search: this.search.value,
                    level: this.level.value as DiagnosticQuery['level'] || undefined, limit: pageSize, offset});
                if (this.closed || this.dirty) continue;
                this.displayedOffset = this.offset = page.offset ?? this.offset; this.matchingGroups = page.matchingGroups ?? this.offset + page.events.length + Number(page.truncated);
                this.events = page.events; this.renderEvents();
                this.updatePagination();
                this.status.textContent = [t('diagnostics.groupRetention', {groups: page.retained, count: page.totalOccurrences ?? page.retained}), t(`diagnostics.persistence.${page.persistence}`),
                    page.persistenceError ? `${page.persistenceError.stage}: ${page.persistenceError.code}` : '', !page.events.length ? t('diagnostics.empty') : ''].filter(Boolean).join(' · ');
                log.debug('diagnostics.page', {operationId, stage: 'query', result: 'success', offset: this.offset, count: page.events.length, durationMs: Date.now() - started});
            } catch (error) {
                if (!this.closed && !this.dirty) {this.offset = this.displayedOffset; this.status.textContent = t('diagnostics.readFailed', {code: safeCode(error)}); this.updatePagination();}
                log.warn('diagnostics.page', {operationId, stage: 'query', result: 'failure', code: safeCode(error), offset, durationMs: Date.now() - started});
            }
        }
    }
    private renderEvents(): void {
        const expanded = new Set([...this.list.querySelectorAll<HTMLLIElement>('li[data-event-id]')].filter(row => row.querySelector('details')?.open).map(row => row.dataset.eventId));
        this.list.replaceChildren(); this.copy.disabled = !this.events.length;
        for (const event of this.events) {
            const row = document.createElement('li'); row.className = `diagnostic-log__event diagnostic-log__event--${event.level}`;
            row.dataset.eventId = event.id;
            const title = document.createElement('strong'); title.textContent = `${new Date(event.timestamp).toLocaleString()} · ${event.operation} · ${t(`diagnostics.result.${event.result}`)}`;
            const summary = document.createElement('p'); summary.textContent = [event.stage, [event.code, ...(event.causeCodes ?? [])].filter(Boolean).join(' → '),
                event.reason ? diagnosticReasonText(event.reason) : '', event.durationMs !== undefined ? `${event.durationMs} ms` : ''].filter(Boolean).join(' · ');
            const details = document.createElement('details'), label = document.createElement('summary'), data = document.createElement('pre');
            label.textContent = t('diagnostics.details'); data.textContent = JSON.stringify(event, null, 2); details.append(label, data);
            details.open = expanded.has(event.id);
            row.append(title, summary, this.seriesInfo(event), details); this.list.append(row);
        }
    }
    private seriesInfo(event: DiagnosticEvent): HTMLElement {
        const section = document.createElement('div'); section.className = 'diagnostic-log__series';
        const line = (label: string, value: string) => {const item = document.createElement('p'); item.textContent = `${label}：${value}`; section.append(item);};
        if (event.startedAt !== undefined) line(t('diagnostics.startedAt'), new Date(event.startedAt).toLocaleString());
        const series = event.series;
        if (!series || series.count === 1) return section;
        const count = document.createElement('strong'); count.textContent = t('diagnostics.occurrences', {count: series.count}); section.append(count);
        line(t('diagnostics.firstAt'), new Date(series?.firstAt ?? event.timestamp).toLocaleString());
        line(t('diagnostics.lastAt'), new Date(series?.lastAt ?? event.timestamp).toLocaleString());
        if (series && series.endedAt === undefined && series.count > 1) {const active = document.createElement('p'); active.textContent = t('diagnostics.series.active'); section.append(active);}
        if (series?.ending && series.endedAt !== undefined) line(t(`diagnostics.ending.${series.ending}`), new Date(series.endedAt).toLocaleString());
        if (series?.minDurationMs !== undefined) line(t('diagnostics.durationRange'), `${series.minDurationMs}–${series.maxDurationMs} ms`);
        return section;
    }
    private async copyEvents(): Promise<void> {
        try {await navigator.clipboard.writeText(JSON.stringify(this.events, null, 2)); if (!this.closed) this.status.textContent = t('diagnostics.copied');}
        catch {if (!this.closed) this.status.textContent = t('diagnostics.copyFailed');}
    }
    destroy(): void {this.closed = true; clearTimeout(this.timer); this.stop?.(); this.container.replaceChildren();}
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'DIAGNOSTIC_READ_FAILED';
}

export function diagnosticReasonText(reason?: string): string {
    const reasons = ['timeout', 'busy', 'network', 'authentication', 'authorization-changed', 'binding-changed', 'not-found', 'closed', 'unknown', 'export-not-granted', 'project-denied', 'binding-outdated', 'available', 'unverified'] as const;
    const value = reasons.find(value => value === reason) ?? 'unknown';
    return t(`diagnostics.reason.${value}`);
}
