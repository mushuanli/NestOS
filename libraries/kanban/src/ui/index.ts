import {automationForm, analysisView, preparationFields} from './automation';
import {KanbanSuggestions} from './suggestions';
import {mountTitleBar as mountSharedTitleBar} from '@itookit/ui-common';
import {KanbanDrawer, drawerMarkup, preserveBoardScroll} from './drawer';
import {escapeHTML} from './html';
import {childrenView, childType} from './children';
import {linkPair} from './session-links';
import {failureDetails} from './diagnostics';
import {randomUUID} from '../utils';
import type {KanbanUIOptions} from './ports';
import {createRenderer} from './renderer';
import type {KanbanBoardSummary, KanbanCommand, KanbanItem, KanbanSessionItemPage, KanbanSessionActivityQuery, KanbanPrincipal, KanbanRequest} from '../contracts';
import {actionCommand, boardInput, formCommand, value} from './commands';

export class KanbanWorkbench {
    private board?: KanbanBoardSummary;
    private page?: KanbanSessionItemPage;
    private actor?: KanbanPrincipal;
    private automationCatalog?: import('../contracts').KanbanAutomationCatalog;
    private item?: KanbanItem;
    private boardId = '';
    private recordKind?: 'log' | 'decision';
    private recordId = '';
    private recordPage?: import('../contracts').KanbanRecordPage;
    private recordCursor?: string;
    private suggestions!: KanbanSuggestions;
    private drawer!: KanbanDrawer;
    private itemId = '';
    private query: KanbanSessionActivityQuery = {view: 'all', limit: 50};
    private activityTimer?: ReturnType<typeof setInterval>;
    private generation = 0;
    private eventGeneration = 0;
    private abort = new AbortController();
    private busy = false;
    private operationStage = 'ui.operation';
    private dirty = false;
    private visible = true;
    private invalid = false;
    private pending?: {boardId: string; fingerprint: string; request: KanbanRequest};
    private readonly ui;
    private releaseNavigation?: () => void;
    private readonly windowMounts = new Map<HTMLElement, () => void>();
    constructor(private readonly options: KanbanUIOptions, private readonly container?: HTMLElement) {this.ui = createRenderer(options.presentation);}
    async start(): Promise<void> {
        const {sidebar, editor} = this.options, signal = this.abort.signal;
        sidebar?.classList.add('kanban__sidebar'); editor.classList.add('kanban');
        editor.innerHTML = `<p data-status role="status"></p><p data-error role="alert"></p><div data-retry hidden>${this.ui.button('refresh', 'retry')}</div><div data-content class="kanban__content"></div>${drawerMarkup(this.options.presentation)}`;
        this.drawer = new KanbanDrawer(editor, sidebar);
        this.suggestions = new KanbanSuggestions(editor, this.options.service, () => this.boardId, this.options.presentation);
        document.addEventListener('pointerdown', event => {
            for (const menu of editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (!menu.contains(event.target as Node)) menu.open = false;
        }, {signal});
        editor.addEventListener('toggle', event => {
            const opened = event.target;
            if (!(opened instanceof HTMLDetailsElement) || !opened.open || !opened.hasAttribute('data-popover')) return;
            for (const menu of editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (menu !== opened) menu.open = false;
        }, {capture: true, signal});
        editor.addEventListener('change',event=>{
            const target=event.target;if(!(target instanceof HTMLSelectElement)||target.name!=='kind')return;
            const resource=target.closest('form')?.querySelector<HTMLSelectElement>('select[name="itemResource"]');
            if(resource)resource.required=resource.dataset.resourceRequired==='true'&&target.selectedOptions[0]?.dataset.executable==='true';
        },{signal});
        editor.addEventListener('keydown', event => {
            const menu = editor.querySelector<HTMLDetailsElement>('[data-popover][open]');
            if (event.key === 'Escape' && menu) {event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); return;}

            this.drawer.keydown(event);
            if (event.key === 'Escape' && this.drawer.open) {event.preventDefault(); void this.run(() => this.requestClose(false));}
        }, {signal});
        for (const element of sidebar ? [sidebar, editor] : [editor]) element.addEventListener('click', event => {
            if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)) return;
            if (!(event.target as HTMLElement).closest('[data-action], [data-board], [data-item], [data-session], [data-record], [data-context]')) return;
            void this.run(async () => {
                await this.click(event);
                if (element === sidebar) this.options.activated?.();
            });
        }, {signal});
        sidebar?.addEventListener('submit', event => {event.preventDefault(); void this.run(() => this.submit(event));}, {signal});
        editor.addEventListener('submit', event => {event.preventDefault(); void this.run(() => this.submit(event));}, {signal});
        editor.addEventListener('change', event => {
            const target = event.target as HTMLSelectElement;
            if (target.name === 'preparation' && this.board && this.automationCatalog) {
                const container = editor.querySelector('[data-preparation-options]');
                if (container) container.innerHTML = preparationFields(this.board, this.automationCatalog, target.value ? JSON.parse(target.value) : null);
            }
        }, {signal});
        editor.addEventListener('input', event => {if ((event.target as HTMLElement).closest('[data-panel]') && !(event.target as HTMLElement).closest('[data-form=reference]')) {this.dirty = true; this.options.changed?.();}}, {signal});
        if (this.options.service?.queryActivity) this.activityTimer=setInterval(()=>{if(this.visible&&!document.hidden&&!this.busy&&!this.dirty&&(this.board?.automation?.enabled||this.page?.items.some(item=>item.execution)||this.query.execution&&this.query.execution!=='all')) this.invalidateFromEvents();},15000);
        if (this.options.initialResource !== undefined) await this.openResource(this.options.initialResource);
        else await this.run(() => this.refresh());
    }
    open(target: {boardId?: string; itemId?: string; recordId?: string}): Promise<void> {
        const path = target.boardId ? `/board/${encodeURIComponent(target.boardId)}${target.recordId ? '/@record/' + encodeURIComponent(target.recordId) : target.itemId ? '/' + encodeURIComponent(target.itemId) : ''}` : '/';
        return this.openResource(path);
    }
    dispose(): Promise<void> {return this.destroy();}
    async openResource(path: string): Promise<void> {
        if (this.busy || this.dirty) throw new Error(this.ui.label('unsaved'));
        this.closePanel();
        const parts = path.split('/'); this.boardId = decodeURIComponent(parts[2] ?? ''); this.itemId = decodeURIComponent(parts[3] ?? '');
        this.recordId = parts[3] === '@record' ? decodeURIComponent(parts[4] ?? '') : '';
        if (this.recordId) this.itemId = '';
        this.recordKind = ['@log', '@decision'].includes(parts[3] ?? '') ? parts[3].slice(1) as 'log' | 'decision' : undefined;
        if (this.recordKind) this.itemId = '';
        this.recordCursor = undefined;
        this.query = {view: 'all', limit: 50}; await this.run(() => this.refresh());
    }
    createBoard(): Promise<void> {return this.run(async () => {
        if (this.dirty) throw new Error(this.ui.label('unsaved'));
        this.showBoardForm();
    });}
    private showBoardForm(): void {this.itemId = ''; this.drawer.show(this.ui.newBoardForm(), 'new-board'); this.dirty = true;}
    getActiveResourceId(): string {return this.boardId ? `/board/${encodeURIComponent(this.boardId)}${this.recordId ? '/@record/' + encodeURIComponent(this.recordId) : this.itemId ? '/' + encodeURIComponent(this.itemId) : this.recordKind ? '/@' + this.recordKind : ''}` : '/';}
    getViewState() {
        return {title: this.drawer?.open ? this.panel().querySelector('h3')?.textContent ?? this.board?.title : this.board?.title ?? this.ui.label('title'),
            context: this.board?.title, dirty: this.dirty, busy: this.busy};
    }
    captureRecovery(): unknown {if (this.busy || this.dirty) throw new Error(this.ui.label('unsaved')); return null;}
    restoreRecovery(): void {}
    suspendForRecovery(): void {this.generation++; this.abort.abort(); this.suggestions?.destroy();if(this.activityTimer) clearInterval(this.activityTimer);}
    async destroy(): Promise<void> {
        for (const release of this.windowMounts.values()) release(); this.windowMounts.clear();
        this.suspendForRecovery(); this.releaseNavigation?.(); this.releaseNavigation = undefined; this.suggestions?.destroy(); this.drawer?.destroy(); this.options.sidebar?.replaceChildren(); this.options.editor.replaceChildren(); this.options.editor.inert = false;
        this.options.editor.classList.remove('kanban'); this.options.sidebar?.classList.remove('kanban__sidebar');
        this.container?.replaceChildren(); this.container?.classList.remove('kanban-layout');
    }
    invalidateFromEvents(): void {
        this.invalid = true; this.eventGeneration++;
        if (this.visible && !this.busy && !this.dirty) void this.run(() => this.refresh());
    }
    setVisible(visible: boolean): void {this.visible = visible; if (visible && this.invalid) this.invalidateFromEvents();}
    private async refresh(): Promise<void> {
        const service = this.options.service, generation = ++this.generation, events = this.eventGeneration;
        if (!service) {this.content().innerHTML = `<p>${escapeHTML(this.ui.label('unavailable'))}</p>`; return;}
        this.operationStage = 'ui.catalog';
        const [boards, actor] = await Promise.all([service.catalog?.() ?? service.list(), service.currentPrincipal()]);
        if (!this.alive(generation)) return;
        this.actor = actor;
        if (!this.boardId && this.options.initialResource === undefined) this.boardId = boards[0]?.id ?? '';
        this.board = boards.find(board => board.id === this.boardId);
        if (this.boardId && !this.board) throw Object.assign(new Error('Board unavailable'), {code: 'BOARD_NOT_FOUND'});
        if(this.query.execution&&this.query.execution!=='all'&&!service.queryActivity) throw Object.assign(new Error('Execution Session projection unavailable'),{code:'EXECUTION_SESSION_UNAVAILABLE'});
        this.operationStage = 'ui.query';
        const page = this.board ? await (service.queryActivity?.(this.boardId,this.query) ?? service.query(this.boardId, this.query)) : undefined;
        if (!this.alive(generation)) return;
        this.page = page; this.invalid = events !== this.eventGeneration;
        if (this.options.sidebar) this.options.sidebar.innerHTML = this.ui.navigation(boards, this.boardId);
        this.operationStage = 'ui.render';
        preserveBoardScroll(this.content(), () => {this.content().innerHTML = this.board && page ? this.ui.boardView(this.board, page, this.query, !!service.queryActivity, !!service.automationCatalog, this.options.sessionUrl) : this.ui.catalogView(boards);});
        if (this.recordKind) await this.showRecords(generation);
        if (!this.alive(generation)) return;
        this.releaseNavigation?.(); this.releaseNavigation = undefined;
        const navigation = this.content().querySelector<HTMLElement>('[data-navigation]');
        if (navigation && !this.options.mountTitleBar) this.releaseNavigation = this.options.mountNavigation?.(navigation);
        if (this.recordId) await this.showRecord(this.recordId, generation);
        else if (this.itemId) await this.showItem(generation);
        this.operationStage = 'ui.selection'; this.options.selected(this.getActiveResourceId());
    }
    private async showItem(generation = this.generation): Promise<void> {
        const service = this.options.service;
        if (!service || !this.board || !this.itemId) return;
        this.operationStage='ui.item.load';
        const [{item, archive}, events, records, execution, analysis] = await Promise.all([service.item(this.boardId, this.itemId), service.events(this.boardId, 0, 200), service.records(this.boardId, {itemId: this.itemId, limit: 10}),service.executionSession?.(this.boardId,this.itemId), this.board.automation ? service.analysisStatus?.(this.boardId,this.itemId) : undefined]);
        if (!this.alive(generation)) return;
        this.operationStage='ui.item.render';
        this.item = item; this.drawer.show(this.ui.detailView(this.board, item, this.actor, !!archive, events.filter(event => event.itemId === item.id).reverse()), 'item:' + item.id);
        if (this.board.automation) this.panel().querySelector('[data-analysis]')!.innerHTML = analysisView(this.options.presentation, analysis ?? null);
        this.operationStage='ui.item.session';
        if(execution) this.panel().querySelector('[data-execution-session]')!.innerHTML=this.ui.executionSessionView(execution,!!this.options.executionReference&&!archive&&!['completed','cancelled'].includes(item.status), this.options.sessionUrl);
        this.panel().querySelector('[data-related-records]')!.innerHTML = `<h4>${escapeHTML(this.ui.label('relatedRecords'))} (${records.total})</h4>${this.ui.recordLinks(records, this.board)}<div class="kanban__actions">${this.ui.button('new-log', 'newLog')}${this.ui.button('new-decision', 'newDecision')}</div>`;
        this.operationStage='ui.item.references';
        await this.showReferenceLinks(item.externalRefs ?? [], generation, new Set(execution?.history.map(binding => binding.sessionId)));
        this.operationStage='ui.item.children';
        await this.showChildren(generation);
        this.options.selected(this.getActiveResourceId());
    }
    private async showChildren(generation: number, cursor?: string): Promise<void> {
        const {service} = this.options, item = this.item, board = this.board;
        if (!service || !item || !board || !childType(board, item)) return;
        const query = {parentId: item.id, view: 'all' as const, limit: 50, ...(cursor ? {cursor} : {})};
        const page = await (service.queryActivity?.(board.id, query) ?? service.query(board.id, query));
        if (!this.alive(generation)) return;
        this.panel().querySelector('[data-children]')!.innerHTML = childrenView(this.options.presentation, page, cursor, !['completed', 'cancelled'].includes(item.status) && !item.closedAt, this.options.sessionUrl);
    }
    private async showRecords(generation: number): Promise<void> {
        if (!this.recordKind || !this.options.service) return;
        let page: import('../contracts').KanbanRecordPage;
        try {page = await this.options.service.records(this.boardId, {kind: this.recordKind, limit: 50, ...(this.recordCursor ? {cursor: this.recordCursor} : {})});}
        catch (error) {
            if ((error as {code?: string})?.code !== 'CURSOR_STALE' || !this.recordCursor) throw error;
            this.recordCursor = undefined;
            page = await this.options.service.records(this.boardId, {kind: this.recordKind, limit: 50});
        }
        if (!this.alive(generation)) return;
        this.recordPage = page; this.content().innerHTML = this.ui.recordsView(page, this.recordKind, !!this.recordCursor, this.board);
    }
    private async showRecord(id: string, generation = this.generation): Promise<void> {
        if (!this.options.service) return;
        const record = await this.options.service.record(this.boardId, id);
        const executions = record.kind === 'decision' ? await this.options.service.recordExecutions?.(this.boardId, id) : undefined;
        if (!this.alive(generation)) return;
        this.recordId = id; this.drawer.show(this.ui.recordDetail(record, this.board!, executions), 'record:' + id); await this.showReferenceLinks(record.externalRefs ?? [], generation); this.options.selected(this.getActiveResourceId());
    }
    private async showReferenceLinks(references: import('../contracts').KanbanExternalReference[], generation: number, skip = new Set<string>()): Promise<void> {
        if (!this.options.referenceLink) return;
        const started = Date.now();
        const results = await Promise.allSettled(references.filter(ref => !skip.has(ref.id)).map(ref => this.options.referenceLink!(ref)));
        if (!this.alive(generation)) return;
        const resolved = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
        const links = [...new Map(resolved.map(link => [link.href, link])).values()];
        const slot = this.panel().querySelector('[data-reference-links]');
        if (slot) slot.innerHTML = links.map(link => linkPair(this.options.presentation, link.href, link.label, link.sessionId)).join('');
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (errors.length) {
            const raw = (errors[0].reason as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'SESSION_LINK_UNAVAILABLE';
            if (slot) {const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = this.ui.label('sessionLinkUnavailable') + ' (' + code + ')'; slot.append(error);}
            this.options.presentation.log?.({operationId: randomUUID(), stage: 'ui.reference-links', result: 'failure', code, ...failureDetails(errors[0].reason), durationMs: Date.now() - started});
        }
    }
    private async click(event: Event): Promise<void> {
        const target = (event.target as HTMLElement).closest<HTMLElement>('button, a'); if (!target || target.matches(':disabled')) return;
        for (const menu of this.options.editor.querySelectorAll<HTMLDetailsElement>('[data-popover][open]')) if (!menu.contains(target)) menu.open = false;
        if (target.dataset.session) {event.preventDefault(); await this.options.openSession(target.dataset.session); return;}
        if (this.dirty && !['close-panel', 'copy-reference', 'copy-link'].includes(target.dataset.action ?? '')) throw new Error(this.ui.label('unsaved'));
        const path = this.navigationTarget(target);
        if (path && this.options.navigate) {await this.options.navigate(path); return;}
        if (target.dataset.board) {await this.navigate(target.dataset.board); return;}
        if (target.dataset.context) {this.recordKind = target.dataset.context === 'board' ? undefined : target.dataset.context as 'log' | 'decision'; this.recordCursor = undefined; this.closePanel(); await this.refresh(); return;}
        if (target.dataset.record) {this.itemId = ''; this.item = undefined; await this.showRecord(target.dataset.record); return;}
        if (target.dataset.item) {this.recordId = ''; this.itemId = target.dataset.item; await this.showItem(); return;}
        const action = target.dataset.action;
        if (action === 'close-panel' || action === 'dismiss-panel') {await this.requestClose(action === 'close-panel'); return;}
        if (action === 'copy-reference' || action === 'copy-link') {await this.ui.copyReference(target.closest<HTMLElement>('[data-action]')!); return;}
        if (action === 'automation' && this.board && this.options.service?.automationCatalog) {
            this.automationCatalog = await this.options.service.automationCatalog();
            this.itemId = ''; this.drawer.show(automationForm(this.options.presentation, this.board, this.automationCatalog), 'automation'); this.dirty = true; return;
        }
        if (action === 'reanalyze' && this.item?.planning) {await this.execute({type: 'plan-item', itemId: this.item.id, planning: this.item.planning}); return;}
        if (action === 'new-board') {this.showBoardForm(); return;}
        if (action === 'children-next' || action === 'children-first') {await this.showChildren(this.generation, action === 'children-next' ? target.dataset.cursor : undefined); return;}
        if (action === 'new-child' && this.board && this.item && childType(this.board, this.item)) {
            await this.showItemForm(this.item);return;
        }
        if (action === 'new-item' && this.board) {await this.showItemForm();return;}
        if (action === 'new-log' || action === 'new-decision') {
            const resources = action === 'new-decision' ? await this.options.service?.recordResources?.() : [];
            this.recordId = ''; this.drawer.show(this.ui.recordForm(action === 'new-log' ? 'log' : 'decision', this.board!, this.itemId, resources), action); this.dirty = true; return;
        }
        if ((action === 'run-record' || action === 'run-record-separate') && this.options.service?.runRecord) {
            const record = await this.options.service.record(this.boardId, this.recordId);
            target.dataset.operationId ??= randomUUID();
            await this.options.service.runRecord(this.boardId, {operationId: target.dataset.operationId, recordId: record.id, expectedRevision: record.revision, placement: action === 'run-record-separate' ? 'new-board' : 'current-board'});
            this.options.committed?.(); await this.refresh(); return;
        }
        if (action === 'scroll-left' || action === 'scroll-right') {const board = this.content().querySelector<HTMLElement>('.kanban__columns'); if (board) board.scrollLeft += board.clientWidth * (action === 'scroll-left' ? -0.8 : 0.8); return;}
        if (action === 'records-next' || action === 'records-first') {this.recordCursor = action === 'records-next' ? this.recordPage?.nextCursor : undefined; await this.refresh(); return;}
        if ((action === 'confirm-record' || action === 'reject-record') && this.recordId) {await this.execute({type: 'review-record', recordId: this.recordId, accept: action === 'confirm-record'}); return;}
        if (action === 'next' || action === 'first') {this.query.cursor = action === 'next' ? this.page?.nextCursor : undefined; await this.refresh(); return;}
        if (action === 'refresh') {await this.refresh(); return;}
        if (action && this.item) await this.execute(actionCommand(action, this.item));
    }
    private async openReference(reference: string): Promise<void> {
        if (this.dirty) throw new Error(this.ui.label('unsaved'));
        const target = await this.options.service!.resolve(reference);
        if (this.options.navigate) {
            const leaf = target.recordId ? '/@record/' + encodeURIComponent(target.recordId) : target.itemId ? '/' + encodeURIComponent(target.itemId) : '';
            await this.options.navigate(`/board/${encodeURIComponent(target.boardId)}${leaf}`); return;
        }
        this.closePanel(); this.boardId = target.boardId; this.itemId = target.itemId ?? ''; this.recordId = target.recordId ?? '';
        this.recordKind = undefined; this.recordCursor = undefined; this.query = {view: 'all', limit: 50};
        await this.refresh();
        this.options.activated?.();
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
            if (this.dirty) throw new Error(this.ui.label('unsaved'));
            this.query = {view: value(data, 'view') as KanbanSessionActivityQuery['view'],execution:(value(data,'execution')||'all') as KanbanSessionActivityQuery['execution'], search: value(data, 'search'), area: value(data, 'area') || undefined, milestone: value(data, 'milestone') || undefined, limit: 50};
            await this.refresh(); return;
        }
        if (kind === 'board' && this.actor && this.options.service) {
            const created = await this.options.service.create(boardInput(data, this.actor, form.dataset.resourceId));
            this.options.committed?.(); this.dirty = false; await this.navigate(created.id); return;
        }
        if (kind === 'automation' && this.automationCatalog) {
            await this.execute({type: 'configure-automation', settings: {enabled: data.has('enabled'), autoAccept: data.has('autoAccept'),
                ...(value(data, 'preparation') ? {preparation: JSON.parse(value(data, 'preparation')),
                    preparationOptions: Object.fromEntries([...data.entries()].filter(([key]) => key.startsWith('preparation-option-'))
                        .map(([key, value]) => [key.slice('preparation-option-'.length), String(value)]))} : {}),
                planner: JSON.parse(value(data, 'planner')), executor: JSON.parse(value(data, 'executor')),
                coordinator: this.automationCatalog.coordinator, worker: this.automationCatalog.worker}}); return;
        }
        if (kind === 'amendment') data.set('amendmentId', form.dataset.amendment ?? '');
        if (kind === 'record-link' && this.recordId) {await this.execute({type: 'link-record', recordId: this.recordId, itemId: value(data, 'itemId')}); return;}
        if (kind && this.board) {
            if (kind === 'execution-session' && this.item && this.options.executionReference) {
                await this.execute({type: 'link-reference', itemId: this.item.id, reference: this.options.executionReference(value(data, 'executionSession'), form.dataset.resourceId)}); return;
            }
            await this.execute(formCommand(kind, data, this.board, this.item, form.dataset.resourceId));
        }
    }
    private async showItemForm(parent?:KanbanItem):Promise<void> {
        const board=this.board,generation=this.generation;if(!board)return;
        const resources=await this.options.service?.itemResources?.(board.id,parent?.id);
        if(this.abort.signal.aborted||generation!==this.generation)return;
        this.itemId='';this.drawer.show(this.ui.newItemForm(board,parent,resources),parent?'new-child':'new-item');this.dirty=true;
    }
    private async execute(command: KanbanCommand): Promise<void> {
        if (!this.board || !this.options.service) return;
        if (command.type === 'review') {
            const workflow = await this.options.service.workflow(this.board.id);
            const dispatch = Object.values(workflow.dispatches).find(dispatch => dispatch.itemId === ('itemId' in command ? command.itemId : '') && dispatch.outcome === 'succeeded');
            if (dispatch) command = {type: 'accept-execution', dispatchId: dispatch.id, accept: command.accept};
        }
        const fingerprint = JSON.stringify(command);
        if (this.pending && (this.pending.boardId !== this.board.id || this.pending.fingerprint !== fingerprint)) throw Object.assign(new Error('Pending write'), {code: 'WRITE_OUTCOME_UNKNOWN'});
        this.pending ??= {boardId: this.board.id, fingerprint, request: {operationId: randomUUID(), expectedRevision: this.board.revision, command}};
        try {await this.options.service.execute(this.board.id, this.pending.request);}
        catch (error) {
            if ((error as Error)?.name === 'KanbanError' || (error as {outcome?: string})?.outcome === 'not-committed') this.pending = undefined;
            throw error;
        }
        this.pending = undefined; this.options.committed?.();
        if (command.type === 'configure-automation') this.closePanel();
        this.dirty = false; this.query.cursor = undefined; this.recordCursor = undefined;
        if (command.type === 'create-item') this.itemId = command.item.id;
        if (command.type === 'append-record') {this.recordId = command.record.id; this.itemId = ''; this.item = undefined;}
        await this.refresh();
    }
    private async run(action: () => Promise<void>): Promise<void> {
        if (this.busy || this.abort.signal.aborted) return;
        const operationId = randomUUID(), started = Date.now();
        this.operationStage = 'ui.operation';
        this.busy = true; this.status(this.ui.label('loading')); this.error(''); this.options.editor.setAttribute('aria-busy', 'true'); this.options.editor.inert = true;
        let succeeded = false;
        try {await action(); succeeded = true;}
        catch (error) {
            const raw = (error as {code?: unknown})?.code;
            try {this.options.presentation.log?.({operationId, stage: this.operationStage, result: 'failure', ...failureDetails(error), code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'KANBAN_OPERATION_FAILED', durationMs: Date.now() - started});} catch { /* Reporting cannot alter drafts. */ }
            if (!this.abort.signal.aborted) this.error(errorText(error, this.ui.label, this.operationStage));
        }
        finally {
            this.busy = false;
            if (!this.abort.signal.aborted) {
                this.status(''); this.options.editor.removeAttribute('aria-busy'); this.options.editor.inert = false; this.mountHeaderActions(); this.drawer.flushFocus(); this.options.changed?.();
                if (succeeded && this.invalid && this.visible && !this.dirty) void this.run(() => this.refresh());
            }
        }
    }
    private navigationTarget(target: HTMLElement): string | undefined {
        if (target.dataset.board) return `/board/${encodeURIComponent(target.dataset.board)}`;
        const board = `/board/${encodeURIComponent(this.boardId)}`;
        if (target.dataset.item) return `${board}/${encodeURIComponent(target.dataset.item)}`;
        if (target.dataset.record) return `${board}/@record/${encodeURIComponent(target.dataset.record)}`;
        if (target.dataset.context) return board + (target.dataset.context === 'board' ? '' : '/@' + target.dataset.context);
    }
    private mountHeaderActions(): void {
        for (const [slot, release] of this.windowMounts) if (!this.options.editor.contains(slot)) {release(); this.windowMounts.delete(slot);}
        if (this.options.mountTitleBar) {
            for (const header of this.options.editor.querySelectorAll<HTMLElement>('[data-titlebar]')) if (!this.windowMounts.has(header)) this.mountTitleBar(header);
            return;
        }
        for (const slot of this.options.editor.querySelectorAll<HTMLElement>('[data-window-navigation]')) {
            if (!this.windowMounts.has(slot) && this.options.mountWindowList) this.windowMounts.set(slot, this.options.mountWindowList(slot));
        }
        for (const header of this.options.editor.querySelectorAll<HTMLElement>('[data-titlebar]')) if (!this.windowMounts.has(header)) this.mountDefaultTitleBar(header);
    }
    private mountDefaultTitleBar(header: HTMLElement): void {
        const back = header.querySelector<HTMLElement>('[data-titlebar-back]') ?? undefined;
        const title = header.querySelector<HTMLElement>('[data-titlebar-title]') ?? undefined;
        back?.classList.add('ui-nav-button'); header.querySelector('.kanban__menu > summary')?.classList.add('ui-nav-button');
        const view = mountSharedTitleBar(header, {
            title, back,
            leading: [...header.querySelectorAll<HTMLElement>('[data-navigation] > button')],
            trailing: [...header.querySelectorAll<HTMLElement>('[data-window-navigation]')],
            actions: [...header.querySelectorAll<HTMLElement>('.kanban__desktop-create, :scope > [data-action=new-board]')],
            menu: header.querySelector<HTMLElement>('.kanban__menu') ?? undefined,
        });
        view.element.dataset.titlebarSlot = ''; header.dataset.titlebarHost = 'true';
        view.update({title: title?.textContent ?? ''});
        this.windowMounts.set(header, () => {view.destroy(); delete header.dataset.titlebarHost;});
    }
    private mountTitleBar(header: HTMLElement): void {
        const slot = document.createElement('div'); slot.dataset.titlebarSlot = ''; header.prepend(slot); header.dataset.titlebarHost = 'true';
        const release = this.options.mountTitleBar!(slot, {
            title: header.querySelector<HTMLElement>('[data-titlebar-title]') ?? undefined,
            back: header.querySelector<HTMLElement>('[data-titlebar-back]') ?? undefined,
            menu: header.querySelector<HTMLElement>('.kanban__menu') ?? undefined,
            actions: [...header.querySelectorAll<HTMLElement>('.kanban__desktop-create, :scope > [data-action=new-board]')],
        });
        this.windowMounts.set(header, () => {release(); slot.remove(); delete header.dataset.titlebarHost;});
    }
    private closePanel(): void {this.dirty = false; this.itemId = ''; this.recordId = ''; this.item = undefined; this.drawer.close();}
    private async requestClose(explicit: boolean): Promise<void> {
        if (this.dirty && !explicit) throw new Error(this.ui.label('unsaved'));
        if (this.options.navigate && this.boardId) {
            if (this.dirty) this.closePanel();
            await this.options.navigate(`/board/${encodeURIComponent(this.boardId)}`); return;
        }
        this.closePanel(); this.options.selected(this.getActiveResourceId());
    }
    private alive(generation: number): boolean {return generation === this.generation && !this.abort.signal.aborted;}
    private content(): HTMLElement {return this.options.editor.querySelector('[data-content]')!;}
    private panel(): HTMLElement {return this.options.editor.querySelector('[data-panel]')!;}
    private status(message: string): void {this.options.editor.querySelector('[data-status]')!.textContent = message;}
    private error(message: string): void {
        const error = this.options.editor.querySelector<HTMLElement>('[data-error]')!; error.textContent = message; error.hidden = this.drawer?.open ?? false;
        const panelError = this.options.editor.querySelector('[data-panel-error]'); if (panelError) panelError.textContent = message;
        const executionError=this.options.editor.querySelector<HTMLElement>('[data-execution-error]');
        if(executionError) {
            executionError.textContent=message;executionError.hidden=!message;
            if(message) {const panel=this.panel(),bottom=executionError.getBoundingClientRect().bottom,edge=panel.getBoundingClientRect().bottom;if(bottom>edge) panel.scrollTop+=bottom-edge+12;}
        }
        this.options.editor.querySelector<HTMLElement>('[data-retry]')!.hidden = !message || (this.drawer?.open ?? false);
    }
}
function errorText(error: unknown, label: (key: string) => string, stage: string): string {
    const code = (error as {outcome?: string})?.outcome === 'unknown' ? 'WRITE_OUTCOME_UNKNOWN' : (error as {code?: unknown})?.code;
    if (code === 'REVISION_CONFLICT' || code === 'CURSOR_STALE') return label('conflict');
    if (error instanceof Error && error.message === label('unsaved')) return error.message;
    const safe = typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'KANBAN_OPERATION_FAILED';
    const translated = label('errors.' + safe);
    const details = safe === 'KANBAN_OPERATION_FAILED' ? failureDetails(error) : {};
    const diagnostic = details.errorName ? `\n${label('diagnostic')}: ${stage} · ${details.errorName}${details.source ? ' · ' + details.source : ''}` : '';
    return (translated !== 'kanban.errors.' + safe && translated !== 'errors.' + safe ? `${translated} (${safe})` : `${label('failed')}: ${safe}`) + diagnostic;
}

export async function mountKanban(container: HTMLElement, options: Omit<KanbanUIOptions, 'sidebar' | 'editor'>) {
    const sidebar = document.createElement('aside'), editor = document.createElement('main');
    container.classList.add('kanban-layout'); container.replaceChildren(sidebar, editor);
    const view = new KanbanWorkbench({...options, sidebar, editor}, container);
    await view.start();
    return view;
}
export {KanbanSuggestionPicker} from './suggestion-picker';
export type {SuggestionField} from './suggestion-field';
export type {KanbanUIOptions, KanbanPresentation} from './ports';
