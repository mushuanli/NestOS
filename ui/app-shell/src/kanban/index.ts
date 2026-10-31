import {copyReference} from './references';
import {KanbanSuggestions} from './suggestions';
import {KanbanDrawer, drawerMarkup, preserveBoardScroll} from './drawer';
import {recordLinks, recordsView, recordDetail, recordForm} from './context-view';
import {escapeHTML, randomUUID} from '@itookit/common';
import {VFS_DOM_EVENTS} from '@itookit/vfs-ui';
import type {KanbanBoardSummary, KanbanCommand, KanbanItem, KanbanItemPage, KanbanItemQuery, KanbanPrincipal, KanbanRequest, KanbanService} from '@itookit/app-contracts';
import {createWorkspaceModule} from '../workspaces/module';
import {boardView, label, navigation, button} from './view';
import {detailView, newBoardForm, newItemForm} from './forms';
import {actionCommand, boardInput, formCommand, value} from './commands';
interface Options {
    service?: KanbanService; sidebar: HTMLElement; editor: HTMLElement;
    selected(path: string): void; openSession(id: string): Promise<void>;
}
export class KanbanWorkbench {
    private board?: KanbanBoardSummary;
    private page?: KanbanItemPage;
    private actor?: KanbanPrincipal;
    private item?: KanbanItem;
    private boardId = '';
    private recordKind?: 'log' | 'decision';
    private recordId = '';
    private recordPage?: import('@itookit/app-contracts').KanbanRecordPage;
    private recordCursor?: string;
    private suggestions!: KanbanSuggestions;
    private drawer!: KanbanDrawer;
    private itemId = '';
    private query: KanbanItemQuery = {view: 'all', limit: 50};
    private generation = 0;
    private eventGeneration = 0;
    private abort = new AbortController();
    private busy = false;
    private dirty = false;
    private visible = true;
    private invalid = false;
    private pending?: {boardId: string; fingerprint: string; request: KanbanRequest};
    constructor(private readonly options: Options) {}
    async start(): Promise<void> {
        const {sidebar, editor} = this.options, signal = this.abort.signal;
        sidebar.classList.add('kanban__sidebar'); editor.classList.add('kanban');
        editor.innerHTML = `<p data-status role="status"></p><p data-error role="alert"></p><div data-retry hidden>${button('refresh', 'retry')}</div><div data-content class="kanban__content"></div>${drawerMarkup()}`;
        this.drawer = new KanbanDrawer(editor, sidebar);
        this.suggestions = new KanbanSuggestions(editor, this.options.service, () => this.boardId);
        document.addEventListener('pointerdown', event => {
            for (const menu of editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (!menu.contains(event.target as Node)) menu.open = false;
        }, {signal});
        editor.addEventListener('toggle', event => {
            const opened = event.target;
            if (!(opened instanceof HTMLDetailsElement) || !opened.open || !opened.hasAttribute('data-popover')) return;
            for (const menu of editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (menu !== opened) menu.open = false;
        }, {capture: true, signal});
        editor.addEventListener('keydown', event => {
            const menu = editor.querySelector<HTMLDetailsElement>('[data-popover][open]');
            if (event.key === 'Escape' && menu) {event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); return;}

            this.drawer.keydown(event);
            if (event.key === 'Escape' && this.drawer.open) {event.preventDefault(); void this.run(async () => {if (this.dirty) throw new Error(label('unsaved')); this.closePanel();});}
        }, {signal});
        for (const element of [sidebar, editor]) element.addEventListener('click', event => {
            if (!(event.target as HTMLElement).closest('[data-action], [data-board], [data-item], [data-session], [data-record], [data-context]')) return;
            void this.run(async () => {
                await this.click(event);
                if (element === sidebar) sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}));
            });
        }, {signal});
        sidebar.addEventListener('submit', event => {event.preventDefault(); void this.run(() => this.submit(event));}, {signal});
        editor.addEventListener('submit', event => {event.preventDefault(); void this.run(() => this.submit(event));}, {signal});
        editor.addEventListener('input', event => {if ((event.target as HTMLElement).closest('[data-panel]')) this.dirty = true;}, {signal});
        await this.run(() => this.refresh());
    }
    async openResource(path: string): Promise<void> {
        if (this.busy || this.dirty) throw new Error(label('unsaved'));
        this.closePanel();
        const parts = path.split('/'); this.boardId = decodeURIComponent(parts[2] ?? ''); this.itemId = decodeURIComponent(parts[3] ?? '');
        this.recordId = parts[3] === '@record' ? decodeURIComponent(parts[4] ?? '') : '';
        if (this.recordId) this.itemId = '';
        this.recordKind = ['@log', '@decision'].includes(parts[3] ?? '') ? parts[3].slice(1) as 'log' | 'decision' : undefined;
        if (this.recordKind) this.itemId = '';
        this.recordCursor = undefined;
        this.query = {view: 'all', limit: 50}; await this.run(() => this.refresh());
    }
    getActiveResourceId(): string {return this.boardId ? `/board/${encodeURIComponent(this.boardId)}${this.recordId ? '/@record/' + encodeURIComponent(this.recordId) : this.itemId ? '/' + encodeURIComponent(this.itemId) : this.recordKind ? '/@' + this.recordKind : ''}` : '/';}
    captureRecovery(): unknown {if (this.busy || this.dirty) throw new Error(label('unsaved')); return null;}
    restoreRecovery(): void {}
    suspendForRecovery(): void {this.generation++; this.abort.abort(); this.suggestions?.destroy();}
    async destroy(): Promise<void> {
        this.suspendForRecovery(); this.suggestions.destroy(); this.drawer.destroy(); this.options.sidebar.replaceChildren(); this.options.editor.replaceChildren(); this.options.editor.inert = false;
        this.options.editor.classList.remove('kanban'); this.options.sidebar.classList.remove('kanban__sidebar');
    }
    invalidateFromEvents(): void {
        this.invalid = true; this.eventGeneration++;
        if (this.visible && !this.busy && !this.dirty) void this.run(() => this.refresh());
    }
    setVisible(visible: boolean): void {this.visible = visible; if (visible && this.invalid) this.invalidateFromEvents();}
    private async refresh(): Promise<void> {
        const service = this.options.service, generation = ++this.generation, events = this.eventGeneration;
        if (!service) {this.content().innerHTML = `<p>${escapeHTML(label('unavailable'))}</p>`; return;}
        const [boards, actor] = await Promise.all([service.catalog?.() ?? service.list(), service.currentPrincipal()]);
        if (!this.alive(generation)) return;
        this.actor = actor;
        if (!this.boardId) this.boardId = boards[0]?.id ?? '';
        this.board = boards.find(board => board.id === this.boardId);
        if (this.boardId && !this.board) throw new Error('BOARD_NOT_FOUND');
        const page = this.board ? await service.query(this.boardId, this.query) : undefined;
        if (!this.alive(generation)) return;
        this.page = page; this.invalid = events !== this.eventGeneration;
        this.options.sidebar.innerHTML = navigation(boards, this.boardId);
        preserveBoardScroll(this.content(), () => {this.content().innerHTML = this.board && page ? boardView(this.board, page, this.query) : `<p>${escapeHTML(label('emptyBoards'))}</p>${button('new-board', 'newBoard')}`;});
        if (this.recordKind) await this.showRecords(generation);
        if (this.recordId) await this.showRecord(this.recordId, generation);
        else if (this.itemId) await this.showItem(generation);
        this.options.selected(this.getActiveResourceId());
    }
    private async showItem(generation = this.generation): Promise<void> {
        const service = this.options.service;
        if (!service || !this.board || !this.itemId) return;
        const [{item, archive}, events, records] = await Promise.all([service.item(this.boardId, this.itemId), service.events(this.boardId, 0, 200), service.records(this.boardId, {itemId: this.itemId, limit: 10})]);
        if (!this.alive(generation)) return;
        this.item = item; this.drawer.show(detailView(this.board, item, this.actor, !!archive, events.filter(event => event.itemId === item.id).reverse()), 'item:' + item.id);
        this.panel().querySelector('[data-related-records]')!.innerHTML = `<h4>${escapeHTML(label('relatedRecords'))} (${records.total})</h4>${recordLinks(records, this.board)}<div class="kanban__actions">${button('new-log', 'newLog')}${button('new-decision', 'newDecision')}</div>`;
        this.options.selected(this.getActiveResourceId());
    }
    private async showRecords(generation: number): Promise<void> {
        if (!this.recordKind || !this.options.service) return;
        const page = await this.options.service.records(this.boardId, {kind: this.recordKind, limit: 50, ...(this.recordCursor ? {cursor: this.recordCursor} : {})});
        if (!this.alive(generation)) return;
        this.recordPage = page; this.content().innerHTML = recordsView(page, this.recordKind, !!this.recordCursor, this.board);
    }
    private async showRecord(id: string, generation = this.generation): Promise<void> {
        if (!this.options.service) return;
        const record = await this.options.service.record(this.boardId, id);
        if (!this.alive(generation)) return;
        this.recordId = id; this.drawer.show(recordDetail(record, this.board!), 'record:' + id); this.options.selected(this.getActiveResourceId());
    }
    private async click(event: Event): Promise<void> {
        const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target || target.matches(':disabled')) return;
        for (const menu of this.options.editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (!menu.contains(target)) menu.open = false;
        if (target.dataset.session) {await this.options.openSession(target.dataset.session); return;}
        if (this.dirty && !['close-panel', 'copy-reference', 'copy-link'].includes(target.dataset.action ?? '')) throw new Error(label('unsaved'));
        if (target.dataset.board) {await this.navigate(target.dataset.board); return;}
        if (target.dataset.context) {this.recordKind = target.dataset.context === 'board' ? undefined : target.dataset.context as 'log' | 'decision'; this.recordCursor = undefined; this.closePanel(); await this.refresh(); return;}
        if (target.dataset.record) {this.itemId = ''; this.item = undefined; await this.showRecord(target.dataset.record); return;}
        if (target.dataset.item) {this.recordId = ''; this.itemId = target.dataset.item; await this.showItem(); return;}
        const action = target.dataset.action;
        if (action === 'close-panel' || action === 'dismiss-panel') {this.closePanel(); this.options.selected(this.getActiveResourceId()); return;}
        if (action === 'copy-reference' || action === 'copy-link') {await copyReference(target.closest<HTMLElement>('[data-action]')!); return;}
        if (action === 'new-board') {this.itemId = ''; this.drawer.show(newBoardForm(), 'new-board'); this.dirty = true; return;}
        if (action === 'new-item' && this.board) {this.itemId = ''; this.drawer.show(newItemForm(this.board), 'new-item'); this.dirty = true; return;}
        if (action === 'new-log' || action === 'new-decision') {this.recordId = ''; this.drawer.show(recordForm(action === 'new-log' ? 'log' : 'decision', this.board!, this.itemId), action); this.dirty = true; return;}
        if (action === 'scroll-left' || action === 'scroll-right') {const board = this.content().querySelector<HTMLElement>('.kanban__columns'); if (board) board.scrollLeft += board.clientWidth * (action === 'scroll-left' ? -0.8 : 0.8); return;}
        if (action === 'records-next' || action === 'records-first') {this.recordCursor = action === 'records-next' ? this.recordPage?.nextCursor : undefined; await this.refresh(); return;}
        if ((action === 'confirm-record' || action === 'reject-record') && this.recordId) {await this.execute({type: 'review-record', recordId: this.recordId, accept: action === 'confirm-record'}); return;}
        if (action === 'next' || action === 'first') {this.query.cursor = action === 'next' ? this.page?.nextCursor : undefined; await this.refresh(); return;}
        if (action === 'refresh') {await this.refresh(); return;}
        if (action && this.item) await this.execute(actionCommand(action, this.item));
    }
    private async openReference(reference: string): Promise<void> {
        if (this.dirty) throw new Error(label('unsaved'));
        const target = await this.options.service!.resolve(reference);
        this.closePanel(); this.boardId = target.boardId; this.itemId = target.itemId ?? ''; this.recordId = target.recordId ?? '';
        this.recordKind = undefined; this.recordCursor = undefined; this.query = {view: 'all', limit: 50};
        await this.refresh();
        this.options.sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles:true}));
    }
    private async navigate(id: string): Promise<void> {
        this.boardId = id; this.itemId = ''; this.recordKind = undefined; this.recordCursor = undefined; this.query = {view: 'all', limit: 50}; this.closePanel(); await this.refresh();
    }
    private async submit(event: Event): Promise<void> {
        const form = event.target as HTMLFormElement, kind = form.dataset.form, data = new FormData(form);
        form.dataset.resourceId ??= randomUUID();
        if (!form.reportValidity()) return;
        if (kind === 'reference') {await this.openReference(value(data, 'reference')); return;}
        if (kind === 'filter') {
            if (this.dirty) throw new Error(label('unsaved'));
            this.query = {view: value(data, 'view') as KanbanItemQuery['view'], search: value(data, 'search'), area: value(data, 'area') || undefined, milestone: value(data, 'milestone') || undefined, limit: 50};
            await this.refresh(); return;
        }
        if (kind === 'board' && this.actor && this.options.service) {
            const created = await this.options.service.create(boardInput(data, this.actor, form.dataset.resourceId));
            this.dirty = false; await this.navigate(created.id); return;
        }
        if (kind === 'amendment') data.set('amendmentId', form.dataset.amendment ?? '');
        if (kind === 'record-link' && this.recordId) {await this.execute({type: 'link-record', recordId: this.recordId, itemId: value(data, 'itemId')}); return;}
        if (kind && this.board) await this.execute(formCommand(kind, data, this.board, this.item, form.dataset.resourceId));
    }
    private async execute(command: KanbanCommand): Promise<void> {
        if (!this.board || !this.options.service) return;
        const fingerprint = JSON.stringify(command);
        if (this.pending && (this.pending.boardId !== this.board.id || this.pending.fingerprint !== fingerprint)) throw Object.assign(new Error('Pending write'), {code: 'WRITE_OUTCOME_UNKNOWN'});
        this.pending ??= {boardId: this.board.id, fingerprint, request: {operationId: randomUUID(), expectedRevision: this.board.revision, command}};
        try {await this.options.service.execute(this.board.id, this.pending.request);}
        catch (error) {
            if ((error as Error)?.name === 'KanbanError' || (error as {outcome?: string})?.outcome === 'not-committed') this.pending = undefined;
            throw error;
        }
        this.pending = undefined;
        this.dirty = false; this.query.cursor = undefined; this.recordCursor = undefined;
        if (command.type === 'create-item') this.itemId = command.item.id;
        if (command.type === 'append-record') {this.recordId = command.record.id; this.itemId = ''; this.item = undefined;}
        await this.refresh();
    }
    private async run(action: () => Promise<void>): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return;
        this.busy = true; this.status(label('loading')); this.error(''); this.options.editor.setAttribute('aria-busy', 'true'); this.options.editor.inert = true;
        let succeeded = false;
        try {await action(); succeeded = true;}
        catch (error) {if (!this.abort.signal.aborted) this.error(errorText(error));}
        finally {
            this.busy = false;
            if (!this.abort.signal.aborted) {
                this.status(''); this.options.editor.removeAttribute('aria-busy'); this.options.editor.inert = false; this.drawer.flushFocus();
                if (succeeded && this.invalid && this.visible && !this.dirty) void this.run(() => this.refresh());
            }
        }
    }
    private closePanel(): void {this.dirty = false; this.itemId = ''; this.recordId = ''; this.item = undefined; this.drawer.close();}
    private alive(generation: number): boolean {return generation === this.generation && !this.abort.signal.aborted;}
    private content(): HTMLElement {return this.options.editor.querySelector('[data-content]')!;}
    private panel(): HTMLElement {return this.options.editor.querySelector('[data-panel]')!;}
    private status(message: string): void {this.options.editor.querySelector('[data-status]')!.textContent = message;}
    private error(message: string): void {
        const error = this.options.editor.querySelector<HTMLElement>('[data-error]')!; error.textContent = message; error.hidden = this.drawer?.open ?? false;
        const panelError = this.options.editor.querySelector('[data-panel-error]'); if (panelError) panelError.textContent = message;
        this.options.editor.querySelector<HTMLElement>('[data-retry]')!.hidden = !message || (this.drawer?.open ?? false);
    }
}
function errorText(error: unknown): string {
    const code = (error as {outcome?: string})?.outcome === 'unknown' ? 'WRITE_OUTCOME_UNKNOWN' : (error as {code?: unknown})?.code;
    if (code === 'REVISION_CONFLICT' || code === 'CURSOR_STALE') return label('conflict');
    if (error instanceof Error && error.message === label('unsaved')) return error.message;
    const safe = typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'KANBAN_OPERATION_FAILED';
    const translated = label('errors.' + safe);
    return translated !== 'kanban.errors.' + safe ? `${translated} (${safe})` : `${label('failed')}: ${safe}`;
}
export function createKanbanWorkspace(options: Options) {return createWorkspaceModule(new KanbanWorkbench(options));}
