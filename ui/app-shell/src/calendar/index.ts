import type {IFileSystem} from '@itookit/vfs-core';
import {VFS_DOM_EVENTS} from '@itookit/vfs-ui';
import {createWorkspaceModule} from '../workspaces/module';
import {dateKey, type CalendarEvent} from './model';
import {readCalendar, type CalendarSnapshot} from './read';
import {calendarMain, calendarSidebar, label} from './view';
interface Options {
    files: IFileSystem; sidebar: HTMLElement; editor: HTMLElement;
    selected(path: string): void; scanners(): Promise<void>;
    sourceNames?(): Promise<Record<string, string>>;
    showNavigationTitle?: boolean;
}

export class CalendarWorkbench {
    private readonly abort = new AbortController();
    private readonly disabled = new Set<string>();
    private snapshot: CalendarSnapshot = {events: [], sources: [], warnings: []};
    private month = new Date();
    private selected = dateKey(new Date());
    private detail?: CalendarEvent;
    private query = '';
    private visible = true;
    private dirty = false;
    private loading?: Promise<void>;
    private stopped?: () => void;
    private revision = 0;
    constructor(private readonly options: Options) {}

    async start(): Promise<void> {
        const {sidebar, editor} = this.options, signal = this.abort.signal;
        sidebar.classList.add('calendar__sidebar'); editor.classList.add('calendar');
        editor.innerHTML = '<p role="status"></p><p role="alert"></p><div data-calendar-content></div>';
        for (const container of [sidebar, editor]) container.addEventListener('click', event => {void this.click(event);}, {signal});
        sidebar.addEventListener('change', event => {
            const input = event.target;
            if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-calendar-source')) return;
            const id = input.dataset.calendarSource!; if (input.checked) this.disabled.delete(id); else this.disabled.add(id);
            if (this.detail && this.disabled.has(this.detail.sourceId)) this.detail = undefined;
            this.renderMain();
        }, {signal});
        sidebar.addEventListener('input', event => {
            const input = event.target as HTMLInputElement;
            if (input.matches('[data-calendar-search]')) {this.query = input.value; this.renderMain();}
        }, {signal});
        this.stopped = this.options.files.onAny?.(event => {if (event.type.startsWith('node:')) this.invalidateFromEvents();});
        await this.refresh();
    }
    async openResource(path: string): Promise<void> {
        const [, day, key] = path.split('/');
        if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day))) {
            this.selected = day; this.month = new Date(day + 'T12:00:00');
        }
        this.detail = this.snapshot.events.find(event => event.key === (key ? decodeURIComponent(key) : ''));
        this.renderMain();
    }
    getActiveResourceId(): string {return '/' + this.selected + (this.detail ? '/' + encodeURIComponent(this.detail.key) : '');}
    captureRecovery(): unknown {return {disabled: [...this.disabled], query: this.query};}
    restoreRecovery(value: unknown): void {
        const state = value as {disabled?: string[]; query?: string} | null;
        this.disabled.clear(); for (const id of state?.disabled ?? []) this.disabled.add(id);
        this.query = state?.query ?? ''; this.renderSidebar(); this.renderMain();
    }
    suspendForRecovery(): void {this.revision++; this.abort.abort(); this.stopped?.();}
    async destroy(): Promise<void> {this.suspendForRecovery();}
    setVisible(visible: boolean): void {this.visible = visible; if (visible && this.dirty) void this.refresh();}
    invalidateFromEvents(): void {this.dirty = true; if (this.visible) void this.refresh();}

    private refresh(): Promise<void> {
        if (this.abort.signal.aborted) return Promise.resolve();
        return this.loading ??= this.load().finally(() => {this.loading = undefined; if (this.dirty && this.visible && !this.abort.signal.aborted) void this.refresh();});
    }
    private async load(): Promise<void> {
        const revision = ++this.revision; this.dirty = false;
        try {
            const [snapshot, names] = await Promise.all([readCalendar(this.options.files, this.abort.signal), this.options.sourceNames?.() ?? Promise.resolve<Record<string, string>>({})]);
            if (revision !== this.revision || this.abort.signal.aborted) return;
            for (const source of snapshot.sources) if (source.account && names[source.account]) source.name = names[source.account] + source.name.slice(source.account.length);
            const sources = new Map(snapshot.sources.map(source => [source.id, source.name]));
            for (const event of snapshot.events) event.sourceName = sources.get(event.sourceId) ?? event.sourceName;
            this.snapshot = snapshot; this.detail = snapshot.events.find(event => event.key === this.detail?.key);
            this.options.editor.querySelector('[role=alert]')!.textContent = snapshot.warnings.length
                ? label('partial').replace('{count}', String(snapshot.warnings.length)) + ' · ' + [...new Set(snapshot.warnings)].join(', ') : '';
            this.renderSidebar(); this.renderMain();
        } catch (error) {
            if (this.abort.signal.aborted || revision !== this.revision) return;
            this.options.editor.querySelector('[role=alert]')!.textContent = label('loadFailed') + ' · ' + (error as Error).message;
            this.renderSidebar(); this.renderMain();
        }
    }
    private renderSidebar(): void {
        this.options.sidebar.innerHTML = calendarSidebar(this.snapshot.sources, this.disabled, this.options.showNavigationTitle);
        this.options.sidebar.querySelector<HTMLInputElement>('[data-calendar-search]')!.value = this.query;
    }
    private renderMain(): void {
        if (this.abort.signal.aborted) return;
        const query = this.query.toLocaleLowerCase();
        const events = this.snapshot.events.filter(event => !this.disabled.has(event.sourceId)
            && [event.title, event.location, event.description, event.sourceName].some(value => value.toLocaleLowerCase().includes(query)));
        this.options.editor.querySelector('[data-calendar-content]')!.innerHTML = calendarMain(this.month, this.selected, events, this.snapshot.sources, this.detail);
        this.options.selected(this.getActiveResourceId());
    }
    private async click(event: Event): Promise<void> {
        const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!target) return;
        const {calendarAction: action, calendarDay: day, calendarEvent: key} = target.dataset;
        if (action === 'scanners') {await this.options.scanners(); return;}
        if (action === 'refresh') {await this.refresh(); return;}
        if (action === 'close') this.detail = undefined;
        if (action === 'today') {this.month = new Date(); this.selected = dateKey(this.month); this.detail = undefined;}
        if (action === 'previous' || action === 'next') {
            this.month = new Date(this.month.getFullYear(), this.month.getMonth() + (action === 'next' ? 1 : -1), 1);
            this.selected = dateKey(this.month); this.detail = undefined;
        }
        if (day) {this.selected = day; this.detail = undefined;}
        if (key) this.detail = this.snapshot.events.find(item => item.key === key);
        this.renderMain();
        if (event.currentTarget === this.options.sidebar) this.options.sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}));
    }
}
export function createCalendarModule(options: Options) {return createWorkspaceModule(new CalendarWorkbench(options));}
