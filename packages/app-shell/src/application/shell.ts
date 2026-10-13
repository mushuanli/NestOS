import { createVFSBrowser, type VFSBrowser } from '@itookit/vfs-ui';
import { t, traceBoot } from '@itookit/common';
import type { ConversationControls, EditorOptions, IEditor } from '@itookit/ui-common';
import type { ApplicationPort, ApplicationCapabilities } from '@itookit/app-core/application/contracts';
import { ApplicationBrowserSource } from './browser-source';
import { ApplicationConversationControls, type ApplicationDraftStore } from './conversation-controls';

export interface ApplicationWorkspace { elementId: string; workspaceName: string; slug: string; type?: string; title: string }
export interface ApplicationPresentation {
    file(container: HTMLElement, options: { path: string; title: string; content: string; save(content: string): Promise<void> }): Promise<Pick<IEditor, 'destroy' | 'flushPendingSave'>>;
    conversation(container: HTMLElement, controls: ConversationControls, options: EditorOptions): Promise<Pick<IEditor, 'destroy' | 'flushPendingSave'>>;
}
export interface ApplicationView {
    start(): Promise<void>;
    open(id: string): Promise<void>;
    close(): Promise<void>;
    setVisible?(visible: boolean): void;
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

/** Workspace presentation depends on one capability port, with no execution-mode branches. */
class ApplicationWorkbench implements ApplicationView {
    private readonly source: ApplicationBrowserSource;
    private readonly browser: VFSBrowser;
    private editor?: Pick<IEditor, 'destroy' | 'flushPendingSave'>;
    private controls?: ApplicationConversationControls;
    private visible = true;
    private activeFolder: string | null = null;
    private navigation = Promise.resolve();
    private version = 0;
    private closed = false;
    constructor(private readonly context: ApplicationViewContext) {
        const { application, workspace, sidebar } = context;
        this.source = new ApplicationBrowserSource(application, workspace.type === 'chat' ? undefined : { kind: 'workspace', name: workspace.workspaceName });
        this.browser = createVFSBrowser({ container: sidebar, source: this.source, title: workspace.title,
            onActivate: node => { void this.open(node.id).catch(error => this.report(error)); }, onError: error => this.report(error) });
    }
    setVisible(visible: boolean): void { this.visible = visible; this.source.setVisible(visible); this.controls?.setVisible(visible); }
    async start(): Promise<void> {
        await traceBoot('application.sidebar', () => this.browser.start());
        if (this.context.workspace.type === 'chat') {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'workbench-root'; button.textContent = t('project.createSession');
            button.onclick = () => { void this.createConversation().catch(error => this.report(error)); }; this.context.sidebar.prepend(button);
        }
    }
    private async createConversation(): Promise<void> {
        const folder = this.browser.getSelection().find(node => node.kind === 'directory')?.id ?? this.activeFolder;
        const result = await this.context.application.command('createConversation', { title: t('project.createSession'), folder });
        await this.open(`session:${result.sessionId}`); await this.browser.refresh();
    }
    open(id: string): Promise<void> {
        const version = ++this.version;
        const work = this.navigation.catch(() => {}).then(async () => { if (!this.closed && version === this.version) await this.show(id); });
        this.navigation = work; return work;
    }
    private async show(id: string): Promise<void> {
        if (await this.source.activate(id)) return;
        const node = await this.source.get(id);
        if (node?.kind === 'directory') { this.activeFolder = id; this.browser.expand(id, true); return; }
        await this.editor?.flushPendingSave?.(); await this.editor?.destroy(); this.editor = undefined;
        const { application, presentation, workspace, editor } = this.context;
        const mount = document.createElement('div'); mount.style.height = '100%'; mount.style.width = '100%'; editor.replaceChildren(mount);
        if (id.startsWith('session:')) {
            const controls = new ApplicationConversationControls(application, id.slice(8), this.context.drafts);
            this.controls = controls; controls.setVisible(this.visible);
            try { this.editor = await presentation.conversation(mount, controls, { title: node?.label ?? '', target: { kind: 'session', sessionId: id.slice(8) } }); }
            catch (error) { await controls.close(); throw error; }
        } else {
            const identity = { kind: 'workspace' as const, name: workspace.workspaceName };
            const file = await application.query('file', { workspace: identity, path: id }); let revision = file.revision;
            const content = file.encoding === 'text' ? file.content : new TextDecoder().decode(Uint8Array.from(atob(file.content), char => char.charCodeAt(0)));
            this.editor = await presentation.file(mount, { path: id, title: node?.label ?? id, content,
                save: async value => { revision = (await application.command('saveFile', { workspace: identity, path: id, content: value, revision })).revision ?? revision; } });
        }
    }
    private report(error: unknown): void {
        console.warn('[Application] View operation failed', error);
        const status = document.createElement('p'); status.setAttribute('role', 'alert'); status.textContent = error instanceof Error ? error.message : String(error);
        this.context.editor.append(status);
    }
    async close(): Promise<void> {
        if (this.closed) return;
        await this.navigation.catch(() => {}); await this.editor?.flushPendingSave?.(); await this.editor?.destroy();
        this.closed = true; this.version++; this.browser.destroy(); this.source.close();
    }
}

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
        this.renderers = { standard: context => new ApplicationWorkbench(context), chat: context => new ApplicationWorkbench(context), ...options.renderers };
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
        view.setVisible?.(this.currentId === workspace.elementId);
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
