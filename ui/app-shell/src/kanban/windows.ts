import {KanbanWorkbench as KanbanView, type KanbanUIOptions} from '@itookit/kanban/ui';
import {executionSessionReference} from '@itookit/app-contracts';
import {ACTION_ICONS, createModuleLogger, randomUUID, t} from '@itookit/common';
import {WorkbenchTabs, type WorkbenchTab} from '../workbench/tabs';
import type {WorkbenchWindowBinding} from '../workbench/windows';
import {kanbanPresentation, kanbanReviewGuidance} from './host';
import {KanbanSidebar} from './sidebar';
import {VFS_DOM_EVENTS} from '@itookit/vfs-ui';

const log = createModuleLogger('kanban-windows');
export type KanbanWorkspaceOptions = Omit<KanbanUIOptions, 'presentation' | 'sidebar'> & {sidebar: HTMLElement; windows?: WorkbenchWindowBinding};
interface Page {view: KanbanView; ready: Promise<void>; visible?: boolean}

/** Each opened resource keeps its view, inspector, drafts and scroll in its own tab. */
export class KanbanWindowWorkbench {
    private readonly tabs: WorkbenchTabs<Page>;
    private readonly navigation: KanbanSidebar;
    private visible = true;
    private disposing = false;
    constructor(private readonly options: KanbanWorkspaceOptions) {
        this.tabs = new WorkbenchTabs(options.editor, {
            navigation: t('kanban.title'), activate: id => this.navigate(id),
            parent: tab => this.navigate(parentPath(tab.id)), canGoUp: tab => tab.id !== '/',
            dispose: tab => this.disposePage(tab), empty: () => this.showList(),
            error: error => this.report(error), changed: () => this.syncVisibility(),
        }, undefined, options.windows);
        this.navigation = new KanbanSidebar({container: options.sidebar, service: options.service, navigate: path => this.navigate(path), windowManagement: this.tabs.windowManagement,
            create: () => this.openBoardCreation(), report: error => this.report(error)});
        const host = document.createElement('div'); host.hidden = true; host.append(this.tabs.opened); options.sidebar.append(host);
    }
    async start(): Promise<void> {await Promise.all([this.navigation.start(), this.openResource(this.options.initialResource ?? '/')]);}
    async openResource(path: string): Promise<void> {
        if (this.disposing) return;
        const operationId = randomUUID(), started = performance.now();
        try {
            const tab = await this.tabs.open(path, t('kanban.title'), false);
            if (!tab.value) this.createPage(tab);
            await tab.value!.ready;
            const state = tab.value!.view.getViewState();
            if (!state.dirty && !state.busy && tab.value!.view.getActiveResourceId() !== tab.id) await tab.value!.view.openResource(tab.id);
            if (this.tabs.current === tab) {this.syncVisibility(); this.options.selected(tab.id);}
            log.debug('window.open', {operationId, stage: 'navigation', result: 'success', count: this.tabs.values().length, durationMs: Math.round(performance.now() - started)});
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.warn('window.open', {operationId, stage: 'navigation', result: 'failure',
                code: typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'KANBAN_WINDOW_FAILED', durationMs: Math.round(performance.now() - started)});
            this.report(error); throw error;
        }
    }
    getActiveResourceId(): string {return this.tabs.current?.id ?? '/';}
    invalidateFromEvents(): void {this.navigation.invalidate(); for (const tab of this.tabs.values()) tab.value?.view.invalidateFromEvents();}
    setVisible(visible: boolean): void {this.visible = visible; this.navigation.setVisible(visible); this.syncVisibility();}
    captureRecovery(): unknown {
        for (const tab of this.tabs.values()) tab.value?.view.captureRecovery();
        return this.tabs.captureRecovery();
    }
    restoreRecovery(state: unknown): void {if (state) this.tabs.restoreRecovery(state);}
    suspendForRecovery(): void {
        this.navigation.setVisible(false); this.tabs.suspendForRecovery();
        for (const tab of this.tabs.values()) tab.value?.view.suspendForRecovery();
    }
    async destroy(): Promise<void> {this.disposing = true; this.navigation.destroy(); await this.tabs.destroy(); this.options.sidebar.replaceChildren();}
    private createPage(tab: WorkbenchTab<Page>): void {
        const editor = document.createElement('div'); tab.panel.append(editor);
        const view = new KanbanView({...this.options, sidebar: undefined, editor, initialResource: tab.id,
            itemOperationsAvailable: (_board, item) => !!item.externalRefs?.some(ref => ref.system === "nestos-worktree"),
            presentation: kanbanPresentation, executionReference: executionSessionReference, reviewGuidance: this.options.reviewGuidance ?? kanbanReviewGuidance,
            navigate: path => this.navigate(path), changed: () => this.updatePage(tab),
            selected: () => this.updatePage(tab), committed: () => this.navigation.invalidate(),
            mountTitleBar: (container, parts) => this.tabs.mountTitleBar(container, parts),
        });
        tab.value = {view, ready: Promise.resolve()}; this.tabs.setIcon(tab.id, ACTION_ICONS.kanbanView);
        this.tabs.location(tab.id, tab.id); this.syncVisibility();
        tab.value.ready = view.start().then(() => this.updatePage(tab)).catch(error => {tab.failed = true; throw error;});
    }
    private updatePage(tab: WorkbenchTab<Page>): void {
        if (!tab.value || this.disposing) return;
        const {view} = tab.value, state = view.getViewState(), path = view.getActiveResourceId();
        const dirtyChanged = tab.dirty !== state.dirty, renamed = path !== tab.id && !this.tabs.get(path);
        tab.dirty = state.dirty;
        if (renamed) this.tabs.rename(tab.id, path, state.title ?? t('kanban.title'));
        this.tabs.title(tab.id, state.title ?? t('kanban.title')); this.tabs.context(tab.id, state.context); this.tabs.location(tab.id, path);
        if (dirtyChanged) this.tabs.keep(tab.id);
        if (this.tabs.current === tab) {this.navigation.select(tab.id); if (renamed) this.options.selected(tab.id);}
    }
    private syncVisibility(): void {
        if (!this.tabs) return;
        this.navigation?.select(this.tabs.current?.id ?? '/');
        for (const tab of this.tabs.values()) {
            const page = tab.value; if (!page) continue;
            const visible = this.visible && this.tabs.current === tab;
            if (page.visible !== visible) {page.visible = visible; page.view.setVisible(visible);}
        }
    }
    private async disposePage(tab: WorkbenchTab<Page>): Promise<void> {
        if (!this.disposing) tab.value?.view.captureRecovery();
        await tab.value?.view.destroy();
    }
    private async openBoardCreation(): Promise<void> {
        await this.navigate('/');
        const page = this.tabs.current?.value; if (!page || this.disposing) return;
        await page.ready; await page.view.createBoard();
        this.options.sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}));
    }
    private navigate(path: string): Promise<void> {return this.options.windows?.navigate(path) ?? this.openResource(path);}
    private showList(): void {
        const layout = this.options.sidebar.closest<HTMLElement>('.mm-layout'); if (layout) layout.dataset.mobileView = 'list';
    }
    private report(error: unknown): void {this.options.windows?.registry.report(error);}
}
function parentPath(path: string): string {
    const parts = path.split('/'); return parts.length > 3 ? parts.slice(0, 3).join('/') : '/';
}
