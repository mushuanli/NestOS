import { createModuleLogger, randomUUID, t, type NavigationRequest } from '@itookit/common';
import type { ToolboxInventory, ToolboxResources } from '@itookit/app-contracts/services';
import type { EditorFactory, EditorOptions, IEditor } from '@itookit/ui-common';
import { toolboxKind, toolboxSourcePath } from './routes';

const log = createModuleLogger('toolbox-create-setup');
type ModelKind = 'providers' | 'connections';
interface SetupOptions {
    factories: Record<ModelKind, EditorFactory>; resources: ToolboxResources; inventory: ToolboxInventory;
    navigate(request: NavigationRequest): Promise<void>;
    requestDelete?: NonNullable<EditorOptions['hostContext']>['requestDelete'];
    done(discardResult?: boolean): Promise<void>; signal: AbortSignal;
}
export interface CreationModelSetup { flush(): Promise<void>; dispose(): Promise<void> }

/** The creation dialog hosts existing settings editors without changing their normal pages. */
class ModelSetup implements CreationModelSetup {
    private readonly editorRoot = document.createElement('div');
    private readonly summary = document.createElement('section');
    private readonly list = document.createElement('div');
    private readonly status = document.createElement('p');
    private readonly connectionForm = document.createElement('form');
    private readonly connectionName = document.createElement('input');
    private readonly create = document.createElement('button');
    private readonly back = document.createElement('button');
    private readonly complete = document.createElement('button');
    private readonly operationId = randomUUID();
    private editor?: IEditor;
    private editorMount?: HTMLElement;
    private currentPath = '';
    private originalPath = '';
    private providerId?: string;
    private pendingConnection = '';
    private connectionStage = 'connection-save';
    private busy = false;
    private disposed = false;
    private stop?: () => void;
    private refreshGeneration = 0;

    constructor(private readonly container: HTMLElement, private readonly options: SetupOptions) {}

    async start(path: string): Promise<void> {
        if (this.container.closest('form')) throw new Error('Model setup must be mounted outside the creation form');
        if (this.options.signal.aborted) { this.disposed = true; return; }
        this.originalPath = path; this.build();
        try {
            await this.mount(path);
            if (this.disposed || this.options.signal.aborted) return;
            this.stop = this.options.resources.subscribe(() => { void this.refreshSummary(); });
            await this.refreshSummary();
        } catch (error) { await this.dispose(); throw error; }
    }

    private build(): void {
        this.container.classList.add('toolbox-create__setup');
        this.editorRoot.className = 'toolbox-create__setup-editor'; this.summary.className = 'toolbox-create__setup-connections'; this.list.className = 'toolbox-create__setup-list';
        const heading = document.createElement('h2'); heading.textContent = t('toolbox.setupTitle');
        this.status.setAttribute('role', 'alert');
        this.back.type = 'button'; this.back.textContent = t('toolbox.setupBackToProvider');
        this.back.className = 'settings-btn settings-btn--secondary';
        this.back.onclick = () => { void this.run('navigation', async () => { await this.mount('/providers/' + encodeURIComponent(this.providerId!)); }); };
        this.create.type = 'button'; this.create.dataset.action = 'setup-create-connection'; this.create.textContent = t('toolbox.setupCreateConnection');
        this.create.className = 'settings-btn settings-btn--secondary';
        this.create.onclick = () => { void this.run('save', async () => { await this.flush(); this.connectionForm.hidden = false; this.connectionName.focus(); }); };
        this.complete.type = 'button'; this.complete.dataset.action = 'complete-setup'; this.complete.textContent = t('toolbox.setupDone');
        this.complete.className = 'settings-btn settings-btn--primary';
        this.complete.onclick = () => { void this.run('completion', this.options.done); };
        const actions = document.createElement('div'); actions.className = 'project-dialog__actions'; actions.append(this.back, this.create, this.complete);
        this.buildConnectionForm(); this.summary.append(this.list);
        const content = document.createElement('div'); content.className = 'toolbox-create__setup-content';
        content.append(this.editorRoot, this.summary, this.connectionForm, this.status);
        this.container.replaceChildren(heading, content, actions);
    }

    private buildConnectionForm(): void {
        this.connectionForm.hidden = true; this.connectionForm.className = 'toolbox-create__connection-form';
        const label = document.createElement('label'); label.textContent = t('toolbox.setupConnectionName');
        this.connectionName.name = 'connectionName'; this.connectionName.required = true; label.append(this.connectionName);
        const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = t('project.createConfirm');
        submit.className = 'settings-btn settings-btn--primary';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('project.cancel');
        cancel.className = 'settings-btn settings-btn--secondary';
        cancel.onclick = () => { this.connectionForm.hidden = true; };
        this.connectionForm.append(label, cancel, submit);
        this.connectionName.oninput = () => this.connectionName.setCustomValidity('');
        this.connectionForm.onsubmit = event => {
            event.preventDefault(); this.connectionName.setCustomValidity(this.connectionName.value.trim() ? '' : t('settings.autosave.invalid'));
            if (this.connectionForm.reportValidity()) void this.run('connection-create', () => this.createConnection());
        };
    }

    private editorOptions(kind: ModelKind, id: string): EditorOptions {
        const source = this.options.resources.sources[kind];
        return { target: { kind: 'entity', entityType: kind === 'providers' ? 'provider' : 'connection', id },
            files: { fs: source, cwd: '/' }, signal: this.options.signal,
            hostContext: { toggleSidebar: () => {}, navigate: request => this.navigate(request),
                requestDelete: this.options.requestDelete ? targets => this.requestDelete(targets) : undefined,
                saveContent: (path, content) => source.driver.writeContent(toolboxSourcePath(path), content) } };
    }

    private async requestDelete(targets: Parameters<NonNullable<SetupOptions['requestDelete']>>[0]): Promise<void> {
        const started = performance.now(); let stage = 'deletion';
        try {
            await this.options.requestDelete!(targets); stage = 'deletion-refresh';
            await this.options.resources.navigation();
            if (this.disposed || this.options.signal.aborted) return;
            if (!this.resourceExists(this.originalPath)) { stage = 'deletion-completion'; await this.options.done(true); this.report(stage, 'success', started); return; }
            if (!this.resourceExists(this.currentPath)) {
                stage = 'deletion-return'; await this.mount(this.originalPath);
            }
            await this.refreshSummary(); this.report(stage, 'success', started);
        } catch (error) { this.failure(stage, error, started); throw error; }
    }

    private resourceExists(path: string): boolean {
        const id = decodeURIComponent(toolboxSourcePath(path).slice(1));
        return toolboxKind(path) === 'providers' ? this.options.inventory.providers.has(id) : this.options.inventory.connections.has(id);
    }

    private async mount(path: string): Promise<void> {
        if (this.disposed || this.options.signal.aborted) return;
        const kind = toolboxKind(path);
        if (kind !== 'providers' && kind !== 'connections') throw new Error(t('toolbox.resourceMissing'));
        const id = decodeURIComponent(toolboxSourcePath(path).slice(1));
        if (!id) throw new Error(t('toolbox.resourceMissing'));
        await this.flush();
        if (this.disposed || this.options.signal.aborted) return;
        const next = await this.prepareEditor(kind, id);
        try {
            if (this.disposed || this.options.signal.aborted) { await next.editor.destroy(); next.mount.remove(); return; }
            await this.editor?.destroy(); this.editorMount?.remove();
        } catch (error) { await next.editor.destroy(); next.mount.remove(); throw error; }
        this.editor = next.editor; this.editorMount = next.mount; next.mount.hidden = false; this.currentPath = path;
        this.providerId = kind === 'providers' ? id : this.options.inventory.connections.get(id)?.providerId ?? this.providerId;
        this.back.hidden = kind === 'providers' || !this.providerId;
        this.create.hidden = !this.providerId; this.connectionForm.hidden = true;
    }

    private async prepareEditor(kind: ModelKind, id: string): Promise<{ editor: IEditor; mount: HTMLElement }> {
        const mount = document.createElement('div'); mount.hidden = true; this.editorRoot.append(mount);
        try { return { editor: await this.options.factories[kind](mount, this.editorOptions(kind, id)), mount }; }
        catch (error) { mount.remove(); throw error; }
    }

    private async navigate(request: NavigationRequest): Promise<void> {
        if (request.target === 'toolbox' && request.action === 'create') {
            await this.flush(); this.connectionForm.hidden = false; this.connectionName.focus(); return;
        }
        const kind = request.resourceId && toolboxKind(request.resourceId);
        if (request.target === 'toolbox' && request.resourceId && (kind === 'providers' || kind === 'connections')) {
            await this.mount(request.resourceId); await this.refreshSummary(); return;
        }
        await this.flush(); await this.options.navigate(request);
    }

    private async createConnection(): Promise<void> {
        this.connectionStage = 'connection-save';
        await this.flush();
        const name = this.connectionName.value.trim();
        if (!name || !this.providerId) { this.connectionName.focus(); return; }
        this.connectionStage = 'connection-persistence';
        this.pendingConnection ||= await this.options.resources.create('connections', name, this.providerId);
        this.connectionStage = 'connection-refresh';
        await this.options.resources.navigation();
        this.connectionStage = 'connection-editor';
        await this.mount(this.pendingConnection);
        this.pendingConnection = ''; this.connectionName.value = '';
        this.status.textContent = t('toolbox.setupConnectionCreated');
        await this.refreshSummary();
    }

    private async refreshSummary(): Promise<void> {
        const generation = ++this.refreshGeneration, started = performance.now();
        try {
            const navigation = await this.options.resources.navigation();
            if (this.disposed || generation !== this.refreshGeneration) return;
            if (toolboxKind(this.currentPath) === 'connections') this.providerId = this.options.inventory.connections.get(decodeURIComponent(toolboxSourcePath(this.currentPath).slice(1)))?.providerId ?? this.providerId;
            this.back.hidden = toolboxKind(this.currentPath) === 'providers' || !this.providerId; this.create.hidden = !this.providerId;
            const connections = [...this.options.inventory.connections].filter(([, connection]) => connection.providerId === this.providerId);
            const nodes = navigation.directories.find(directory => directory.path === '/connections')?.nodes ?? [];
            const title = document.createElement('p'); title.textContent = t(connections.length ? 'toolbox.setupConnectionCount' : 'toolbox.setupConnectionsEmpty', { count: connections.length });
            const hint = document.createElement('small'); hint.textContent = t('toolbox.setupConnectionsHint');
            this.list.replaceChildren(title, hint, ...connections.map(([id]) => this.connectionButton(id, nodes.find(node => node.path === '/connections/' + encodeURIComponent(id))?.name ?? id)));
            this.report('summary', 'success', started);
        } catch (error) { if (!this.disposed && generation === this.refreshGeneration) this.failure('summary', error, started); }
    }

    private connectionButton(id: string, name: string): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
        button.className = 'settings-btn settings-btn--secondary';
        button.dataset.connectionId = id; button.disabled = this.currentPath === '/connections/' + encodeURIComponent(id);
        button.onclick = () => { void this.run('navigation', async () => { await this.mount('/connections/' + encodeURIComponent(id)); await this.refreshSummary(); }); };
        return button;
    }

    private async run(stage: string, work: () => Promise<void>): Promise<void> {
        if (this.busy || this.disposed) return;
        const started = performance.now(); this.busy = true; this.status.textContent = ''; this.setBusy(true);
        try { await work(); this.report(stage, 'success', started); }
        catch (error) { this.failure(stage === 'connection-create' ? this.connectionStage : stage, error, started); }
        finally { this.busy = false; this.setBusy(false); }
    }

    private setBusy(busy: boolean): void {
        for (const button of [this.back, this.create, this.complete, ...this.connectionForm.querySelectorAll('button')]) button.disabled = busy;
        this.connectionName.disabled = busy; this.editorRoot.inert = busy;
    }

    private failure(stage: string, error: unknown, started: number): void {
        this.status.textContent = t('toolbox.setupFailed', { message: error instanceof Error ? error.message : String(error) });
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(error.code) ? error.code : `MODEL_SETUP_${stage.toUpperCase().replaceAll('-', '_')}_FAILED`;
        log.error('toolbox.model.setup.failed', { operation: 'toolbox.model.setup', operationId: this.operationId, stage, outcome: 'failure', code, errorType: error instanceof Error ? error.name : typeof error, durationMs: Math.round(performance.now() - started) });
    }

    private report(stage: string, outcome: string, started: number): void {
        log.info('toolbox.model.setup.completed', { operation: 'toolbox.model.setup', operationId: this.operationId, stage, outcome, durationMs: Math.round(performance.now() - started) });
    }

    async flush(): Promise<void> {
        if (this.editor?.flushPendingSave) await this.editor.flushPendingSave();
        else if (this.editor?.isDirty()) throw new Error(t('settings.autosave.leaveFailed'));
    }

    async dispose(): Promise<void> {
        if (this.editor) { await this.editor.destroy(); this.editor = undefined; }
        this.stop?.(); this.stop = undefined;
        this.disposed = true; this.refreshGeneration++; this.container.replaceChildren();
    }
}

export async function configureCreatedModel(container: HTMLElement, path: string, options: SetupOptions): Promise<CreationModelSetup> {
    const setup = new ModelSetup(container, options); await setup.start(path); return setup;
}
