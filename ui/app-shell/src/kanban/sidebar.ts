import {ACTION_ICONS, FILE_BROWSER_ICONS, createModuleLogger, randomUUID, t} from '@itookit/common';
import {kanbanReference, type KanbanBoardSummary, type KanbanClient} from '@itookit/kanban/contracts';
import {createVFSBrowser, type BrowserNode, type VFSBrowser} from '@itookit/vfs-ui';
import {nestOSVFSPresentation} from '../browser/vfs-presentation';
import {ViewRefresh} from '../lifecycle/view-refresh';

interface Options {
    container: HTMLElement; service?: KanbanClient;
    navigate(path: string): Promise<void>;
    create(): Promise<void>;
    report(error: unknown): void;
}
const log = createModuleLogger('kanban-sidebar');

/** One logical resource browser per workspace, independent of editor windows. */
export class KanbanSidebar {
    private readonly browser: VFSBrowser;
    private readonly refresh: ViewRefresh;
    private readonly status = document.createElement('p');
    private readonly list = document.createElement('div');
    private nodes: BrowserNode[] = [];
    private visible = true;
    private closed = false;
    private started = false;
    private selected = '';
    constructor(private readonly options: Options) {
        this.list.className = 'kanban-sidebar__list'; this.status.setAttribute('role', 'alert'); this.status.hidden = true;
        options.container.classList.add('kanban-sidebar'); options.container.append(this.status, this.list);
        this.browser = createVFSBrowser({container: this.list, title: t('kanban.title'), searchPlaceholder: t('kanban.search'),
            presentation: nestOSVFSPresentation, appearance: {showTimestamp: false}, selection: false, navigationHeader: {layout: 'inline'},
            toolbarOptions: {variant: 'plain', iconOnlyActions: ['create', 'refresh']},
            source: {get: async id => this.nodes.find(node => node.id === id), children: async parent => parent === null ? this.nodes : [], subscribe: () => () => {}},
            onActivate: node => {void options.navigate(node.id).catch(error => this.failure(error));}, onError: error => this.failure(error),
            actions: [
                {id: 'create', label: t('kanban.newBoard'), iconHTML: FILE_BROWSER_ICONS.addFile, placements: ['toolbar'], run: () => options.create()},
                {id: 'refresh', label: t('kanban.refresh'), iconHTML: ACTION_ICONS.refreshView, placements: ['toolbar'], run: () => this.reload()},
            ]});
        this.refresh = new ViewRefresh({visible: () => this.visible && !this.closed, run: () => this.load(), report: error => this.failure(error)});
    }
    async start(): Promise<void> {
        await this.reload(); if (this.closed) return;
        await this.browser.start(); this.started = true; this.select(this.selected);
    }
    select(path: string): void {
        this.selected = path.split('/').slice(0, 3).join('/');
        this.browser.select(this.nodes.some(node => node.id === this.selected) ? [this.selected] : []);
    }
    invalidate(): void {this.refresh.mark('kanban.committed');}
    setVisible(visible: boolean): void {
        this.visible = visible;
        if (!visible) this.refresh.pause(); else if (this.refresh.dirty) void this.refresh.flush();
    }
    destroy(): void {
        this.closed = true; void this.refresh.close(); this.browser.destroy(); this.status.remove(); this.list.remove();
        this.options.container.classList.remove('kanban-sidebar');
    }
    private reload(): Promise<void> {this.refresh.mark('manual', false); return this.refresh.flush();}
    private async load(): Promise<void> {
        const operationId = randomUUID(), started = performance.now();
        try {
            const boards = await this.options.service?.catalog() ?? [];
            if (this.closed || !this.visible) {this.refresh.mark('interrupted', false); return;}
            this.nodes = boards.map(nodeForBoard);
            if (this.started) await this.browser.refresh();
            if (this.closed) return;
            this.select(this.selected); this.status.hidden = true;
            log.debug('catalog.load', {operationId, stage: 'catalog', result: 'success', count: boards.length, durationMs: Math.round(performance.now() - started)});
        } catch (error) {
            const code = safeCode(error);
            log.warn('catalog.load', {operationId, stage: 'catalog', result: 'failure', code, durationMs: Math.round(performance.now() - started)});
            throw error;
        }
    }
    private failure(error: unknown): void {
        if (this.closed) return;
        const code = safeCode(error), key = `kanban.errors.${code}` as Parameters<typeof t>[0], message = t(key);
        this.status.textContent = message === key ? `${t('kanban.failed')} (${code})` : message; this.status.hidden = false;
        this.options.report(Object.assign(new Error(this.status.textContent!), {code}));
    }
}
function nodeForBoard(board: KanbanBoardSummary): BrowserNode {
    return {id: `/board/${encodeURIComponent(board.id)}`, parentId: null, kind: 'file', label: board.title,
        description: kanbanReference(board), icon: ACTION_ICONS.kanbanView, readOnly: true, fileDetails: false, titleLayout: 'stacked'};
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'KANBAN_NAVIGATION_FAILED';
}
