import { Drawer, createVFSBrowser, createDeleteOperation, describeErrorReason, type VFSBrowser, type BrowserNode, type BrowserAction } from '@itookit/vfs-ui';
import { FILE_BROWSER_ICONS, TOOLBOX_ICONS, createModuleLogger, randomUUID, t, type NavigationRequest } from '@itookit/common';
import { toolboxPath, ungroupedId } from '@itookit/app-contracts';
import type { ApplicationBackend } from '@itookit/app-contracts/services';
import type { EditorOptions } from '@itookit/ui-common';
import { lazyResource } from '../lifecycle/lazy-resource';
import { showNameDialog } from '../files/project-dialog';
import { nestOSVFSPresentation } from '../browser/vfs-presentation';
import { DrawerActions } from '../toolbox/DrawerActions';

interface AgentEntry { id: string; name: string; description?: string; source?: string; path?: string; remote?: boolean; group?: string }
interface Options {
    backend: Pick<ApplicationBackend, 'toolboxView'>;
    resourceId(id: string): string | undefined;
    navigate(request: NavigationRequest): Promise<void>;
    start(id: string): Promise<void>;
    edit?(id: string): Promise<void>;
    rename?(id: string, name: string): Promise<void>;
    remove?(id: string): Promise<void>;
    usage?: EditorOptions['executorUsage'];
}
const log = createModuleLogger('agent-drawer');

/** Host actions share the browser's selection, menus and batch operation lifecycle. */
export class AgentDrawer {
    private readonly drawer: Drawer;
    readonly element: HTMLElement;
    private readonly rows = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly abort = new AbortController();
    private readonly view;
    private browser?: VFSBrowser;
    private readonly cleanups: Array<() => void> = [];
    private entries: AgentEntry[] = [];
    private expanded = false;
    private visible = true;
    private dirty = true;
    private loading = false;
    private loaded = false;
    private pendingAction = false;
    constructor(private readonly options: Options) {
        this.view = lazyResource(async () => {
            const view = await options.backend.toolboxView();
            if (!this.abort.signal.aborted) this.cleanups.push(view.resources.subscribe(() => this.invalidate()));
            return view;
        }, view => view.dispose());
        this.drawer = new Drawer({title: t('toolbox.agents'), showHeader: false, collapsible: false});
        this.element = this.drawer.element; this.element.classList.add('workbench-agents');
        this.rows.className = 'workbench-agents__list'; this.status.className = 'workbench-agents__status';
        this.status.setAttribute('role', 'status'); this.drawer.content.append(this.status, this.rows);
        const stop = options.usage?.subscribe?.(() => {void this.browser?.refresh();}); if (stop) this.cleanups.push(stop);
    }
    setExpanded(expanded: boolean): void {this.expanded = expanded; if (expanded) void this.refresh();}
    setVisible(visible: boolean): void {this.visible = visible; if (visible && this.expanded) void this.refresh();}
    private invalidate(): void {this.dirty = true; if (this.visible && this.expanded) void this.refresh();}
    private async refresh(): Promise<void> {
        if (this.loading || !this.dirty || !this.visible || !this.expanded || this.abort.signal.aborted) return;
        this.loading = true; this.dirty = false; this.status.textContent = t('status.loading');
        let succeeded = false;
        try {
            const view = await this.view.get();
            if (this.loaded) await view.resources.navigation();
            const agents = await view.resources.getAgents();
            if (this.abort.signal.aborted || !this.expanded || !this.visible) {this.dirty = true; return;}
            this.entries = agents.map(agent => ({id: agent.id, name: agent.name, description: agent.description,
                path: this.options.resourceId(agent.id) ? toolboxPath('agents', this.options.resourceId(agent.id)!) : undefined}));
            for (const agent of this.entries) if (agent.path) {
                const group = view.resources.drawers.forPath(agent.path);
                agent.group = group?.id !== ungroupedId('agents') ? group?.name : undefined;
            }
            this.entries.push(...[...view.inventory.remoteAgents.values()].map(agent => ({id: agent.id, name: agent.name,
                description: agent.description, source: agent.source, remote: true,
                path: toolboxPath('agents', '/@remote/' + encodeURIComponent(agent.id) + '.agent')})));
            await this.render(); this.status.textContent = ''; succeeded = this.loaded = true;
        } catch (error) {this.dirty = true; this.report(error);}
        finally {this.loading = false; if (succeeded && this.dirty) void this.refresh();}
    }
    private node(agent: AgentEntry): BrowserNode {
        return {id: agent.id, label: agent.name, parentId: null, kind: 'file', icon: TOOLBOX_ICONS.agents,
            description: [agent.group, agent.description, agent.source].filter(Boolean).join(' · '),
            tags: agent.group ? [agent.group] : [],
            modifiedAt: this.options.usage?.lastUsed(agent.id) ?? 0, readOnly: agent.remote};
    }
    private async render(): Promise<void> {
        if (this.abort.signal.aborted) return;
        if (this.browser) {await this.browser.refresh(); return;}
        this.browser = createVFSBrowser({container: this.rows, title: t('toolbox.agents'), presentation: nestOSVFSPresentation,
            searchPlaceholder: t('workbench.findAgents'),
            appearance: {showTitle: false, showTimestamp: false, menuVisibility: 'always'},
            sort: {by: 'lastModified', direction: 'desc'}, selection: true,
            source: {children: async parent => parent === null ? this.entries.map(agent => this.node(agent)) : [],
                get: async id => {const agent = this.entries.find(entry => entry.id === id); return agent ? this.node(agent) : undefined;},
                subscribe: () => () => {}}, actions: this.actions(), onError: error => this.report(error),
            onActivate: node => {const agent = this.entries.find(entry => entry.id === node.id);
                if (agent) void this.activate(agent);},
        });
        await this.browser.start();
    }
    private actions(): BrowserAction[] {
        const toolbar = (id: string, label: string, run: () => Promise<void>, iconHTML?: string): BrowserAction =>
            ({id, label, iconHTML, placements: ['toolbar'], run});
        return [toolbar('create-agent', t('workbench.createAgent'), () => this.create()),
            toolbar('refresh-agents', t('workbench.refresh'), async () => {this.dirty = true; await this.refresh();}, FILE_BROWSER_ICONS.refresh),
            this.menu('configure-agent', t('workbench.configureAgent'), agent => this.configure(agent)),
            ...(this.options.rename ? [this.menu('rename-agent', t('action.rename'), agent => this.rename(agent), true)] : []),
            ...(this.options.remove ? [this.menu('delete-agent', t('action.delete'), agent => this.remove([agent.id]), true)] : []),
            this.batch('bulk-delete', t('action.delete'), ids => this.remove(ids), !!this.options.remove),
            this.batch('bulk-move', t('toolbox.moveDrawer'), ids => this.move(ids)),
            this.menu('move-agent', t('toolbox.moveDrawer'), agent => this.move([agent.id]), true)];
    }
    private menu(id: string, label: string, run: (agent: AgentEntry) => Promise<void>, local = false): BrowserAction {
        return {id, label, placements: ['menu'], state: ({target}) => {const agent = this.entries.find(entry => entry.id === target?.id);
            return {visible: !!agent && (!local || !agent.remote), enabled: !!agent?.path && !this.pendingAction};},
            run: async ({target}) => {const agent = this.entries.find(entry => entry.id === target?.id); if (agent) await run(agent);}};
    }
    private batch(id: string, label: string, run: (ids: string[]) => Promise<void>, enabled = true): BrowserAction {
        return {id, label, placements: ['selection'], state: ({selection}) => ({visible: enabled,
            enabled: !this.pendingAction && selection.length > 0 && selection.every(node => this.entries.some(agent => agent.id === node.id && !agent.remote && !!agent.path))}),
            run: async ({selection}) => run(selection.map(node => node.id))};
    }
    private async local(ids: readonly string[]): Promise<AgentEntry[]> {
        const started = Date.now();
        const view = await this.view.get(), current = new Set((await view.resources.getAgents()).map(agent => agent.id));
        const entries = ids.map(id => this.entries.find(entry => entry.id === id));
        if (!ids.length || entries.some(agent => !agent || agent.remote || !agent.path || !current.has(agent.id))) {
            log.warn('agent.manage', {operationId: randomUUID(), stage: 'catalog.validate', result: 'failure',
                count: ids.length, code: 'AGENT_SELECTION_UNAVAILABLE', durationMs: Date.now() - started});
            throw Object.assign(new Error(t('workbench.agentSelectionChanged')), {code: 'AGENT_SELECTION_UNAVAILABLE'});
        }
        return entries as AgentEntry[];
    }
    private async remove(ids: string[]): Promise<void> {
        const remove = createDeleteOperation<string[]>({resolve: async ids => {
            await this.local(ids);
            return {resources: [{ids, remove: async (selected, signal) => {
                for (const id of selected) {if (signal.aborted) return 'cancelled'; await this.options.remove!(id);}
                return 'completed';
            }}]};
        }, confirm: () => Promise.resolve(confirm(t('workbench.deleteAgentsHint', {count: ids.length}))),
        completed: () => this.browser?.setSelectionMode(false)});
        await this.mutate(ids.length, 'delete', () => remove(ids, this.abort.signal));
    }
    private async move(ids: string[]): Promise<void> {
        const entries = await this.local(ids), view = await this.view.get();
        const actions = new DrawerActions({groups: view.resources.drawers, signal: this.abort.signal,
            refresh: () => this.invalidate(), title: path => this.entries.find(agent => agent.path === path)?.name ?? path,
            create: async () => {await this.create();}});
        await this.mutate(ids.length, 'move', () => actions.moveSelection('agents', entries.map(agent => agent.path!), async () => {await this.local(ids);}));
    }
    private async rename(agent: AgentEntry): Promise<void> {
        await showNameDialog(t('action.rename'), t('workbench.name'), this.abort.signal,
            name => this.mutate(1, 'rename', async () => {await this.local([agent.id]); await this.options.rename!(agent.id, name);}),
            undefined, {initialName: agent.name});
    }
    private async mutate(count: number, operation: string, run: () => Promise<unknown>): Promise<void> {
        if (this.pendingAction || this.abort.signal.aborted) return;
        const started = Date.now(), operationId = randomUUID(); this.pendingAction = true;
        try {const result = await run(); log.info('agent.manage', {operationId, operation, count, stage: 'persist', result: result === 'cancelled' ? 'cancelled' : 'success', durationMs: Date.now() - started});}
        catch (error) {
            const code = (error as {code?: string})?.code;
            log.warn('agent.manage', {operationId, operation, count, stage: 'persist', result: 'failure',
                code: code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'AGENT_UPDATE_FAILED', durationMs: Date.now() - started});
            throw error;
        } finally {this.pendingAction = false; this.dirty = true; await this.refresh();}
    }
    private report(error: unknown): void {if (!this.abort.signal.aborted) this.status.textContent = describeErrorReason(error);}
    private async activate(agent: AgentEntry): Promise<void> {
        if (this.pendingAction || this.abort.signal.aborted) return;
        this.pendingAction = true;
        try {await (agent.remote ? this.configure(agent) : this.options.start(agent.id));}
        catch (error) {this.report(error);}
        finally {this.pendingAction = false;}
    }
    private configure(agent: AgentEntry): Promise<void> {
        return this.options.edit ? this.options.edit(agent.id) : this.options.navigate({target: 'toolbox', resourceId: agent.path ?? '/agents'});
    }
    private async create(): Promise<void> {
        await showNameDialog(t('workbench.createAgent'), t('workbench.name'), this.abort.signal, async name => {
            const view = await this.view.get(); if (this.abort.signal.aborted) return;
            const path = await view.resources.create('agents', name); if (this.abort.signal.aborted) return;
            if (this.options.edit) {
                const agent = (await view.resources.getAgents()).find(item => toolboxPath('agents', this.options.resourceId(item.id) ?? '') === path);
                if (!agent) throw new Error(t('toolbox.unavailable')); await this.options.edit(agent.id);
            } else await this.options.navigate({target: 'toolbox', resourceId: path});
        });
    }
    async destroy(): Promise<void> {
        this.abort.abort(); const errors: unknown[] = [];
        try {this.browser?.destroy();} catch (error) {errors.push(error);}
        for (const close of this.cleanups.splice(0)) {try {close();} catch (error) {errors.push(error);}}
        try {this.drawer.destroy();} catch (error) {errors.push(error);}
        try {await this.view.close();} catch (error) {errors.push(error);}
        if (errors.length) throw new AggregateError(errors, 'Agent drawer cleanup failed');
    }
}
