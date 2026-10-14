import type { ConversationControls, EditorOptions, IEditor } from '@itookit/ui-common';
import type { ApplicationPort, ApplicationCapabilities } from '@itookit/app-contracts/application';
import { createApplicationWorkbench } from './workbench-adapter';
import { type ApplicationDraftStore } from './conversation-controls';

export interface ApplicationWorkspace { elementId: string; workspaceName: string; slug: string; type?: string; title: string }
export interface ApplicationPresentation {
    file(container: HTMLElement, options: EditorOptions): Promise<IEditor>;
    conversation(container: HTMLElement, controls: ConversationControls, options: EditorOptions): Promise<IEditor>;
}
export interface ApplicationView {
    start(): Promise<void>;
    open(id: string): Promise<void>;
    close(): Promise<void>;
    setVisible?(visible: boolean): void | Promise<void>;
}
export interface ApplicationViewContext { application: ApplicationPort; workspace: ApplicationWorkspace; sidebar: HTMLElement; editor: HTMLElement; presentation: ApplicationPresentation; drafts?: ApplicationDraftStore }
export interface ApplicationAppOptions {
    application: ApplicationPort;
    workspaces: readonly ApplicationWorkspace[];
    presentation: ApplicationPresentation;
    drafts?: ApplicationDraftStore;
    renderers?: Readonly<Record<string, (context: ApplicationViewContext) => ApplicationView>>;
    defaultSlug?: string;
    onProgress?(message: string): void;
}
export interface ApplicationHandle { navigate(slug: string, resourceId?: string): Promise<void>; destroy(): Promise<void> }

/** Renderers are application composition; adapters supply the same port locally or remotely. */
export async function initApplicationShell(options: ApplicationAppOptions): Promise<ApplicationHandle> {
    const shell = new ApplicationShell(options);
    try { await shell.start(); return shell; }
    catch (error) { await shell.destroy().catch(() => {}); throw error; }
}
class ApplicationShell implements ApplicationHandle {
    private readonly views = new Map<string, Promise<ApplicationView>>();
    private readonly listeners = new AbortController();
    private readonly renderers: Record<string, (context: ApplicationViewContext) => ApplicationView>;
    private workspaces: readonly ApplicationWorkspace[] = [];
    private currentId?: string;
    private revision = 0;
    private closing?: Promise<void>;
    constructor(private readonly options: ApplicationAppOptions) {
        this.renderers = { standard: createApplicationWorkbench, chat: createApplicationWorkbench, ...options.renderers };
    }
    async start(): Promise<void> {
        const capabilities = await this.options.application.query('capabilities', undefined);
        this.workspaces = this.options.workspaces.filter(workspace => supported(workspace, capabilities));
        bindApplicationNavigation(this.options, this.workspaces, (slug, id) => this.navigate(slug, id), this.listeners.signal);
        const [slug, ...resource] = location.hash.replace(/^#\/?/, '').split('/');
        await this.navigate(slug, resource.length ? decodeURIComponent(resource.join('/')) : undefined);
    }
    async navigate(slug: string, resourceId?: string): Promise<void> {
        if (this.closing) throw new Error('Application shell is closed');
        const revision = ++this.revision;
        const workspace = this.workspaces.find(item => item.slug === slug)
            ?? this.workspaces.find(item => item.slug === (this.options.defaultSlug ?? 'chat')) ?? this.workspaces[0];
        if (!workspace) throw new Error('No application workspace is available');
        this.currentId = workspace.elementId;
        this.showWorkspace(workspace);
        const view = await this.view(workspace);
        await view.setVisible?.(this.currentId === workspace.elementId);
        if (revision !== this.revision || this.closing) return;
        if (resourceId) await view.open(workspace.type === 'chat' && !resourceId.startsWith('session:') ? `session:${resourceId}` : resourceId);
    }
    private showWorkspace(workspace: ApplicationWorkspace): void {
        document.querySelectorAll<HTMLElement>('.workspace-view').forEach(view => view.classList.toggle('active', view.id === workspace.elementId));
        document.querySelectorAll<HTMLElement>('.app-nav-btn[data-target]').forEach(button => button.classList.toggle('active', button.dataset.target === workspace.elementId));
        for (const [id, view] of this.views) void view.then(ready => ready.setVisible?.(id === this.currentId)).catch(() => {});
    }
    private view(workspace: ApplicationWorkspace): Promise<ApplicationView> {
        let pending = this.views.get(workspace.elementId);
        if (!pending) {
            pending = mountApplicationView(this.options, workspace, this.renderers); this.views.set(workspace.elementId, pending);
            void pending.catch(() => { if (this.views.get(workspace.elementId) === pending) this.views.delete(workspace.elementId); });
        }
        return pending;
    }
    destroy(): Promise<void> {
        if (!this.closing) {
            this.listeners.abort(); this.revision++;
            this.closing = this.closeViews();
        }
        return this.closing;
    }
    private async closeViews(): Promise<void> {
        const ready = await Promise.allSettled(this.views.values());
        const results = await Promise.allSettled(ready.map(result => result.status === 'fulfilled' ? result.value.close() : undefined));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        await this.options.application.close().catch(error => errors.push(error)); this.views.clear();
        if (errors.length) throw new AggregateError(errors, 'Application cleanup failed');
    }
}
function supported(workspace: ApplicationWorkspace, capabilities: ApplicationCapabilities): boolean {
    return workspace.type === 'chat' || capabilities.workspaces.includes(workspace.workspaceName);
}
async function mountApplicationView(options: ApplicationAppOptions, workspace: ApplicationWorkspace,
    renderers: Record<string, (context: ApplicationViewContext) => ApplicationView>): Promise<ApplicationView> {
    const container = document.getElementById(workspace.elementId); if (!container) throw new Error('Workspace container is unavailable');
    const layout = document.createElement('div'); layout.className = 'mm-layout';
    const sidebar = document.createElement('div'); sidebar.className = 'mm-sidebar';
    const editor = document.createElement('div'); editor.className = 'mm-editor-area'; layout.append(sidebar, editor); container.replaceChildren(layout);
    const create = renderers[workspace.type ?? 'standard']; if (!create) throw new Error('Workspace renderer is unavailable');
    const view = create({ application: options.application, workspace, sidebar, editor, presentation: options.presentation, drafts: options.drafts });
    try { await view.start(); return view; } catch (error) { await view.close(); throw error; }
}
function bindApplicationNavigation(options: ApplicationAppOptions, workspaces: readonly ApplicationWorkspace[],
    navigate: ApplicationHandle['navigate'], signal: AbortSignal): void {
    for (const button of document.querySelectorAll<HTMLElement>('.app-nav-btn[data-target]')) {
        const workspace = workspaces.find(item => item.elementId === button.dataset.target);
        if (!workspace) { button.hidden = true; continue; }
        button.addEventListener('click', () => { location.hash = `/${workspace.slug}`; }, { signal });
    }
    window.addEventListener('hashchange', () => {
        const [slug, ...resource] = location.hash.replace(/^#\/?/, '').split('/');
        void navigate(slug, resource.length ? decodeURIComponent(resource.join('/')) : undefined).catch(error => options.onProgress?.(String(error)));
    }, { signal });
}
