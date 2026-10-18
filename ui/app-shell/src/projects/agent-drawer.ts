import { Drawer, describeErrorReason } from '@itookit/vfs-ui';
import { FILE_BROWSER_ICONS, TOOLBOX_ICONS, t, type NavigationRequest } from '@itookit/common';
import { toolboxPath } from '@itookit/app-contracts';
import type { ApplicationBackend } from '@itookit/app-contracts/services';
import type { EditorOptions } from '@itookit/ui-common';
import { lazyResource } from '../lifecycle/lazy-resource';
import { showNameDialog } from '../files/project-dialog';
import { decorateButton } from '../workbench/controls';

interface AgentEntry { id: string; name: string; description?: string; source?: string; path?: string; remote?: boolean }
interface Options {
    backend: Pick<ApplicationBackend, 'toolboxView'>;
    resourceId(id: string): string | undefined;
    navigate(request: NavigationRequest): Promise<void>;
    start(id: string): Promise<void>;
    edit?(id: string): Promise<void>;
    usage?: EditorOptions['executorUsage'];
}

/** A lazy launch surface; configuration persistence stays in the existing host services. */
export class AgentDrawer {
    private readonly drawer: Drawer;
    readonly element: HTMLElement;
    private readonly rows = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly abort = new AbortController();
    private readonly view;
    private readonly cleanups: Array<() => void> = [];
    private entries: AgentEntry[] = [];
    private query = '';
    private expanded = false;
    private visible = true;
    private dirty = true;
    private loading = false;
    private pendingAction = false;
    private loaded = false;
    constructor(private readonly options: Options) {
        this.view = lazyResource(async () => {
            const view = await options.backend.toolboxView();
            if (!this.abort.signal.aborted) this.cleanups.push(view.resources.subscribe(() => this.invalidate()));
            return view;
        }, view => view.dispose());
        this.drawer = new Drawer({title: t('toolbox.agents'), showHeader: false, collapsible: false,
            search: {label: t('workbench.findAgents'), onChange: query => {this.query = query; this.render();}}});
        this.element = this.drawer.element; this.element.classList.add('workbench-agents');
        const create = this.button(t('workbench.createAgent'), FILE_BROWSER_ICONS.addFile, () => this.create());
        const refresh = this.button(t('workbench.refresh'), FILE_BROWSER_ICONS.refresh, async () => {this.dirty = true; await this.refresh();}, true);
        create.dataset.action = 'create-agent'; this.status.setAttribute('role', 'status');
        const toolbar = document.createElement('div'); toolbar.className = 'workbench-agents__toolbar'; toolbar.append(create, refresh);
        this.rows.className = 'workbench-agents__list'; this.status.className = 'workbench-agents__status';
        this.drawer.content.append(toolbar, this.status, this.rows);
        const stop = options.usage?.subscribe?.(() => this.render()); if (stop) this.cleanups.push(stop);
    }
    setExpanded(expanded: boolean): void { this.expanded = expanded; if (expanded) void this.refresh(); }
    setVisible(visible: boolean): void { this.visible = visible; if (visible && this.expanded) void this.refresh(); }
    private invalidate(): void { this.dirty = true; if (this.visible && this.expanded) void this.refresh(); }
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
            this.entries.push(...[...view.inventory.remoteAgents.values()].map(agent => ({id: agent.id, name: agent.name,
                description: agent.description, source: agent.source, remote: true,
                path: toolboxPath('agents', '/@remote/' + encodeURIComponent(agent.id) + '.agent')})));
            this.status.textContent = ''; succeeded = this.loaded = true;
        } catch (error) {
            this.dirty = true;
            if (!this.abort.signal.aborted) this.status.textContent = describeErrorReason(error);
        } finally {
            this.loading = false;
            if (!this.abort.signal.aborted) this.render();
            if (succeeded && this.dirty) void this.refresh();
        }
    }
    private render(): void {
        if (this.abort.signal.aborted) return;
        const query = this.query.trim().toLocaleLowerCase();
        const entries = this.entries.filter(agent => [agent.name, agent.description, agent.source].join('\n').toLocaleLowerCase().includes(query));
        entries.sort((a, b) => (this.options.usage?.lastUsed(b.id) ?? 0) - (this.options.usage?.lastUsed(a.id) ?? 0) || a.name.localeCompare(b.name));
        this.rows.replaceChildren(...entries.map(agent => this.row(agent)));
        if (!entries.length && !this.loading) this.rows.textContent = t('workbench.noAgents');
    }
    private row(agent: AgentEntry): HTMLElement {
        const row = document.createElement('div'); row.className = 'workbench-agents__row'; row.dataset.agentId = agent.id;
        const primary = this.button(agent.name, TOOLBOX_ICONS.agents,
            () => agent.remote ? this.configure(agent) : this.options.start(agent.id));
        primary.className = 'workbench-agents__launch'; primary.title = t(agent.remote ? 'workbench.agentDetails' : 'workbench.startWithAgent', {name: agent.name});
        primary.setAttribute('aria-label', primary.title);
        const text = primary.lastElementChild!;
        const name = document.createElement('span'); name.textContent = agent.name; text.replaceChildren(name);
        if (agent.description) {const description = document.createElement('small'); description.textContent = agent.description; text.append(description);}
        const configure = this.button(t('chatInput.configureAgent'), FILE_BROWSER_ICONS.more, () => this.configure(agent), true);
        configure.disabled = !agent.path; row.append(primary, configure); return row;
    }
    private configure(agent: AgentEntry): Promise<void> {
        if (this.options.edit) return this.options.edit(agent.id);
        return this.options.navigate({target: 'toolbox', resourceId: agent.path ?? '/agents'});
    }
    private button(label: string, icon: string, run: () => Promise<void>, iconOnly = false): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; decorateButton(button, icon, label, iconOnly);
        button.onclick = () => {
            if (this.abort.signal.aborted || button.disabled || this.pendingAction) return;
            button.disabled = true; this.pendingAction = true;
            void run().catch(error => {if (!this.abort.signal.aborted) this.status.textContent = describeErrorReason(error);})
                .finally(() => {this.pendingAction = false; if (!this.abort.signal.aborted) button.disabled = false;});
        };
        return button;
    }
    private async create(): Promise<void> {
        await showNameDialog(t('workbench.createAgent'), t('workbench.name'), this.abort.signal, async name => {
            const view = await this.view.get();
            if (this.abort.signal.aborted) return;
            const path = await view.resources.create('agents', name);
            if (this.abort.signal.aborted) return;
            if (this.options.edit) {
                const agent = (await view.resources.getAgents()).find(item => toolboxPath('agents', this.options.resourceId(item.id) ?? '') === path);
                if (!agent) throw new Error(t('toolbox.unavailable'));
                await this.options.edit(agent.id);
            } else await this.options.navigate({target: 'toolbox', resourceId: path});
        });
    }
    async destroy(): Promise<void> {
        this.abort.abort(); const errors: unknown[] = [];
        for (const close of this.cleanups.splice(0)) {try {close();} catch (error) {errors.push(error);}}
        try {this.drawer.destroy();} catch (error) {errors.push(error);}
        try {await this.view.close();} catch (error) {errors.push(error);}
        if (errors.length) throw new AggregateError(errors, 'Agent drawer cleanup failed');
    }
}
