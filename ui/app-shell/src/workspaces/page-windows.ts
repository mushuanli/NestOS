import {createModuleLogger, randomUUID} from '@itookit/common';
import {WorkbenchSidebar} from '../workbench/sidebar';
import {WorkbenchTabs, type WorkbenchTab} from '../workbench/tabs';
import type {WorkbenchWindowBinding} from '../workbench/windows';
import {createWorkspaceModule, type WorkspaceHandle} from './module';

interface Page {controller: WorkspaceHandle; sidebar: HTMLElement; ready: Promise<void>; mounted: boolean}
interface Options {
    sidebar: HTMLElement; editor: HTMLElement; title: string; initialResource?: string;
    windows?: WorkbenchWindowBinding;
    selected(path: string): void;
    titleFor?(path: string): string;
    create(host: {sidebar: HTMLElement; editor: HTMLElement; selected(path: string): void}): WorkspaceHandle;
}
const log = createModuleLogger('page-windows');

/** Adapts independent page controllers to the shared window and sidebar lifecycle. */
export class PageWindows {
    private readonly tabs: WorkbenchTabs<Page>;
    private readonly sidebar: WorkbenchSidebar;
    private visible = true;
    private disposing = false;
    private readonly recovered = new Map<string, unknown>();
    private readonly aliases = new Map<string, string>();
    constructor(private readonly options: Options) {
        this.tabs = new WorkbenchTabs(options.editor, {navigation: options.title,
            activate: path => options.windows?.navigate(path) ?? this.openResource(path),
            dispose: async tab => {if (!this.disposing) tab.value?.controller.captureRecovery?.(); await tab.value?.controller.destroy(); tab.value?.sidebar.remove();},
            empty: () => {const layout = options.sidebar.closest<HTMLElement>('.mm-layout'); if (layout) layout.dataset.mobileView = 'list';},
            error: error => options.windows?.registry.report(error), changed: () => this.syncVisibility(),
        }, undefined, options.windows);
        this.sidebar = new WorkbenchSidebar(options.sidebar, this.tabs.opened, undefined, options.title,
            this.tabs.windowManagement);
    }
    start(): Promise<void> {return this.openResource(this.options.initialResource ?? '/');}
    async openResource(path: string): Promise<void> {
        if (this.disposing) return;
        const started = performance.now(), operationId = randomUUID();
        try {
            const alias = this.aliases.get(path), id = alias && this.tabs.get(alias) ? alias : path;
            const tab = await this.tabs.open(id, this.options.titleFor?.(path) ?? this.options.title, false);
            if (!tab.value) this.createPage(tab, path);
            await tab.value!.ready; this.syncVisibility();
            if (this.tabs.current === tab) this.options.selected(tab.value!.controller.getActiveResourceId() ?? tab.id);
            log.debug('page.open', {operationId, stage: 'mount', result: 'success', count: this.tabs.values().length, durationMs: Math.round(performance.now() - started)});
        } catch (error) {
            log.warn('page.open', {operationId, stage: 'mount', result: 'failure', code: 'WORKSPACE_PAGE_OPEN_FAILED', durationMs: Math.round(performance.now() - started)});
            this.options.windows?.registry.report(error); throw error;
        }
    }
    private createPage(tab: WorkbenchTab<Page>, path: string): void {
        const sidebar = document.createElement('div'), editor = document.createElement('div');
        sidebar.className = 'workbench-page-navigation'; editor.className = 'workbench-page';
        this.sidebar.navigation.append(sidebar); tab.panel.append(editor);
        const controller = this.options.create({sidebar, editor, selected: resource => this.update(tab, resource)});
        tab.value = {controller, sidebar, ready: Promise.resolve(), mounted: false}; this.syncVisibility();
        tab.value.ready = controller.start().then(async () => {
            if (path !== '/') await controller.openResource(path);
            if (this.recovered.has(path)) {controller.restoreRecovery?.(this.recovered.get(path)); this.recovered.delete(path);}
            tab.value!.mounted = true;
            this.update(tab, controller.getActiveResourceId() ?? path);
            if (path !== tab.id) this.aliases.set(path, tab.id);
        }).catch(error => {tab.failed = true; throw error;});
    }
    private update(tab: WorkbenchTab<Page>, path: string): void {
        if (this.disposing || !tab.value?.mounted) return;
        if (path !== tab.id && !this.tabs.get(path)) this.tabs.rename(tab.id, path, this.options.titleFor?.(path) ?? this.options.title);
        this.tabs.title(tab.id, this.options.titleFor?.(path) ?? this.options.title); this.tabs.location(tab.id, path);
        if (this.tabs.current === tab) this.options.selected(path);
    }
    private syncVisibility(): void {
        if (!this.tabs) return;
        for (const tab of this.tabs.values()) if (tab.value) {
            const active = this.tabs.current === tab; tab.value.sidebar.hidden = !active;
            tab.value.controller.setVisible?.(this.visible && active);
        }
    }
    getActiveResourceId(): string {return this.tabs.current?.value?.controller.getActiveResourceId() ?? '/';}
    setVisible(visible: boolean): void {this.visible = visible; this.syncVisibility();}
    invalidateFromEvents(): void {for (const tab of this.tabs.values()) tab.value?.controller.invalidateFromEvents?.();}
    captureRecovery(): unknown {
        const pages = this.tabs.values().map(tab => ({id: tab.id, state: tab.value?.controller.captureRecovery?.()}));
        return {pages, tabs: this.tabs.snapshot()};
    }
    restoreRecovery(value: unknown): void {
        const state = value as {pages?: Array<{id: string; state?: unknown}>; tabs?: ReturnType<WorkbenchTabs<Page>['snapshot']>} | null;
        if (state?.tabs) this.tabs.restoreRecovery({tabs: state.tabs, editors: new Map()});
        for (const page of state?.pages ?? []) {
            const controller = this.tabs.get(page.id)?.value?.controller;
            if (controller) controller.restoreRecovery?.(page.state); else this.recovered.set(page.id, page.state);
        }
    }
    suspendForRecovery(): void {for (const tab of this.tabs.values()) tab.value?.controller.suspendForRecovery?.();}
    async destroy(): Promise<void> {this.disposing = true; await this.tabs.destroy(); this.sidebar.destroy();}
}
export function createPageWindows(options: Options) {return createWorkspaceModule(new PageWindows(options));}
