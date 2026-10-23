import { sessionCreationReason } from './session-creation-policy';
import { fileFirst, projectItems } from './navigation-policy';
import { remapProjectPath } from './project-paths';
import { t, FILE_BROWSER_ICONS, VFS_TOOLBAR_ICONS, ENTITY_ICONS, FEEDBACK_ICONS } from '@itookit/common';
import { ProjectSyncStatusIndicator, projectSyncIcon } from './sync/indicator';
import type { ProjectSyncIndicator } from './sync/presentation';
import { browserTargetFolder, folderBrowserPath, resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectFolder, ProjectNavigationView, ProjectService } from '@itookit/app-contracts/services';
import { ScopeSelector } from '@itookit/vfs-ui';
import type { VFSActionDefinition, VFSActionContext, VFSToolbarContext, VFSColumnsOptions, VFSNodeUI, VFSUIShell } from '@itookit/vfs-ui';
import { decorateButton } from '../workbench/controls';

interface Actions {
    refresh?(): Promise<void>;
    projectRenamed?(from: ProjectFolder, to: ProjectFolder): void;
    projectMenu?(event: MouseEvent, project: ProjectFolder): Promise<void>;
    projectsChanged?(projects: ProjectFolder[]): void;
    syncIndicator?(projectId: string): ProjectSyncIndicator | undefined;
    syncStatus?(projectId: string): Promise<void>;
    createProject(path?: string | null): Promise<unknown>; createSession(path?: string): Promise<unknown>;
    createChild(id: string): Promise<unknown>; importItems(context: VFSToolbarContext): Promise<void>; exportItems(context: VFSToolbarContext): Promise<void>;
    report(error: unknown): void; retryDeletions(): Promise<void>;
    contentChanged(visible: boolean, family: boolean): void;
    navigate?(path: string): Promise<void>;
}
/** Compatibility hint: favorites may preserve selection while their file opens. */
export type ProjectFileView = 'preserve' | 'directory';
export interface ProjectNavigationOptions { reveal?: boolean; project?: ProjectFolder; preserveProject?: boolean; fileView?: ProjectFileView }

/** Project context replaces the contents of one sidebar; file details belong to main tabs. */
export class ProjectNavigation {
    readonly header = document.createElement('div');
    readonly toolbarContainer = document.createElement('span');
    readonly options: Pick<VFSColumnsOptions, 'navigationToolbarOptions'>;
    private readonly create = document.createElement('button');
    private readonly selector: ScopeSelector;
    private readonly retry = document.createElement('button');
    private readonly menu = document.createElement('details');
    private readonly menuContent = document.createElement('div');
    readonly overflow = {root: this.menu, content: this.menuContent};
    private readonly projectActions = document.createElement('button');
    private readonly menuEvents = new AbortController();
    private transferPending = false;
    private scopeRevision = 0;
    private readonly syncStatus: ProjectSyncStatusIndicator;
    private project?: ProjectFolder;
    private path = '/';
    private draftActive = false;
    private revision = 0;
    private offlinePaths = new Set<string>();
    private projectChoices: ProjectFolder[] = [];
    private pendingDeletions = 0;
    constructor(private readonly projects: ProjectService, private readonly ui: () => VFSUIShell | undefined, private readonly actions: Actions) {
        this.syncStatus = new ProjectSyncStatusIndicator(() => {
            if (this.project) void this.actions.syncStatus?.(this.project.project.id).catch(this.actions.report);
        });
        this.selector = new ScopeSelector({ label: t('project.workspace'), onError: actions.report,
            select: async (value, signal) => {
                if (value === '@new-project') await actions.createProject('/');
                else await this.choose(value, signal);
            } });
        this.buildHeader();
        this.updateHeader([], 0);
        this.options = {
            navigationToolbarOptions: { variant: 'plain', definitions: [
                { id: 'create-project', label: t('project.create'), iconHTML: FILE_BROWSER_ICONS.addFolder, placement: () => this.project ? 'hidden' : 'toolbar',
                    run: async () => { await this.actions.createProject('/'); } },
                { id: 'refresh', label: t('action.refresh'), iconHTML: FILE_BROWSER_ICONS.refresh, placement: 'toolbar',
                    run: async () => {
                        if (this.actions.refresh) await this.actions.refresh();
                        else { await this.ui()?.refresh(); await this.refresh(); }
                    } },
                this.transferAction('import', context => this.actions.importItems(context)),
                this.transferAction('export', context => this.actions.exportItems(context)),
            ] },
        };
    }
    private transferAction(id: 'import' | 'export', run: (context: VFSToolbarContext) => Promise<void>): VFSActionDefinition {
        return { id, label: t(`vfs.toolbar.${id}`), iconHTML: VFS_TOOLBAR_ICONS[id],
            placement: (context: VFSActionContext) => {
                return context.target?.metadata.custom.projectId ? 'menu' : 'hidden';
            },
            disabled: (context: VFSActionContext) => !!context.target?.metadata.custom.projectId
                && !!this.projects.remoteMounts?.projectOffline(String(context.target.metadata.custom.projectId)),
            run: (context: VFSActionContext) => run({ selectedIds: context.selectedIds, activeId: context.activeId, parentPath: context.parentPath }),
        };
    }
    private buildHeader(): void {
        this.header.className = 'workbench-project-navigation';
        this.button(this.create, t('project.createSession'), () => this.createSession());
        this.create.className = 'workbench-project-navigation__create';
        decorateButton(this.create, FILE_BROWSER_ICONS.newSession, t('project.createSession'));
        this.button(this.retry, '', () => this.actions.retryDeletions()); this.retry.hidden = true;
        this.buildMenu();
        this.selector.element.oncontextmenu = event => { if (this.project) { event.preventDefault(); this.showMenu(event); } };
        this.toolbarContainer.className = 'workbench-project-navigation__transfer';
        this.toolbarContainer.append(this.menu);
        this.menuContent.append(this.retry);
        this.header.append(this.selector.element, this.syncStatus.element, this.create, this.toolbarContainer);
    }
    private buildMenu(): void {
        this.menu.className = 'workbench-project-navigation__menu';
        const summary = document.createElement('summary'), panel = this.menuContent;
        summary.title = t('vfs.columns.more'); summary.setAttribute('aria-label', summary.title);
        summary.innerHTML = FILE_BROWSER_ICONS.more; panel.className = 'workbench-project-navigation__menu-items';
        for (const id of ['import', 'export'] as const) {
            const button = document.createElement('button'); button.dataset.projectAction = id;
            this.button(button, t(`vfs.toolbar.${id}`), () => this.runTransfer(id));
            decorateButton(button, VFS_TOOLBAR_ICONS[id], t(`vfs.toolbar.${id}`)); panel.append(button);
        }
        this.button(this.projectActions, t('project.sync.projectActions'), async () => {
            const rect = summary.getBoundingClientRect(); this.menu.open = false;
            this.showMenu(new MouseEvent('contextmenu', { clientX: rect.left, clientY: rect.bottom }));
        });
        panel.append(this.projectActions); this.menu.append(summary, panel);
        this.menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') { this.menu.open = false; summary.focus(); }
        });
        document.addEventListener('click', event => {
            if (!this.menu.contains(event.target as Node)) this.menu.open = false;
        }, { capture: true, signal: this.menuEvents.signal });
    }
    private async runTransfer(id: 'import' | 'export'): Promise<void> {
        if (this.transferPending) return;
        const state = this.ui()?.getSnapshot(), activeId = state?.activeId ?? null;
        const selectedIds = state?.selectedIds.length ? [...state.selectedIds] : activeId ? [activeId] : [];
        const context = { selectedIds, activeId, parentPath: this.project ? folderBrowserPath(this.project.path) : '/' };
        this.menu.open = false; this.transferPending = true; this.updateTransferControls();
        try { await (id === 'import' ? this.actions.importItems(context) : this.actions.exportItems(context)); }
        finally { this.transferPending = false; this.updateTransferControls(); }
    }
    private updateTransferControls(): void {
        const offline = !!this.project && this.offlinePaths.has(folderBrowserPath(this.project.path));
        for (const button of this.menu.querySelectorAll<HTMLButtonElement>('[data-project-action]'))
            button.disabled = this.transferPending || offline;
    }
    private async choose(path: string, signal: AbortSignal): Promise<void> {
        const revision = ++this.scopeRevision;
        const project = path === '/' ? undefined : await this.projects.forFolder(browserTargetFolder(resolveBrowserTarget(path), path));
        if (signal.aborted || revision !== this.scopeRevision) return;
        this.project = project;
        this.updateSelector();
        if (this.actions.navigate) await this.actions.navigate(path);
        else await this.sync(path, { preserveProject: true });
    }
    /** Select known project roots immediately; expansion runs after the content is ready. */
    selectScope(path: string): void {
        const project = this.projectChoices.find(item => folderBrowserPath(item.path) === path);
        if (path !== '/' && !project) return;
        this.cancelPending(); this.path = path; this.draftActive = false;
        this.project = project; this.updateHeader(this.projectChoices, this.pendingDeletions);
        this.ui()?.setTitle(project?.displayName ?? project?.name ?? t('workbench.allProjects')); this.ui()?.refreshList();
    }
    private showMenu(event: MouseEvent): void {
        const project = this.project;
        if (project) void this.actions.projectMenu?.(event, project).catch(this.actions.report);
    }
    private button(button: HTMLButtonElement, label: string, action: () => Promise<unknown>): void {
        button.type = 'button'; button.textContent = label;
        button.onclick = () => { void action().catch(this.actions.report); };
    }
    destroy(): void { this.cancelPending(); this.selector.destroy(); this.menuEvents.abort(); }
    cancelPending(): void { ++this.revision; ++this.scopeRevision; this.menu.open = false; }
    showDraft(project: ProjectFolder): void {
        this.cancelPending();
        this.draftActive = this.project?.project.id === project.project.id;
        this.create.setAttribute('aria-current', this.draftActive ? 'page' : 'false');
    }
    async sync(path: string, options: ProjectNavigationOptions = {}): Promise<void> {
        ++this.scopeRevision;
        this.path = path; this.draftActive = false;
        const revision = ++this.revision;
        const snapshot = await this.projects.navigation({ path,
            projectId: options.project?.project.id ?? (options.preserveProject ? this.project?.project.id ?? null : undefined) });
        if (revision === this.revision) await this.apply(snapshot, revision);
    }
    private async apply(snapshot: ProjectNavigationView, revision: number): Promise<void> {
        const { project, projects, path } = snapshot;
        if (revision !== this.revision) return;
        this.project = project; this.path = path;
        this.offlinePaths = new Set(projects.filter(item => snapshot.offlineProjectIds.includes(item.project.id)).map(item => folderBrowserPath(item.path)));
        this.updateHeader(projects, snapshot.pendingDeletions);
        this.actions.projectsChanged?.(projects);
        this.ui()?.setTitle(project?.displayName ?? project?.name ?? t('workbench.allProjects')); this.ui()?.refreshList();
        if (project) {
            await this.ui()?.expandPath(folderBrowserPath(project.path));
            for (const group of snapshot.loadPaths) {
                if (revision !== this.revision) return;
                if (this.ui()?.getNode(group)?.children === undefined) await this.ui()?.loadDirectory(group);
            }
        }
        if (revision === this.revision) this.ui()?.refreshList();
    }
    private updateHeader(projects: ProjectFolder[], pending: number): void {
        this.pendingDeletions = pending;
        this.projectChoices = projects;
        const project = this.project;
        this.syncStatus.update(project && this.actions.syncIndicator?.(project.project.id));
        this.updateCreation();
        this.projectActions.hidden = !project || !this.actions.projectMenu;
        this.menu.hidden = !project;
        this.retry.hidden = !pending; this.retry.textContent = t('project.retryDeletion', { count: pending });
        this.updateSelector(); this.updateTransferControls();
    }
    private creationProject(): ProjectFolder | undefined {
        if (this.project) return this.project;
        const folder = browserTargetFolder(resolveBrowserTarget(this.path), this.path);
        return this.projectChoices.find(project => folder === project.path || folder.startsWith(project.path + '/'));
    }
    private async createSession(): Promise<unknown> {
        return this.actions.createSession(folderBrowserPath(this.creationProject()?.path));
    }
    private updateCreation(): void {
        const project = this.creationProject();
        this.create.hidden = !project;
        const reason = project ? sessionCreationReason(this.projects, project.project.id) : undefined;
        this.create.disabled = !!reason;
        this.create.title = reason ?? t('project.createSession');
        this.create.setAttribute('aria-current', this.draftActive ? 'page' : 'false');
    }
    private updateSelector(): void {
        this.selector.update([{ id: '/', label: t('workbench.allProjects') },
            ...this.projectChoices.map(item => ({ id: folderBrowserPath(item.path), label: this.projectLabel(item) })),
            ...(!this.project ? [{ id: '@new-project', label: t('project.create') + '…' }] : [])], this.project ? folderBrowserPath(this.project.path) : '/');
    }
    navigationItems(items: VFSNodeUI[], query = ''): VFSNodeUI[] {
        this.updateCreation();
        const root = this.project ? findNode(items, folderBrowserPath(this.project.path)) : undefined;
        const nodes = projectItems(this.project ? root?.children ?? [] : items, query);
        return this.syncItems(nodes).sort((a, b) => fileFirst(a, b) ?? 0);
    }
    refreshSyncIndicators(): void {
        this.syncStatus.update(this.project && this.actions.syncIndicator?.(this.project.project.id));
        this.updateSelector();
        this.ui()?.refreshList();
    }
    private projectLabel(project: ProjectFolder): string {
        const indicator = this.actions.syncIndicator?.(project.project.id), name = project.displayName ?? project.name;
        return indicator ? `${name} ${indicator.state === 'configured' ? ENTITY_ICONS.sync : FEEDBACK_ICONS.warning}` : name;
    }
    private syncItems(items: VFSNodeUI[]): VFSNodeUI[] {
        return items.map(item => {
            const id = item.metadata.custom.projectId;
            const indicator = typeof id === 'string' ? this.actions.syncIndicator?.(id) : undefined;
            return {...item, ...(indicator ? {icon: projectSyncIcon(item.metadata.custom.remoteProject === true, indicator)} : {}),
                children: item.children && this.syncItems(item.children)};
        });
    }
    async refresh(initial?: ProjectNavigationView): Promise<void> {
        const revision = ++this.revision;
        let snapshot = initial ?? await this.projects.navigation({ path: this.path, projectId: this.project?.project.id ?? null });
        if (revision !== this.revision) return;
        const renamed = snapshot.projects.find(folder => folder.project.id === this.project?.project.id);
        if (this.project && renamed?.project && renamed.path !== this.project.path) {
            const next = renamed as ProjectFolder;
            snapshot = { ...snapshot, path: remapProjectPath(snapshot.path, folderBrowserPath(this.project.path), folderBrowserPath(next.path)) };
            this.actions.projectRenamed?.(this.project, next);
            this.project = next;
        }
        await this.apply(snapshot, revision);
    }
    currentProject(): ProjectFolder | undefined { return this.project; }
    registeredProjects(): readonly ProjectFolder[] { return this.projectChoices; }
}
function findNode(items: VFSNodeUI[], id: string): VFSNodeUI | undefined {
    for (const node of items) {
        if (node.id === id) return node;
        const child = node.children && findNode(node.children, id); if (child) return child;
    }
}
