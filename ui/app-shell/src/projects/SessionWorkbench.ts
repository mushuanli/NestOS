import {backToPreviousPage} from '../navigation/page-history';
import { SessionTaskView } from './SessionTaskView';
import { AgentDrawer } from './agent-drawer';
import type {ProjectDraftPromotion} from '@itookit/app-contracts/services';
import { AgentProjectPreferences } from './agent-project-preferences';
import { mountAgentProjectSettings } from './agent-project-settings';
import { lazyResource } from '../lifecycle/lazy-resource';
import { RemoteAgentDetailsEditor } from '../toolbox/RemoteAgentDetailsEditor';
import { ViewRefresh } from '../lifecycle/view-refresh';
import {createRecoverableFileEditor} from '../browser/file-recovery';
import { harnessObservation, remoteSessionSources } from '@itookit/app-contracts';
import { projectTwinTarget, twinSourceMenu } from '../digital-twin/source-menu';
import { withInitialDirectory } from '../browser/initial-directory';
import { presentationPersistence } from '../persistence/initial-navigation';
import { showHarnessControl } from '../harness/control';
import { RemoteSessionStatusView } from './remote-session-status';
import { projectIconMenu } from './project-menu-icons';
import { sessionCreationReason } from './session-creation-policy';
import { projectDirectoryActions } from './directory-actions';
import {fileFirst, navigationPriority, projectItems} from './navigation-policy';
import {projectNavigationPreview} from './navigation-preview';
import { ProjectSearchPanel } from './project-search-panel';
import { createProjectDirectorySearch } from './project-directory-search';
import { showRemoteSessionFamily } from './remote-session-family';
import { nativeSessionMenu } from './remote-session-management';
import type { ProjectSearchMatch } from '@itookit/app-contracts/services';
import type { ApplicationBackend } from '@itookit/app-contracts/services';
import { projectTransferTargets } from './transfer-targets';
import { ProjectSyncMenu } from './sync/menu';
import { createMindOSVFSUI as createVFSUI } from '../browser/vfs-presentation';
import { WorkbenchTabs, type WorkbenchTab } from '../workbench/tabs';
import { WorkbenchSidebar } from '../workbench/sidebar';
import { createDirectoryList, refreshDirectoryList, watchDirectorySelection, type DirectoryEntry } from '../workbench/directory-list';
import { createDirectoryBreadcrumbs } from '../workbench/directory-breadcrumbs';
import { directoryBulkActions } from '../workbench/vfs-actions';
import { ENTITY_ICONS, FILE_BROWSER_ICONS, FILE_ICONS, harnessPresentation } from '@itookit/common';
import { watchDirectoryList } from '../workbench/directory-watch';
import type { WorkbenchStatePort } from '../workbench/state';
import { directoryFavoriteAction, projectFavoriteAction } from './project-favorites';
import { directoryBreadcrumbs, directoryEntryName } from './directory-label';
import {localSessionStatus} from './local-session-status';
import { projectDirectoryNodes } from './project-directory';
import { conversationResourcePath, projectConversationsPath } from '@itookit/app-contracts';
import { WORKSPACE_PATH, projectRelativePath, reportRemoteFailure } from '@itookit/app-contracts';
import { createProjectDraftControls } from './project-draft-editor';
import type { SessionOpenView, WorkbenchChatControls, ProjectFolder } from '@itookit/app-contracts/services';
import type { ConversationManifest } from '@itookit/llm-session/contracts';
import { EditorLease } from '../browser/editor-lease';
import { openProjectFileEditor, localizeRemoteWriteError } from './project-file-editor';
import { fileContentFormat } from '../browser/file-format';
import { ViewLoad, ViewLoadCancelled, LatestViewLoad } from '../lifecycle/view-load';
import { SubscriptionScope } from '../lifecycle/subscription-scope';
import { archiveTarget } from './archive-targets';
import { chooseArchive, downloadArchive } from '../files/archive-transfer';
import { SessionFamilyActions } from './SessionFamilyActions';
import { buildRenamedFilename, formatDefaultFileTitle, t, traceBoot } from '@itookit/common';
import { type SessionSkillControls } from '@itookit/tools/contracts';
import { ProjectNavigation, type ProjectFileView, type ProjectNavigationOptions } from './ProjectNavigation';
import { remapProjectPath } from './project-paths';
import { showNameDialog, showProjectDialog } from '../files/project-dialog';
import { showMountDialog } from '../files/mount-dialog';
import { localizeMountError } from '../files/localize-mount-error';

import type { EditorFactory, IEditor, EditorHostContext, EditorOptions, ContextMenuConfig, MenuItem } from '@itookit/ui-common';
import type { ISessionRepository } from '@itookit/llm-session/contracts';
import type { KernelViewPort as Kernel } from '@itookit/durable-kernel/contracts';
import { describeErrorReason, describeCauseChain, type VFSToolbarContext, type VFSUIShell, type VFSNodeUI, type UIPersistencePort } from '@itookit/vfs-ui';
import { FSError, createFileSystemView, searchKeywords, type FSNode, type IFileSystem, type FileSystemContextOwner, type FileSystemView } from '@itookit/vfs-core';



import { parentBrowserPath, remoteSessionPath, browserTargetFolder, folderBrowserPath, folderPathFromBrowserPath, parseSessionRoute, resolveBrowserTarget, sessionRoute, type WorkspaceController } from '@itookit/app-contracts';
import type { ProjectService, DirectoryMountPort, SessionFilesPort } from '@itookit/app-contracts/services';
import type { SessionLifecycleService, ProjectSessions } from '@itookit/app-contracts/services';

/** Sidebar refresh tracing — enable with localStorage['vfs:debug']='1' (same flag as vfs-ui). */
function debugEnabled(): boolean {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem('vfs:debug') === '1'; } catch { return false; }
}

const fileNames = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** Stable identity of the sidebar's restored UI state; the host persists it per scope. */
import {SESSION_BROWSER_SCOPE} from '../persistence/documents';
export {SESSION_BROWSER_SCOPE} from '../persistence/documents';

/** One navigation request. `fileNavigation` decides how the content column follows a file. */
export interface OpenResourceOptions {
    initialInputState?: { text?: string; agentId?: string };
    reload?: boolean;
    preserveProject?: boolean;
    branch?: string;
    fileNavigation?: ProjectFileView;
    /** A listing hint; the source still validates that the target is a directory. */
    directory?: boolean;
}

/** File column behavior for a resolved favorite target. */
const fileViewFor = (kind: 'file' | 'directory' | 'session'): ProjectFileView | undefined =>
    kind === 'file' ? 'preserve' : kind === 'directory' ? 'directory' : undefined;

/** Sort Sessions by activity, and physical files by directory then natural name. */
function compareSessionEntries(a: VFSNodeUI, b: VFSNodeUI): number | undefined {
    if (a.presentation?.fileDetails && b.presentation?.fileDetails) {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return fileNames.compare(a.metadata.title, b.metadata.title) || a.id.localeCompare(b.id);
    }
    if (!isFlowPath(a.id) && !isFlowPath(b.id)) {
        const fixed = fileFirst(a, b);
        if (fixed !== undefined) return fixed;
    }
    const isSession = (item: VFSNodeUI) => !isFlowPath(item.id) && resolveBrowserTarget(item.id).kind === 'session';
    const aSession = isSession(a), bSession = isSession(b);
    // Keep folder/Flow navigation together so mixed siblings have a transitive order.
    if (aSession !== bSession) return aSession ? 1 : -1;
    if (!aSession) return undefined;
    return Date.parse(b.metadata.lastModified) - Date.parse(a.metadata.lastModified) || a.id.localeCompare(b.id);
}

export interface SessionWorkbenchOptions {
    initialResource?: string;
    backend: ApplicationBackend;
    sidebar: HTMLElement;
    container: HTMLElement;
    repository: ISessionRepository;
    files: SessionFilesPort;
    factory?: EditorFactory;
    createFactory?(controls: WorkbenchChatControls): EditorFactory;
    onSelect: (id: string, mode?: 'push' | 'replace') => void;
    onBeforeNavigate?(): void;
    hostContext: EditorHostContext | undefined;
    kernel: Kernel;
    fileFactory: EditorFactory;
    directoryMounts?: DirectoryMountPort;
    sessionSkills?: SessionSkillControls;
    digitalTwin?: import('@itookit/app-contracts/services').DigitalTwinService;
    manageTwin?: (sessionId: string) => Promise<void>;
    manageMemory?: (sessionId: string, signal: AbortSignal) => Promise<void>;
    flows?: { fs: IFileSystem; menu: ContextMenuConfig<VFSNodeUI> };
    projects?: ProjectService;
    projectSync?: import('@itookit/app-contracts/services').ProjectSyncService;
    projectSyncSetup?(projectId: string, signal: AbortSignal): Promise<void>;
    projectSyncDirectory?(projectId: string, signal: AbortSignal): Promise<void>;
    onSidebarReady?: () => boolean;
    deferNavigation?: boolean;
    prepareSession?(sessionId: string): Promise<boolean>;
    /** Host-owned snapshot storage; omitted means the sidebar restores nothing. */
    uiPersistence?: UIPersistencePort;
    workbenchState?: WorkbenchStatePort;
    agents?: {resourceId(id: string): string | undefined; usage?: EditorOptions['executorUsage'];
        read(id: string): Promise<import('@itookit/kernel-adapters/contracts').AgentDefinition | null>; createEditor: EditorFactory};
}

function afterSidebarPaint(): Promise<void> {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame !== 'function' || document.visibilityState === 'hidden') {
            setTimeout(resolve, 0); return;
        }
        requestAnimationFrame(() => setTimeout(resolve, 0));
    });
}

function initialSessionId(resource?: string): string | undefined {
    if (!resource || resource.startsWith('draft:') || isFlowPath(resource)) return;
    try {
        const target = resolveBrowserTarget(parseSessionRoute(resource).path);
        return target.kind === 'session' ? target.sessionId : undefined;
    } catch { return undefined; }
}

interface RetainedEditor {
    editor?: IEditor; context?: FileSystemContextOwner; assets?: FileSystemView;
    previewCleanup?: () => void; renameCleanup?: () => void;
    active: string | null; branch?: string; cancel?: () => void; lease?: EditorLease;
    skills?: { sessionId: string; path: string };
    draft?: {id: string; projectId: string; remote?: import('@itookit/ui-common').ConversationControls};
}

/** vfs-ui owns the sidebar; this host owns business views and their file leases. */
export class SessionWorkbench implements WorkspaceController {
    private remoteStatus!: RemoteSessionStatusView;
    private searchPanel?: ProjectSearchPanel;
    private search?: import('@itookit/app-contracts/services').ProjectSearch;
    private readonly dialogs = new AbortController();
    private readonly tabs: WorkbenchTabs<RetainedEditor>;
    private readonly sidebarLayout: WorkbenchSidebar;
    private readonly agentDrawer?: AgentDrawer;
    private readonly agentProjects: AgentProjectPreferences;
    private readonly agentOptions?: SessionWorkbenchOptions['agents'];
    private readonly agentCatalog;
    private agentFilter?: string;
    private readonly agentFilterBar = document.createElement('div');
    private editor?: IEditor;
    private editorLease?: EditorLease;
    private previewCleanup?: () => void;
    private fileRenameCleanup?: () => void;
    private context?: FileSystemContextOwner;
    private assets?: FileSystemView;
    private browser?: Awaited<ReturnType<ApplicationBackend['workbenchView']>>['browser'];
    private navigationFiles?: FileSystemView;
    private sidebarUI?: VFSUIShell;
    private sidebarStarting = true;
    private navigationVisible: boolean;
    private navigationReady = false;
    private navigationTask?: Promise<void>;
    private startNavigation?: () => Promise<void>;
    private pendingNavigation?: {path: string; options: ProjectNavigationOptions; select: boolean};
    private projectNavigation?: ProjectNavigation;
    private readonly syncMenu: ProjectSyncMenu;
    private familyActions?: SessionFamilyActions;
    private lifecycle!: SessionLifecycleService;
    private active: string | null = null;
    private activeBranch?: string;
    private closed = false;
    private tail: Promise<void> = Promise.resolve();
    private readonly subscriptions = new SubscriptionScope();
    private contentVersion = 0;
    private readonly taskView: SessionTaskView;
    private navigationReadAt = 0;
    private kernelChanges: Record<string, number> = {};
    private refreshCount = 0;
    private lastRefreshAt = 0;
    private readonly viewRefresh = new ViewRefresh({
        visible: () => !this.closed && this.visible,
        run: sources => this.refreshView(sources), report: error => this.report(error),
    });
    private readonly waiting = new Set<string>();
    private readonly resettingTasks = new Set<string>();
    /** File whose editor is open, for the L4 glob mount/unmount pair. */
    private openEditorTarget?: { sessionId: string; path: string };
    private readonly sidebar: SessionWorkbenchOptions['sidebar'];
    private readonly container: SessionWorkbenchOptions['container'];
    private readonly repository: SessionWorkbenchOptions['repository'];
    private readonly files: SessionWorkbenchOptions['files'];
    private factory!: EditorFactory;
    private readonly createFactory: SessionWorkbenchOptions['createFactory'];
    private readonly onSelect: SessionWorkbenchOptions['onSelect'];
    private readonly onBeforeNavigate: SessionWorkbenchOptions['onBeforeNavigate'];
    private readonly digitalTwin?: import('@itookit/app-contracts/services').DigitalTwinService;
    private readonly hostContext: SessionWorkbenchOptions['hostContext'];
    private readonly kernel: SessionWorkbenchOptions['kernel'];
    private readonly fileFactory: SessionWorkbenchOptions['fileFactory'];
    private readonly directoryMounts: SessionWorkbenchOptions['directoryMounts'];
    private sessionSkills: SessionWorkbenchOptions['sessionSkills'];
    private readonly manageTwin: SessionWorkbenchOptions['manageTwin'];
    private readonly manageMemory: SessionWorkbenchOptions['manageMemory'];
    private readonly flows: SessionWorkbenchOptions['flows'];
    private readonly projects: SessionWorkbenchOptions['projects'];
    private readonly onSidebarReady: SessionWorkbenchOptions['onSidebarReady'];
    private readonly prepareSession?: (sessionId: string) => Promise<boolean>;
    private readonly uiPersistence: SessionWorkbenchOptions['uiPersistence'];
    private sessions!: ProjectSessions;
    private readonly sessionsReady: Promise<ProjectSessions>;
    private readonly backend: ApplicationBackend;
    private readonly initialResource?: string;
    private initialSession?: SessionOpenView;
    private initialData?: import('@itookit/app-contracts/services').SessionEditorInitialData;
    private chatConfiguration?: WorkbenchChatControls['configuration'];
    constructor(options: SessionWorkbenchOptions) {
        this.backend = options.backend;
        this.agentOptions = options.agents; this.agentProjects = new AgentProjectPreferences(this.backend);
        this.agentCatalog = lazyResource(() => this.backend.toolboxView(), view => view.dispose());
        this.initialResource = options.initialResource;
        this.taskView = new SessionTaskView(this.backend, {
            begin: () => { const version = ++this.contentVersion; return () => !this.closed && version === this.contentVersion; },
            mount: panel => this.tabs.content.replaceChildren(panel),
            open: path => this.openResource(path), report: error => this.report(error),
        });
        this.syncMenu = new ProjectSyncMenu({ service: options.projectSync, setup: options.projectSyncSetup, directory: options.projectSyncDirectory,
            ...(options.projects?.remoteMounts ? {connection: (id: string) => ({...options.projects!.remoteMounts!.connectionDiagnostic(id), offline: options.projects!.remoteMounts!.connectionStatus(id) === 'offline'})} : {}) }, this.dialogs.signal,
            error => this.report(error), async () => { if (!this.closed) { await this.sidebarUI?.refresh(); await this.projectNavigation?.refresh(); } },
            () => { if (!this.closed) this.projectNavigation?.refreshSyncIndicators(); });
        this.sidebar = options.sidebar;
        this.container = options.container;
        this.repository = options.repository;
        this.files = options.files;
        if (!options.factory && !options.createFactory) throw new Error('Session workspace requires an editor factory');
        if (options.factory) this.factory = options.factory;
        this.createFactory = options.createFactory;
        this.onSelect = options.onSelect;
        this.onBeforeNavigate = options.onBeforeNavigate;
        this.hostContext = options.hostContext; this.digitalTwin = options.digitalTwin;
        this.kernel = options.kernel;
        this.fileFactory = options.fileFactory;
        this.directoryMounts = options.directoryMounts;
        this.sessionSkills = options.sessionSkills;
        this.manageMemory = options.manageMemory;
        this.manageTwin = options.manageTwin;
        this.flows = options.flows;
        this.projects = options.projects;
        this.onSidebarReady = options.onSidebarReady;
        this.navigationVisible = !options.deferNavigation;
        this.prepareSession = options.prepareSession;
        this.uiPersistence = options.uiPersistence;
        this.sessionsReady = Promise.resolve(options.projects?.sessions ?? this.backend.projectSessions());
        void this.sessionsReady.catch(() => {});
        this.tabs = new WorkbenchTabs(this.container, {
            navigation: t('project.workspace'),
            describe: tab => this.describeOpenTab(tab.id),
            activate: id => this.openResource(id), dispose: tab => this.disposeTab(tab),
            empty: () => { this.clearEditorFields(); this.showWelcome(); this.onSelect('', 'replace'); },
            error: error => this.report(error), changed: () => this.sidebarLayout?.save(this.tabs.snapshot()),
        }, options.workbenchState?.load()?.tabs);
        this.sidebarLayout = new WorkbenchSidebar(this.sidebar, this.tabs.opened, options.workbenchState);
        if (options.agents && this.projects) {
            this.agentDrawer = new AgentDrawer({backend: this.backend, resourceId: options.agents.resourceId,
                usage: options.agents.usage, navigate: request => this.hostContext?.navigate(request) ?? Promise.resolve(),
                edit: id => this.hostContext?.navigate({target: 'chat', resourceId: '@agent/' + encodeURIComponent(id)}) ?? this.openAgentSettings(id),
                start: id => this.startAgentDraft(id)});
            this.agentDrawer.setVisible(this.navigationVisible);
            this.sidebarLayout.addDrawer('agents', t('toolbox.agents'), this.agentDrawer.element,
                collapsed => this.agentDrawer?.setExpanded(!collapsed));
        }
    }
    private isTransferFile(path: string): boolean {
        if (isFlowPath(path)) return false;
        const target = resolveBrowserTarget(path);
        return (target.kind === 'files' && target.path !== '/') || (target.kind === 'project-files' && target.path !== WORKSPACE_PATH);
    }

    async start(): Promise<void> {
        this.sessions ??= await this.sessionsReady;
        const view = await this.backend.workbenchView({ displayedFilesPolicy: 'gitignore', chatControls: !!this.createFactory,
            initialNavigation: this.navigationVisible, initialSessionId: initialSessionId(this.initialResource) });
        this.initialSession = view.initialSession;
        this.initialData = view.initialData;
        this.chatConfiguration = view.chat?.configuration;
        if (this.createFactory) this.factory = this.createFactory(view.chat!);
        this.sessionSkills ??= view.chat?.sessionSkills;
        this.remoteStatus = new RemoteSessionStatusView(harnessObservation, this.projects, () => this.sidebarUI?.refreshList(),
            (id, icon, tooltip) => this.tabs.setStatus(id, icon, tooltip),
            (id, title) => this.tabs.title(id, title), view.connections);
        this.browser = view.browser;
        this.lifecycle = view.lifecycle;
        this.search = view.search;
        this.navigationFiles = createFileSystemView({ viewId: 'session-navigation:admin', mounts: [
            { mountId: 'sessions', at: '/', fs: view.directory ? withInitialDirectory(this.browser.fs, view.directory) : this.browser.fs, access: 'rw' },
            ...(this.flows && !this.projects ? [{ mountId: 'flows', at: '/@flows', fs: this.flows.fs, access: 'rw' as const }] : []),
        ] });
        const tree = document.createElement('div'); tree.className = 'project-workbench__tree';
        if (this.projects) {
            this.searchPanel = new ProjectSearchPanel(view.search!, (row, query) => this.openSearchMatch(row, query), folder => this.openResource(remoteSessionPath(folder)));
            this.sidebarLayout.navigation.append(this.searchPanel.element);
        }
        this.sidebarLayout.navigation.append(tree);
        this.agentFilterBar.className = 'workbench-agent-filter'; this.agentFilterBar.hidden = true;
        this.sidebarLayout.navigation.prepend(this.agentFilterBar);
        if (this.projects) this.installProjectNavigation();
        if (this.searchPanel && this.projectNavigation) this.projectNavigation.header.after(this.searchPanel.element);
        this.sidebarUI = createVFSUI({ sessionListContainer: tree, title: this.projects ? t('project.workspace') : '会话', scopeId: SESSION_BROWSER_SCOPE,
            directoryPreview: node => projectNavigationPreview(node, path => this.openResource(path, {directory: true})),
            navigationChildren: node => (node.children ?? []).filter(child => child.metadata.custom.navigationTransparent === true).map(child => child.id),
            persistence: presentationPersistence(this.uiPersistence), onError: error => this.report(error),
            listItems: items => {
                this.remoteStatus.project(this.projectNavigation?.currentProject()?.project.id);
                this.searchPanel?.project(this.projectNavigation?.currentProject()?.path);
                this.searchPanel?.setQuery(this.sidebarUI?.getSnapshot().query ?? '', query => this.sidebarUI?.setQuery(query));
                const selected = this.projectNavigation?.currentProject();
                this.searchPanel?.sessionSources(selected && this.projects ? remoteSessionSources(this.projects, selected, this.projectNavigation!.registeredProjects()) : []);
                return this.remoteStatus.items(this.projectNavigation?.navigationItems(items, this.sidebarUI?.getSnapshot().query) ?? items);
            },
            titleHeader: this.projectNavigation?.header, toolbarContainer: this.projectNavigation?.toolbarContainer,
            toolbarOptions: this.projectNavigation?.options.navigationToolbarOptions,
            rowCreation: { visible: node => !isFlowPath(node.id) && ['project-files', 'files'].includes(resolveBrowserTarget(node.id).kind),
                run: (node, type) => this.createDirectoryEntry(node.id, type) },
            transferPolicy: {
                targets: this.projects ? (ids, _mode, parent) => projectTransferTargets(this.projects!, this.navigationFiles!, ids, parent) : undefined,
                source: (node, mode) => !node.metadata.custom.remoteProject && (mode === 'move' || this.isTransferFile(node.id)),
                destination: (node, ids) => {
                    if (!node) return false;
                    const fileSources = ids.every(id => this.isTransferFile(id));
                    const target = resolveBrowserTarget(node.id);
                    return fileSources ? ['files', 'project-files'].includes(target.kind) : target.kind === 'folder';
                },
            },
            transferItems: async (mode, ids, destination) => {
                try {
                    if (ids.every(id => this.isTransferFile(id))) await this.browser!.transferItems(mode, ids, destination ?? '/');
                    else if (mode === 'move') await this.navigationFiles!.driver.move(ids, destination);
                    else throw new Error('Only files and file directories can be copied');
                } finally {
                    const tabs = this.tabs.values();
                    const refreshed = await Promise.allSettled(tabs.map(tab => refreshDirectoryList(tab.panel)));
                    refreshed.forEach((result, index) => {
                        if (result.status !== 'rejected') return;
                        console.error('[Project transfer]', { stage: 'refresh-view', mode, sources: ids, destination,
                            tabId: tabs[index]?.id, cause: describeCauseChain(result.reason), error: result.reason });
                        this.report(result.reason);
                    });
                }
            },
            toolbar: 'full', hideGitignored: false,
            searchPlaceholder: t(this.projects ? 'project.searchContents' : 'project.search'), showFileExtensions: true,
            readOnly: false, activateDirectories: true, autoSelectFirst: !this.projects, defaultUiSettings: { sortBy: 'lastModified' },
            doubleClickActivation: node => !!node.metadata.custom.projectId,
            compareItems: compareSessionEntries,
            restoreExpandedDirectory: isExpandableDirectory,
            deferExpansion: true,
            exportDirectories: true,
            exportItem: item => this.exportSessionItem(item),
            favoriteAction: this.projects ? projectFavoriteAction(this.projects, this.repository) : undefined,
            onQuickDelete: async item => {
                const target = resolveBrowserTarget(item.id);
                if (target.kind === 'session') await this.removeSession(target.sessionId);
            },
            fileCreation: { label: '会话', title: formatDefaultFileTitle(), resolveParent: sessionCreationParent },
            contextMenu: {
                mapItem: item => projectItems([item])[0] ?? item,
                bulkItems: (items, defaults) => items.some(item => item.metadata.custom.remoteProject)
                    ? defaults.filter(entry => !('id' in entry) || !['bulk-delete', 'bulk-move', 'bulk-copy'].includes(entry.id)) : defaults,
                items: projectIconMenu((item, defaults) => {
                    if (item.id === '/' && this.projects) return [{id: 'create-project', label: t('project.create'), onClick: () => this.createProject('/')}];
                    if (isFlowPath(item.id)) return this.flows?.menu.items?.(item,
                        item.id === '/@flows' ? [] : defaults.filter(entry => 'id' in entry && entry.id === 'delete')) ?? [];
                    const target = resolveBrowserTarget(item.id);
                    const twin = this.digitalTwin && this.projects && (['session', 'project-files'].includes(target.kind) || (target.kind === 'remote' && target.nativeSessionId) || (target.kind === 'folder' && item.metadata.custom.projectId))
                        ? twinSourceMenu(this.digitalTwin, () => projectTwinTarget(this.projects!, item),
                            async () => { await this.hostContext?.navigate({ target: 'twin', resourceId: '/sources' }); }, this.dialogs.signal) : [];
                    defaults = [...defaults, ...twin];
                    if (target.kind === 'remote') {
                        const parent = item.metadata.custom.remoteParentSessionId;
                        return target.nativeSessionId && this.projects ? [
                            ...twin, ...nativeSessionMenu(this.backend.manageRemoteSession, target, item.metadata.title, item.metadata.custom.nativeManagement, this.dialogs.signal,
                                async () => { await this.tabs.close(item.id, false); },
                                async (command, title, deletedSessionIds) => {
                                    await this.sidebarUI?.refresh();
                                    if (command.kind === 'delete') {
                                        for (const tab of this.tabs.values()) {
                                            if (tab.id.startsWith('@agent/')) continue;
                                            const route = resolveBrowserTarget(tab.id);
                                            if (route.kind === 'remote' && route.folder === target.folder && route.profileId === target.profileId
                                                && route.nativeSessionId && deletedSessionIds.includes(route.nativeSessionId)) await this.tabs.close(tab.id, false);
                                        }
                                        await this.openResource(remoteSessionPath(target.folder, target.profileId, undefined, target.archived));
                                        return;
                                    }
                                    this.tabs.title(item.id, title);
                                    const next = remoteSessionPath(target.folder, target.profileId, target.nativeSessionId, command.kind === 'rename' ? target.archived : command.kind === 'archive');
                                    await this.openResource(next, {reload: true});
                                }, error => this.report(error)),
                            ...defaults.filter(entry => 'id' in entry && ['export', 'favorite'].includes(entry.id)),
                            {id: 'native-export', label: t('harness.export'), onClick: () => { void this.exportSessionItem({path: item.id, type: 'file'})
                                .then(result => { if (result && !this.closed) downloadArchive(result.content, result.name); }).catch(error => this.report(error)); }},
                            {id: 'native-family', label: t('harness.family'), onClick: () => { void showRemoteSessionFamily(this.backend.conversationBranches, target, this.dialogs.signal, path => this.openResource(path)).catch(error => this.report(error)); }},
                            ...(typeof parent === 'string' && parent ? [{id: 'native-parent', label: t('harness.parent'), onClick: () => { void this.openResource(remoteSessionPath(target.folder, target.profileId, parent)).catch(error => this.report(error)); }}] : []),
                        ] : [];
                    }
                    if (target.kind === 'favorite' || target.kind === 'favorites') return [];
                    if ((target.kind === 'project-files' || target.kind === 'files') && item.type === 'directory') {
                        const entries = ['file', 'directory'].map(type => ({
                            disabled: item.metadata.custom._readOnly === true || item.metadata.custom._disabled === true,
                            id: type === 'file' ? 'create-file' : 'create-folder', label: t(type === 'file' ? 'project.createFile' : 'project.createFolder'),
                            onClick: () => this.createDirectoryEntry(item.id, type as 'file' | 'directory'),
                        }));
                        return [...(target.kind === 'project-files' && target.path === WORKSPACE_PATH ? twin : defaults.filter(entry => !('id' in entry) || !['create-in-folder-session', 'create-in-folder-folder'].includes(entry.id))), ...entries];
                    }
                    if (this.projects && item.metadata?.custom?.projectId)
                        return this.projectEntryMenu(item, defaults);
                    if (target.kind === 'folder' && item.metadata.custom.navigationTransparent === true)
                        return defaults.filter(entry => !('id' in entry) || !['delete', 'rename'].includes(entry.id));
                    if (target.kind === 'task') {
                        return [{ id: 'reset-task', label: '强制复位任务（停止执行，保留记录）',
                            onClick: () => { void this.resetTask(item.id).catch(error => this.report(error)); } }];
                    }
                    // Closing stops the run but keeps the Session history, so it is offered
                    // next to (not instead of) the destructive delete.
                    if (target.kind === 'session') {
                        return [...defaults.filter(entry => !this.familyActions || !('id' in entry) || !['delete', 'create-in-folder-session', 'create-in-folder-folder'].includes(entry.id)),
                            ...(this.familyActions ? this.familyMenu(target.sessionId) : []),
                            { id: 'session-tasks', label: t('project.sessionTasks'), onClick: () => { void this.openResource(item.id + '/tasks').catch(error => this.report(error)); } },
                            { id: 'session-files', label: t('project.sessionFiles'), onClick: () => { void this.openResource(item.id + '/files').catch(error => this.report(error)); } },
                            { id: 'rerun-session', label: t('session.rerun.title'),
                            onClick: () => { void this.rerunSession(target.sessionId).catch(error => this.report(error)); } }, { id: 'close-session', label: t('session.close.action'),
                            onClick: () => { void this.closeSession(target.sessionId).catch(error => this.report(error)); } }];
                    }
                    return defaults;
                }),
            },
        }, this.navigationFiles) as VFSUIShell;
        this.subscriptions.add(this.sidebarUI.on('resourceActivated', ({item}) => {
            if (!item || this.sidebarStarting) return;
            void this.openResource(item.id, {directory: item.type === 'directory', preserveProject: !item.metadata.custom.projectId}).catch(error => this.report(error));
        }), this.sidebarUI.on('sidebarStateChanged', ({ isCollapsed }) => this.sidebar.classList.toggle('is-collapsed', isCollapsed)),
        this.repository.subscribe(change => { if (change?.kind !== 'ui-state') this.scheduleRefresh('repository'); }),
        this.files.subscribe(() => this.scheduleRefresh('files')),
        ...(this.projects ? [this.projects.favorites.subscribe(() => this.scheduleRefresh('favorites'))] : []),
        // Task content (stream deltas, logs, shared state) notifies many times per
        // second while a run streams. The sidebar only lists Sessions and Tasks, so
        // re-render on structural changes only — never per output chunk.
        this.kernel.onChanged(event => {
            this.noteKernelChange(event.reason);
            if (event.reason !== 'content') this.scheduleRefresh('kernel:' + event.reason);
        }));
        if (this.projects) this.subscriptions.add(this.projects.drafts.onPromoted(event => {
            void this.promoteDraftTab(event).catch(error => this.report(error));
        }));
        this.startNavigation = async () => {
            await traceBoot('sessionWorkbench.sidebar', () => this.sidebarUI!.start());
            if (this.closed) return;
            await this.projectNavigation?.refresh(view.navigation);
            if (this.onSidebarReady?.()) await afterSidebarPaint();
            if (this.closed) return;
            this.sidebarStarting = false; this.navigationReady = true; this.navigationReadAt = performance.now();
        };
        if (this.projects?.remoteMounts) this.subscriptions.add(
            this.projects.remoteMounts.onChange(() => { this.updateRemoteAvailability(); this.scheduleRefresh('remote-status'); }));
        if (!this.active) {
            if (this.projects) this.showWelcome();
            else this.message('选择一个会话，或新建会话');
        }
        this.remoteStatus.setNavigationVisible(this.navigationVisible);
        if (this.navigationVisible) await this.setNavigationVisible(true);
        else this.sidebarUI.setVisible?.(false);
    }
    async setNavigationVisible(visible: boolean): Promise<void> {
        this.agentDrawer?.setVisible(visible && this.visible);
        if (this.closed) return;
        this.navigationVisible = visible;
        this.sidebarUI?.setVisible?.(visible && this.visible);
        this.remoteStatus?.setNavigationVisible(visible && this.visible);
        if (!visible || !this.visible || this.closed) { this.projectNavigation?.cancelPending(); return; }
        if (!this.navigationReady && this.startNavigation) {
            this.navigationTask ??= this.startNavigation().catch(error => { this.navigationTask = undefined; throw error; });
            await this.navigationTask;
        }
        if (this.closed || !this.navigationVisible || !this.visible) return;
        const pending = this.pendingNavigation;
        if (pending) this.scheduleNavigation(pending.path, pending.options, pending.select);
        else if (this.viewRefresh.dirty) this.refresh();
    }
    /**
     * Stop a running Session and keep every record. Deletion is a separate action; this
     * only cancels the in-flight run and waits until the external stop is confirmed.
     */
    private async rerunSession(sessionId: string): Promise<void> {
        await this.openResource(sessionId);
        if (this.closed || this.active !== sessionId) return;
        const rerun = this.editor?.commands?.rerunSession;
        if (!rerun) throw new Error(t('session.rerun.unavailable'));
        await rerun();
    }

    private async closeSession(sessionId: string): Promise<void> {
        if (this.closed) return;
        await this.lifecycle.closeSession(sessionId);
        this.scheduleRefresh('session-close');
    }
    private async resetTask(path: string): Promise<void> {
        const target = resolveBrowserTarget(path);
        if (this.closed || target.kind !== 'task') return;
        const key = `${target.sessionId}/${target.taskId}`;
        if (this.resettingTasks.has(key)) return;
        this.resettingTasks.add(key);
        try {
            // Kernel cancellation fences execution, cancels pending interactions and
            // propagates to children. Never rewrite checkpoints or erase DAG/history.
            await this.kernel.cancel(target.sessionId, target.taskId, '用户强制复位任务：停止执行，保留历史与 DAG');
            const task = await this.kernel.task(target.sessionId, target.taskId);
            if (Object.values(task.effects).some(effect => effect.cleanupPending)) {
                throw new Error('任务已停止调度，但运行资源仍待清理；执行记录已保留');
            }
            this.scheduleRefresh('task-reset');
        } finally {
            this.resettingTasks.delete(key);
        }
    }
    /** Diagnostic counter — enabled with localStorage['vfs:debug']='1'. */
    private noteKernelChange(reason: string): void {
        if (!debugEnabled()) return;
        this.kernelChanges[reason] = (this.kernelChanges[reason] ?? 0) + 1;
    }
    /**
     * Coalesce a burst of structural changes (Task created → started → finished)
     * into one sidebar re-render. Content changes never reach here.
     */
    private updateRemoteAvailability(): void {
        if (!this.visible || this.closed) return;
        const path = this.active;
        void this.applyRemoteAvailability(path).catch(error => this.report(error));
    }
    private async applyRemoteAvailability(path: string | null): Promise<void> {
        if (!this.projects?.remoteMounts) return;
        const target = path && !path.startsWith('draft:') && !path.startsWith('@agent/') ? resolveBrowserTarget(parseSessionRoute(path).path) : undefined;
        const folder = target?.kind === 'project-files' ? target.folder : target?.kind === 'files'
            ? (await this.repository.getManifest(target.sessionId)).folder : undefined;
        const project = folder ? await this.projects.forFolder(folder) : undefined;
        if (this.closed || path !== this.active) return;
        const offline = !!project && this.projects.remoteMounts.projectOffline(project.project.id);
        this.container.inert = offline;
        this.container.classList.toggle('project-workbench--offline', offline);
        this.container.setAttribute('aria-disabled', String(offline));
    }

    private projectHarnessMenu(id: string) {
        const remote=this.projects?.remoteMounts;
        const mount=remote?.list(id).find(mount => mount.at==='/');
        if (!mount?.connectionId || !remote?.connections().find(connection => connection.id === mount.connectionId)?.projects) return [];
        return [{id:'project-harness',label:t('harness.openProject'),onClick:async () => {
            const project=await this.projects!.get(id);
            await showHarnessControl(await remote.projectHarness(id),project.displayName ?? project.name,this.dialogs.signal);
        }}];
    }
    private projectEntryMenu(item: VFSNodeUI, defaults: MenuItem<VFSNodeUI>[]): MenuItem<VFSNodeUI>[] {
        const id = String(item.metadata.custom.projectId), remote = !!item.metadata.custom.remoteProject;
        const hidden = ['create-in-folder-session', 'create-in-folder-folder', ...(remote ? ['delete', 'moveTo', 'copyTo', 'duplicate'] : [])];
        return [{id: 'create-session', label: t('project.createSession'), disabled: !!this.projects && !!sessionCreationReason(this.projects, id), onClick: () => this.startSessionDraft(item.id)},
            { id: 'enter-project', label: t('project.enter'), onClick: () => this.openResource(item.id) },
            ...defaults.filter(entry => !('id' in entry) || !hidden.includes(entry.id))
                .map(entry => 'id' in entry && entry.id === 'rename' ? {...entry, onClick: () => this.renameProjectDialog(id)} : entry),
            ...(remote ? [
                {id: 'remount-project', label: t('remote.remountAs'), onClick: () => this.remountProjectDialog(id)},
                {id: 'unmount-project', label: t('remote.unmountProject'), onClick: () => this.unmountProjectDialog(id)},
            ] : []),
            {type: 'separator'}, ...this.syncMenu.items(id), ...this.projectHarnessMenu(id)];
    }
    private async closeProjectTabs(path: string): Promise<void> {
        const prefix = folderBrowserPath(path);
        for (const tab of this.tabs.values()) if (tab.id === prefix || tab.id.startsWith(prefix + '/')) await this.tabs.close(tab.id, false);
    }
    private async unmountProjectDialog(id: string): Promise<void> {
        const project = await this.projects!.get(id), note = document.createElement('p');
        note.textContent = t('remote.unmountEffect', {name: project.name});
        await showNameDialog(t('remote.unmountProject'), '', this.dialogs.signal, async () => {
            const selected = this.projectNavigation?.currentProject()?.project.id === id;
            await this.projects!.remoteMounts!.assertUnmountable(id); await this.closeProjectTabs(project.path);
            await this.backend.unmountProject(id);
            await this.sidebarUI?.refresh(); await this.projectNavigation?.refresh();
            if (selected) await this.openResource('/');
        }, note, {hideName: true, confirmLabel: t('remote.unmountProject')});
    }
    private async remountProjectDialog(id: string): Promise<void> {
        const project = await this.projects!.get(id), remote = this.projects!.remoteMounts!;
        const root = remote.list(id).find(mount => mount.at === '/')!, panel = document.createElement('div');
        const label = document.createElement('label'); label.textContent = t('remote.remountAs');
        const select = document.createElement('select'); select.setAttribute('aria-label', t('remote.remountAs'));
        for (const mode of ['ro', 'rw'] as const) { const option = document.createElement('option'); option.value = mode; option.textContent = t(`remote.access.${mode}`); select.append(option); }
        select.value = root.access; label.append(select); panel.append(label);
        const note = document.createElement('p'); note.textContent = t('remote.remountEffect'); panel.append(note);
        await showNameDialog(t('remote.remountAs'), '', this.dialogs.signal, async () => {
            const active = this.active, prefix = folderBrowserPath(project.path);
            await remote.assertUnmountable(id); await this.closeProjectTabs(project.path);
            await remote.remountProject(id, select.value as 'ro' | 'rw', {signal: this.dialogs.signal, timeoutMs: 10000});
            await this.sidebarUI?.refresh(); await this.projectNavigation?.refresh();
            if (active === prefix || active?.startsWith(prefix + '/')) await this.openResource(active);
        }, panel, {hideName: true, confirmLabel: t('action.confirm')});
    }
    private async renameProjectDialog(id: string): Promise<void> {
        const project = await this.projects!.get(id);
        await showNameDialog(t('action.rename'), t('project.name'), this.dialogs.signal, async name => {
            if (/[\\/]/.test(name) || name === '.' || name === '..') throw new Error(t('project.error.name'));
            await this.projects!.renameProject(project.path, `${project.parentPath ?? ''}/${name}`);
            await this.refresh();
        }, undefined, { initialName: project.name, confirmLabel: t('project.save') });
    }
    private scheduleRefresh(source: string): void {
        this.viewRefresh.mark(source, this.navigationVisible || !!this.active);
    }
    private async refresh(): Promise<void> { await this.remoteStatus?.refresh(); await this.viewRefresh.flush(); }
    private async refreshView(sources: readonly string[]): Promise<void> {
        if (debugEnabled()) {
            const now = performance.now();
            console.debug(`[SessionWorkbench] refresh #${++this.refreshCount} (${sources.join(', ') || 'explicit'})`
                + ` +${Math.round(now - this.lastRefreshAt)}ms kernel=${JSON.stringify(this.kernelChanges)}`);
            this.lastRefreshAt = now;
        }
        this.kernelChanges = {};
        if (this.navigationVisible && this.navigationReady) {
            await this.browser?.invalidateNavigation({activity: sources.length === 0});
            await this.sidebarUI?.refresh();
            if (!this.visible || this.closed) { this.viewRefresh.mark('visibility-interrupted', false); return; }
            await this.projectNavigation?.refresh(); this.updateRemoteAvailability();
        }
        if (!this.visible || this.closed) { this.viewRefresh.mark('visibility-interrupted', false); return; }
        await this.syncBranchRoute();
        for (const id of this.waiting) this.sidebarUI?.setNodeAttention(await this.sessionPath(id), t('project.waitingInput'));
        if (this.active?.startsWith('/')) {
            const target = resolveBrowserTarget(this.active);
            if (target.kind === 'task') await this.showTask(this.active);
            else if (target.kind === 'folder' || target.kind === 'favorites' || target.kind === 'project-conversations' || target.kind === 'remote' && !target.nativeSessionId && !target.draft
                || target.kind === 'tasks') await this.showDirectory(this.active);
        }
        this.navigationReadAt = performance.now();
    }
    private message(text: string): void {
        const node = document.createElement('div'); node.className = 'mm-placeholder'; node.textContent = text;
        this.tabs.content.replaceChildren(node);
    }
    private report(error: unknown): void {
        if (this.closed) return;
        const route = this.pendingTarget?.id ?? this.active;
        if (route && !route.startsWith('draft:')) void this.reportNavigationFailure(error, parseSessionRoute(route).path);
        // View errors only name the operation; the reason a user can act on is the cause.
        const text = describeErrorReason(localizeMountError(error));
        if (!this.editor && !this.previewCleanup && !this.tabs.content.querySelector('.workbench-directory')) this.message(text);
        else {
            const notice = document.createElement('div'); notice.className = 'session-detail__error';
            notice.setAttribute('role', 'alert'); notice.textContent = text; this.tabs.content.append(notice);
        }
    }
    /** Stale bookmarks must not abort the entire application bootstrap. */
    async restoreResource(resourceId: string): Promise<void> {
        try { await this.openResource(resourceId); }
        catch (error) {
            if (localizeMountError(error) !== error) { this.report(error); return; }
            if (!(error instanceof URIError) && !(error instanceof FSError && ['EINVAL', 'ENOENT'].includes(error.code))) throw error;
            if (!this.editor && !this.previewCleanup) { this.active = null; this.activeBranch = undefined; }
            this.report(new Error(t('project.error.staleRoute')));
            this.onSelect(this.getActiveResourceId() ?? '', 'replace');
        }
    }
    private visible = true;
    private readonly viewLoads = new LatestViewLoad();
    private pendingTarget?: { id: string; options: OpenResourceOptions };
    private readonly readCleanup = new Set<Promise<void>>();
    private cancelViewLoad(): void {
        this.viewLoads.cancel();
        ++this.fileNavigationRevision;
        ++this.contentVersion;
        this.projectNavigation?.cancelPending();
        this.sidebarUI?.cancelPendingSelection?.();
    }
    async setVisible(visible: boolean): Promise<void> {
        if (this.visible === visible || this.closed) return;
        this.visible = visible;
        this.agentDrawer?.setVisible(visible && this.navigationVisible);
        this.remoteStatus?.setVisible(visible);
        if (!visible) this.searchPanel?.cancel();
        this.sidebarUI?.setVisible?.(visible && this.navigationVisible);
        if (!visible) {
            ++this.openIntent;
            this.cancelViewLoad();
            this.viewRefresh.pause();
            this.editor?.cancelPendingRender?.();
            try { await Promise.all(this.tabs.values().map(tab => tab.value?.editor?.flushPendingSave?.())); }
            catch (error) { this.report(error); throw error; }
        } else {
            const pending = this.pendingTarget;
            if (pending) await this.openResource(pending.id, pending.options);
            else await this.editor?.activate?.();
            if (this.viewRefresh.dirty || performance.now() - this.navigationReadAt >= 15000) this.refresh();
        }
    }
    private finishReads(cleanup: Promise<void>): void {
        const tracked = cleanup.catch(error => this.report(error));
        this.readCleanup.add(tracked);
        void tracked.finally(() => this.readCleanup.delete(tracked));
    }
    private openIntent = 0;
    private async checkRemoteFiles(path: string, target: ReturnType<typeof resolveBrowserTarget>, load: ViewLoad): Promise<boolean> {
        const remote = this.projects?.remoteMounts;
        this.container.inert = false; this.container.classList.remove('project-workbench--offline'); this.container.setAttribute('aria-disabled', 'false');
        if (!remote || target.kind !== 'project-files' && target.kind !== 'files') return true;
        const folder = browserTargetFolder(target, path, target.kind === 'files' ? (await this.repository.getManifest(target.sessionId)).folder : undefined);
        const project = await this.projects!.forFolder(folder); load.check();
        if (!project) return true;
        try {
            if (remote.list(project.project.id).some(mount => remote.status(mount.mountId) !== 'online'))
                await remote.checkConnections(project.project.id, {timeoutMs: 3000, signal: load.signal});
            load.check();
            if (!remote.projectOffline(project.project.id)) return true;
            const error = new FSError('EIO', t('remote.projectOffline'));
            reportRemoteFailure(error, {stage: 'project-open', projectId: project.project.id});
            if (this.tabs.current) this.tabs.current.failed = true;
            this.container.inert = true; this.container.classList.add('project-workbench--offline'); this.container.setAttribute('aria-disabled', 'true');
            if (this.editor || this.previewCleanup) this.report(error); else this.message(error.message);
            return false;
        } catch (error) {
            if (!(error instanceof ViewLoadCancelled)) reportRemoteFailure(error, {stage: 'project-open', projectId: project.project.id});
            throw error;
        }
    }
    async openResource(resourceId: string, options: OpenResourceOptions = {}): Promise<void> {
        if (resourceId.startsWith('@agent/')) return this.openAgentSettings(decodeURIComponent(resourceId.slice(7)));
        this.onBeforeNavigate?.();
        this.sessions ??= await this.sessionsReady;
        const intent = ++this.openIntent;
        const current = () => intent === this.openIntent && !this.closed;
        if (this.initialSession && this.initialSession.manifest.id !== initialSessionId(resourceId)) {
            const unused = this.initialSession; this.initialSession = undefined; await unused.dispose();
            if (!current()) return;
        }
        if (resourceId.startsWith('draft:') && this.projects) {
            const project = await this.projects.get(resourceId.slice(6));
            const folder = await this.projects.sessionFolder(project);
            if (!current()) return;
            return this.startSessionDraft(folderBrowserPath(folder));
        }
        const parsed = parseSessionRoute(resourceId), route = {...parsed, path: conversationResourcePath(parsed.path)};
        if (!isFlowPath(route.path) && await this.openFavorite(resourceId, route.path, options, current)) return;
        if (!current()) return;
        let path = route.path;
        if (isFlowPath(path)) {
            return Promise.resolve(this.hostContext?.navigate?.({ target: 'flows',
                ...(path === '/@flows' ? {} : { resourceId: path.slice('/@flows'.length) }) }));
        }
        const target = resolveBrowserTarget(path);
        if (target.kind === 'project-draft') {
            const node = await this.navigationFiles?.driver.getNode(path);
            if (!current()) return;
            if (!node) throw new FSError('ENOENT', 'Project draft unavailable');
            return this.startSessionDraft(parentBrowserPath(path));
        }
        if (target.kind === 'remote' && target.draft) {
            const choices = await this.remoteAgentControls(target.folder)?.list();
            const agent = choices?.find(choice => {
                try {return JSON.parse(decodeURIComponent(choice.id.slice(7)))[2] === target.profileId;} catch {return false;}
            });
            if (!agent) throw new Error(t('toolbox.unavailable'));
            return this.startSessionDraft(folderBrowserPath(target.folder), options.initialInputState?.text ? {text: options.initialInputState.text, files: []} : undefined, agent.id);
        }
        this.cancelViewLoad();
        const load = this.viewLoads.begin();
        this.pendingTarget = { id: resourceId, options };
        if (!this.visible) this.viewLoads.cancel();
        const branch = options.branch ?? route.branch;
        const id = target.kind === 'session' ? target.sessionId : path;
        const directoryTarget = target.kind === 'folder' || target.kind === 'favorites' || target.kind === 'project-conversations' || target.kind === 'remote' && !target.nativeSessionId && !target.draft;
        let opened: SessionOpenView | undefined;
        const operation = this.tail.then(async () => {
            if (this.closed) throw new Error('Session workspace closed');
            load.check();
            if (id === this.active && !options.reload && !this.tabs.current?.failed && (branch === undefined || branch === this.activeBranch)) {
                if (target.kind === 'project-files' || target.kind === 'files') this.scheduleFileNavigation(path, options.fileNavigation);
                else if (directoryTarget) {
                    if (!options.preserveProject) this.projectNavigation?.selectScope(path);
                    this.scheduleNavigation(path, {reveal: true, preserveProject: options.preserveProject});
                }
                return;
            }
            if (target.kind === 'favorite') throw new Error('Favorite navigation was not resolved');
            const reusable = this.tabs.get(id);
            let saved = false;
            if (target.kind === 'session' && (!reusable?.value || reusable.failed || options.reload || branch !== undefined && branch !== reusable.value.branch)) {
                await this.flushEditor(); saved = true; load.check();
                await load.read(async () => { opened = await this.prepareEditorSession(target.sessionId); });
            } else if ('sessionId' in target && target.kind !== 'session') await load.read(async () => { await this.prepareSession?.(target.sessionId); });
            const openingManifest = opened?.manifest ?? ('sessionId' in target ? await load.read(() => this.sessions.get(target.sessionId)) : undefined);
            load.check();
            const tabId = id;
            const old = this.tabs.current;
            if (old?.value && !old.value.editor && !old.value.previewCleanup && old.id !== id && id.startsWith(old.id + '/')) this.tabs.keep(old.id);
            await this.leaveEditor(saved); load.check();
            const existing = this.tabs.get(tabId);
            if (existing?.value && !existing.failed && !options.reload && target.kind !== 'task' && target.kind !== 'tasks' && (target.kind !== 'session' || existing.value.branch === (branch ?? openingManifest!.currentBranch ?? 'main'))) {
                this.tabs.activate(tabId); await this.restoreEditor(existing.value);
                if (!await load.read(() => this.checkRemoteFiles(path, target, load))) { this.onSelect(this.getActiveResourceId()!); return; }
                if (directoryTarget || (target.kind === 'files' || target.kind === 'project-files') && !existing.value.editor && !existing.value.previewCleanup) {
                    await refreshDirectoryList(existing.panel); load.check();
                }
                const navigationPath = openingManifest ? `${folderBrowserPath(openingManifest.folder)}/${openingManifest.id}` : path;
                if (target.kind === 'project-files' || target.kind === 'files') this.scheduleFileNavigation(path, options.fileNavigation);
                else if (directoryTarget) {
                    if (!options.preserveProject) this.projectNavigation?.selectScope(path);
                    this.scheduleNavigation(navigationPath, {reveal: true, preserveProject: options.preserveProject});
                }
                else this.scheduleNavigation(navigationPath, {reveal: true, preserveProject: true});
                this.onSelect(this.getActiveResourceId()!); return;
            }
            if (existing?.value) await this.tabs.close(tabId, false);
            await this.tabs.open(tabId, path.split('/').pop() || t('project.workspace'), target.kind !== 'session'); load.check();
            if (!await load.read(() => this.checkRemoteFiles(path, target, load))) {
                this.active = path; this.activeBranch = undefined; this.onSelect(path);
                this.scheduleFileNavigation(path, options.fileNavigation); return;
            }
            if (target.kind === 'session') {
                if (!opened) await load.read(async () => { opened = await this.backend.openSessionView(target.sessionId); });
                this.tabs.setIcon(tabId, ENTITY_ICONS.chat);
            }
            if (directoryTarget) {
                this.active = id;
                this.activeBranch = undefined;
                if (!options.preserveProject) this.projectNavigation?.selectScope(path);
                this.onSelect(id); this.message(t('status.loading'));
                this.scheduleNavigation(path, {reveal: true, preserveProject: options.preserveProject});
                await load.read(() => this.showDirectory(path)); load.check();
                return;
            }
            if (target.kind === 'project-files') {
                if (options.directory || target.path === WORKSPACE_PATH || this.sidebarUI?.getNode(path)?.type === 'directory')
                    await load.read(() => this.showDirectory(path, {signal: load.signal}));
                else await this.openProjectFile(path, target, load);
                load.check();
                if (this.closed) throw new Error('Session workspace closed');
                this.active = path; this.activeBranch = undefined; this.onSelect(path); this.scheduleFileNavigation(path, options.fileNavigation); return;
            }
            if (target.kind === 'remote') {
                const project = await this.projects!.forFolder(target.folder); load.check();
                if (!project || project.path !== target.folder || !target.profileId) throw new Error('Remote project unavailable');
                const controls = await this.projects!.remoteMounts!.projectConversation(project.project.id, target.profileId, target.nativeSessionId, {signal: load.signal, timeoutMs: 3000}, target.archived);
                let remoteEditor: IEditor | undefined;
                try {
                    const mount = await this.editorMount(target.folder); load.check();
                    const tab = this.tabs.get(tabId)!;
                    tab.conversationId = controls.conversationId;
                    if (controls.conversationId) {tab.panel.dataset.conversationId = controls.conversationId; mount.dataset.conversationId = controls.conversationId;}
                    const root = this.projects!.remoteMounts!.list(project.project.id).find(m => m.at === '/')!;
                    const serverName = this.projects!.remoteMounts!.connectionName(root.connectionId!) ?? project.displayName ?? project.name;
                    remoteEditor = await this.factory(mount, {conversation: controls, signal: load.signal,
                        conversationSource: {kind: controls.kind, label: harnessPresentation(controls.kind, target.profileId).label},
                        mountCompactNavigation: container => this.tabs.mountCompactNavigation(container, project.displayName ?? project.name, () => this.toggleSidebar()),
                        onStartConversationDraft: input => this.startSessionDraft(folderBrowserPath(target.folder), input),
                        hostContext: {...this.hostContext, toggleSidebar: () => this.toggleSidebar(),
                            navigate: request => this.hostContext?.navigate(request) ?? Promise.resolve()},
                        title: `${serverName} · ${project.name} · ${controls.kind} · ${target.profileId}`,
                        removeConversationSession: async nativeId => {
                            if (nativeId === target.nativeSessionId) throw new Error(t('branch.deleteCurrentHint'));
                            const result = await this.backend.manageRemoteSession(target.folder, target.profileId!, nativeId, {kind: 'delete', preserveSessionId: target.nativeSessionId}, {signal: this.dialogs.signal, timeoutMs: 30_000});
                            for (const tab of this.tabs.values()) {
                                if (tab.id.startsWith('@agent/')) continue;
                                const route = resolveBrowserTarget(tab.id);
                                if (route.kind === 'remote' && route.folder === target.folder && route.profileId === target.profileId
                                    && route.nativeSessionId && result.deletedSessionIds.includes(route.nativeSessionId)) await this.tabs.close(tab.id, false);
                            }
                            await this.sidebarUI?.refresh();
                        },
                        onConversationSession: nativeId => {
                            if (nativeId === target.nativeSessionId) return;
                            const next = remoteSessionPath(target.folder, target.profileId, nativeId);
                            setTimeout(() => { if (this.active === path && !this.closed) void this.openResource(next).then(async () => {
                                await this.tabs.close(tabId, false); await this.sidebarUI?.refresh();
                            }).catch(error => this.report(error)); }, 0);
                        }, initialInputState: {...options.initialInputState, agentId: 'remote:' + JSON.stringify([root.connectionId, target.profileId])}});
                    load.check(); this.editor = remoteEditor;
                } catch (error) { if (remoteEditor) await remoteEditor.destroy(); else await controls.close(); throw error; }
                this.tabs.setIcon(tabId, ENTITY_ICONS.remoteSession);
                this.remoteStatus.attach(tabId, project.project.id);
                this.tabs.title(tabId, target.draft ? t('harness.create') : controls.snapshot().title);
                this.active = path; this.activeBranch = undefined; this.onSelect(path);
                this.scheduleNavigation(path, {reveal: true, preserveProject: true});
                return;
            }
            const manifest = openingManifest!;
            const suffix = target.kind === 'session' ? '' : target.kind === 'files' ? '/files' + (target.path === '/' ? '' : target.path)
                : target.kind === 'tasks' ? '/tasks' : '/tasks/' + target.taskId;
            path = `${folderBrowserPath(manifest.folder)}/${target.sessionId}${suffix}`;
            if (target.kind === 'session' || target.kind === 'files') {
                const cwd = target.kind === 'session' ? undefined : target.path.slice(0, target.path.lastIndexOf('/')) || '/';
                let acquired: FileSystemContextOwner | undefined;
                let assets: FileSystemView | undefined;
                let editor: IEditor | undefined;
                let previewCleanup: (() => void) | undefined;
                let mount: HTMLElement | undefined;
                try {
                    const prepared = opened;
                    const context = prepared
                        ? (acquired = { context: prepared.context, release: () => prepared.dispose() })
                        : await load.read(async () => acquired = await this.files.acquireFiles(target.sessionId, cwd));
                    opened = undefined;
                    load.check();
                    mount = await this.editorMount(manifest.folder, target.kind === 'session' ? manifest.id : undefined, { manifest, ...(prepared ? { project: prepared.project } : {}) });
                    if (target.kind === 'session') {
                        const tab = this.tabs.get(tabId)!; tab.conversationId = manifest.id;
                        tab.panel.dataset.conversationId = manifest.id; mount.dataset.conversationId = manifest.id;
                    }
                    load.check();
                    const fileNode = target.kind === 'files' ? await load.read(() => context.context.fs.driver.getNode(target.path)) : undefined;
                    if (fileNode) this.tabs.setIcon(tabId, this.sidebarUI!.getResourceIcon(fileNode));
                    if (fileNode?.type === 'directory') {
                        await context.release(); acquired = undefined;
                        load.check(); await this.showDirectory(path);
                    } else if (target.kind === 'session') {
                        load.check();
                        assets = createFileSystemView({ viewId: `editor-attachments:${target.sessionId}`, mounts: [{ mountId: 'attachments', at: '/', root: '/attachments', fs: context.context.fs, access: 'rw' }] });
                        editor = await load.read(async () => editor = await this.factory(mount!,
                            await this.localEditorOptions(prepared!, context, assets!, branch, options.initialInputState, load.signal)));
                    } else {
                        let revision: string | undefined;
                        const bytes = await load.read(() => context.context.fs.driver.readContent(target.path, { encoding: 'binary', signal: load.signal, onRevision: value => { revision = value; } }));
                        load.check();
                        let content: string | undefined;
                        try {
                            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                            const binaryExtension = /\.(pdf|zip|gz|tar|7z|rar|png|jpe?g|gif|webp|avif|ico|mp[34]|wav|ogg|webm|mov|woff2?|ttf|bin|sqlite|db|docx?|xlsx?|pptx?)$/i.test(target.path);
                            if (!binaryExtension && !decoded.includes('\0')) content = decoded;
                        } catch { /* Binary content is downloaded without decoding. */ }
                        if (content === undefined) {
                            previewCleanup = this.showBinary(mount, target.path, bytes);
                        } else {
                            const readOnly = (await context.context.fs.capabilitiesAt(target.path)).readonly;
                            editor = await load.read(async () => editor = await createRecoverableFileEditor(this.fileFactory, mount!, { ...fileContentFormat(target.path), target: { kind: 'file', path: target.path }, files: context.context,
                                mountWindowList: container => this.tabs.mountWindowList(container),
                                initialContent: content, signal: load.signal, title: target.path.split('/').pop(), readOnly,
                                hostContext: { chatFromFile: this.hostContext?.chatFromFile
                                    ? reference => this.hostContext!.chatFromFile!(reference, { sessionId: target.sessionId }) : undefined,
                                    openFile: async (file, anchor) => this.openLinkedFile((await this.sessionPath(target.sessionId)) + '/files' + file, anchor),
                                    toggleSidebar: () => this.toggleSidebar(), navigate: request => this.hostContext?.navigate(request) ?? Promise.resolve(),
                                    saveContent: readOnly ? undefined : async (_path, text) => {
                                        // A failed write must never look like a successful save: the
                                        // editor keeps its dirty state, and the user is told now.
                                        try { await context.context.fs.driver.writeContent(target.path, text, { ifRevision: revision, onRevision: value => { revision = value; } }); }
                                        catch (error) { const failure = localizeRemoteWriteError(error); this.report(failure); throw failure; }
                                        this.refresh();
                                    } },
                            }, 'session:' + target.sessionId));
                        }
                    }
                    load.check();
                    if (this.closed) throw new Error('Session workspace closed');
                    if (editor || previewCleanup) {
                        this.editor = editor; this.context = context; this.assets = assets; this.previewCleanup = previewCleanup;
                        // L4: an open file activates Skills whose globs match it.
                        if (target.kind === 'files') this.mountEditorSkills(target.sessionId, target.path);
                    }
                } catch (error) {
                    mount?.remove();
                    const cleanup = load.drain().then(async () => {
                        try { previewCleanup?.(); await editor?.destroy(); }
                        finally { await Promise.allSettled([assets?.dispose(), acquired?.release()]); }
                    });
                    if (error instanceof ViewLoadCancelled) this.finishReads(cleanup); else await cleanup;
                    throw error;
                }
            } else if (target.kind === 'tasks') await this.showDirectory(path);
            else await this.showTask(path);
            load.check();
            if (this.closed) throw new Error('Session workspace closed');
            this.active = id;
            this.activeBranch = target.kind === 'session' ? branch ?? manifest.currentBranch ?? 'main' : undefined;
            this.onSelect(this.getActiveResourceId()!);
            this.scheduleNavigation(path, {reveal: true, preserveProject: true});
        });
        const result = operation.then(() => {
            if (this.viewLoads.isCurrent(load) && this.tabs.current) {
                this.pendingTarget = undefined;
                this.retainEditor(this.viewLoads.detach(load));
            }
        }).catch(async error => {
            if (this.viewLoads.isCurrent(load) && error instanceof FSError
                && (error as FSError & { reason?: string }).reason === 'PROJECT_ROOT_OVERLAP') {
                this.showProjectAccessError(error, id);
                return;
            }
            if (!(error instanceof ViewLoadCancelled)) {
                if (load.signal.aborted) return;
                await this.reportNavigationFailure(error, path);
                if (!this.viewLoads.isCurrent(load)) return;
                if (this.tabs.current?.id === id) {
                    this.active = id; this.activeBranch = undefined; this.tabs.current.failed = true;
                    this.message(describeErrorReason(localizeMountError(error))); this.onSelect(id);
                    this.scheduleNavigation(path, {reveal: true, preserveProject: directoryTarget ? options.preserveProject : true});
                } else if (!this.editor && this.tabs.current?.value) await this.restoreEditor(this.tabs.current.value);
                throw error;
            }
            if (this.closed) throw new Error('Session workspace closed');
        }).finally(async () => {
            const cleanup = load.drain().then(async () => { await opened?.dispose(); });
            if (load.signal.aborted) this.finishReads(cleanup); else await cleanup;
            if (this.viewLoads.isCurrent(load)) this.pendingTarget = undefined;
        });
        this.tail = result.catch(() => {}); return result;
    }
    private async prepareEditorSession(id: string): Promise<SessionOpenView> {
        const prepared = this.initialSession; this.initialSession = undefined;
        if (prepared?.manifest.id === id) return prepared;
        await prepared?.dispose();
        return this.backend.openSessionView(id);
    }
    private async activatePrepared(prepared: SessionOpenView, branch?: string) {
        const initial = this.initialData; this.initialData = undefined;
        if (initial?.sessionId === prepared.manifest.id && (!branch || branch === initial.manifest.currentBranch)) return initial;
        return prepared.activate(branch);
    }
    private async reportNavigationFailure(error: unknown, path: string): Promise<void> {
        try {
            const target = resolveBrowserTarget(path);
            if (target.kind === 'remote') {
                reportRemoteFailure(error, {stage: target.nativeSessionId ? 'session-open' : 'directory-open', profileId: target.profileId, sessionId: target.nativeSessionId});
                return;
            }
            const folder = browserTargetFolder(target, path, 'sessionId' in target ? (await this.repository.getManifest(target.sessionId)).folder : undefined);
            const project = await this.projects?.forFolder(folder);
            const remote = project && this.projects?.remoteMounts?.list(project.project.id).some(mount => mount.connectionId);
            if (remote) reportRemoteFailure(error, {stage: 'project-open', projectId: project!.project.id});
        } catch { /* Diagnostic lookup must not replace the original navigation failure. */ }
    }
    private showProjectAccessError(error: FSError, resourceId: string): void {
        const details = error as FSError & { projectId?: string; location?: unknown; conflictingProjects?: unknown };
        console.warn('[Project access] Root overlap', { resourceId, projectId: details.projectId,
            location: details.location, conflictingProjects: details.conflictingProjects });
        const panel = document.createElement('div'); panel.className = 'session-detail';
        const notice = document.createElement('p'); notice.setAttribute('role', 'alert');
        notice.dataset.projectAccessError = ''; notice.textContent = error.message;
        panel.append(notice); this.tabs.content.replaceChildren(panel);
        this.active = resourceId; this.activeBranch = undefined;
        this.onSelect(resourceId);
    }
    private async syncBranchRoute(): Promise<void> {
        // Serialize reconciliation with navigation so a stale read cannot close a newer editor.
        const operation = this.tail.then(async () => {
            if (this.closed || !this.visible || !this.active) return;
            const id = this.active; if (id.startsWith('draft:') || id.startsWith('@agent/')) return;
            const target = resolveBrowserTarget(id.startsWith('/') ? id : '/' + id);
            if (!('sessionId' in target)) return;
            const manifest = await this.sessions.get(target.sessionId).catch(async error => {
                if (!this.visible || this.closed) return undefined;
                if (error?.code !== 'ENOENT') throw error;
                if (this.tabs.current) await this.tabs.close(this.tabs.current.id, false);
                else await this.closeEditor();
                this.message('选择一个会话，或新建会话');
                this.onSelect('', 'replace');
                return undefined;
            });
            if (this.closed || !this.visible || !manifest || this.activeBranch === undefined || !this.editor) return;
            this.familyActions?.updateMetadata(manifest);
            const current = manifest.currentBranch ?? 'main';
            if (current !== this.activeBranch) {
                this.activeBranch = current;
                const tab = this.tabs.current;
                if (tab?.value) { tab.value.branch = current; }
                this.onSelect(sessionRoute(id, current), 'push');
            }
        });
        this.tail = operation.catch(() => {});
        await operation;
    }
    private async reloadAfterMount(sessionId: string): Promise<void> {
        if (this.closed) return;
        this.refresh();
        if (this.active === sessionId) {
            const manifest = await this.sessions.get(sessionId);
            await this.openResource(sessionId, { reload: true, branch: manifest.currentBranch });
        }
    }
    private async manageMounts(sessionId: string): Promise<void> {
        if (this.directoryMounts && await showMountDialog(this.directoryMounts, this.files, sessionId, 'mount', this.dialogs.signal)) await this.reloadAfterMount(sessionId);
    }
    private showBinary(mount: HTMLElement, path: string, bytes: ArrayBuffer): () => void {
        const extension = path.split('.').pop()?.toLowerCase() ?? '';
        const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
        const url = URL.createObjectURL(new Blob([bytes], { type: imageTypes[extension] ?? 'application/octet-stream' }));
        const panel = document.createElement('div'); panel.className = 'session-detail';
        const title = document.createElement('h2'); title.textContent = path.split('/').pop() ?? path; panel.append(title);
        if (imageTypes[extension]) { const image = document.createElement('img'); image.src = url; image.alt = title.textContent; image.style.maxWidth = '100%'; panel.append(image); }
        const download = document.createElement('a'); download.href = url; download.download = title.textContent; download.textContent = '下载文件'; panel.append(download);
        mount.replaceChildren(panel);
        return () => URL.revokeObjectURL(url);
    }
    private async showDirectory(path: string, source?: {fs?: IFileSystem; node?: FSNode; signal?: AbortSignal}): Promise<void> {
        if (!this.browser) throw new Error('Session browser not started');
        const target = resolveBrowserTarget(path);
        if (target.kind === 'tasks') return this.showTasks(target.sessionId);
        const generation = ++this.contentVersion;
        const {nodes, node: directoryNode} = target.kind === 'project-files' || target.kind === 'files'
            ? await traceBoot('projectDirectory.read', () => this.browser!.readFileDirectory(path, source))
            : await Promise.all([projectDirectoryNodes(this.navigationFiles!, path), this.navigationFiles!.driver.getNode(path)])
                .then(([nodes, node]) => ({nodes, node}));
        if (this.closed || generation !== this.contentVersion) return;
        const panel = document.createElement('div'); panel.className = 'session-detail session-detail--directory';
        const heading = document.createElement('h2');
        heading.textContent = path === '/' ? t('workbench.allProjects') : directoryNode ? directoryEntryName(directoryNode) : t('workbench.allProjects');
        if (this.closed || generation !== this.contentVersion) return;
        panel.append(heading);
        if (this.projects && target.kind === 'folder') {
            const project = await this.projects.forFolder(folderPathFromBrowserPath(path));
            if (this.closed || generation !== this.contentVersion) return;
            if (project) {
                const directory = document.createElement('p'); directory.className = 'project-workbench__directory';
                directory.textContent = project.project.directory.startsWith('host:') ? project.project.directory.slice(5) : t('project.managedDirectory'); panel.append(directory);
                const remote = this.projects.remoteMounts?.list(project.project.id).find(mount => mount.at === '/');
                if (remote?.connectionId) directory.textContent = `${this.projects.remoteMounts!.connectionName(remote.connectionId) ?? project.displayName ?? project.name}: /${remote.alias}${remote.root === '/' ? '' : remote.root}`;
            }
        }
        if (target.kind === 'files' && target.path === '/' && this.directoryMounts) {
            const button = document.createElement('button'); button.textContent = '挂载目录 / 管理挂载';
            button.onclick = () => { void this.manageMounts(target.sessionId).catch(error => this.report(error)); }; panel.append(button);
            if (nodes.every(node => node.name === 'attachments')) { const hint = document.createElement('p'); hint.textContent = '尚未挂载工作目录，此会话仅能访问附件'; panel.append(hint); }
        }
        if (target.kind === 'files' && target.path === '/' && this.manageTwin) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = t('twin.title');
            button.onclick = () => { void this.manageTwin!(target.sessionId).catch(error => this.report(error)); }; panel.append(button);
        }
        if (target.kind === 'files' && target.path === '/' && this.manageMemory) {
            const button = document.createElement('button'); button.textContent = t('memory.manage.title');
            button.onclick = () => { void this.manageMemory!(target.sessionId, this.dialogs.signal).catch(error => this.report(error)); };
            panel.append(button);
        }
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        const actions = await projectDirectoryActions(path, directoryNode, this.projects, {
            session: folder => this.startSessionDraft(folder), project: () => this.createProject('/'),
            entry: (directory, type) => this.createDirectoryEntry(directory, type), report: error => this.report(error),
        });
        if (this.closed || generation !== this.contentVersion) return;
        const search = this.projects && this.search ? await createProjectDirectorySearch(path, this.projects, this.search,
            (row, query) => this.openSearchMatch(row, query)) : undefined;
        search?.setSessionFilter(this.agentFilter);
        if (this.closed || generation !== this.contentVersion) { search?.destroy(); return; }
        if (search) this.tabs.current!.subscriptions.push(() => search.destroy());
        const favorites = this.projects ? directoryFavoriteAction(this.projects, this.repository, nodes) : undefined;
        const breadcrumbs = directoryBreadcrumbs(path, heading.textContent);
        const openDirectory = (id: string) => { void this.openResource(id, {directory: true}).catch(error => this.report(error)); };
        const list = createDirectoryList({ title: heading.textContent || t('project.workspace'), path,
            breadcrumbs, openDirectory,
            entries: nodes.map(node => this.directoryEntry(node)),
            initialSort: target.kind === 'project-conversations' || target.kind === 'folder' && nodes.some(node => node.metadata.harnessKind)
                || target.kind === 'remote' && target.profileId ? {key: 'modified', ascending: false} : undefined,
            open: id => { void this.openResource(id, {directory: nodes.find(node => node.path === id)?.type === 'directory'}).catch(error => this.report(error)); },
            parent: path === '/' ? undefined : () => { void this.openResource(parent, {directory: true}).catch(error => this.report(error)); },
            refresh: () => this.directoryEntries(path, favorites?.update),
            menu: event => { void this.showDirectoryMenu(event, target.kind === 'project-conversations' ? folderBrowserPath(target.folder) : path).catch(error => this.report(error)); },
            contextMenu: (event, id) => { void this.showDirectoryMenu(event, id).catch(error => this.report(error)); },
            select: ids => this.selectDirectoryItems(ids),
            selectedIds: () => this.sidebarUI?.getSnapshot().selectedIds ?? [],
            bulkActions: this.sidebarUI && (target.kind === 'project-files' || target.kind === 'files')
                ? directoryBulkActions(this.sidebarUI, ids => this.selectDirectoryItems(ids)) : undefined,
            favorite: favorites, search,
            actions });
        list.dataset.compactPath = 'true';
        this.tabs.setNavigationLabel(this.tabs.current!.id, createDirectoryBreadcrumbs(breadcrumbs, openDirectory));
        heading.remove(); panel.append(list); this.tabs.title(this.tabs.current!.id, list.querySelector('h2')!.textContent!);
        if (this.sidebarUI) this.tabs.current!.subscriptions.push(watchDirectorySelection(panel, this.sidebarUI));
        this.tabs.setIcon(this.tabs.current!.id, this.sidebarUI?.getNode(path)?.icon ?? FILE_ICONS.folder);
        if (!this.closed) this.tabs.content.replaceChildren(panel);
        if (this.navigationFiles?.on && target.kind !== 'files' && target.kind !== 'project-files')
            this.tabs.current!.subscriptions.push(watchDirectoryList(this.navigationFiles, panel, error => this.report(error)));
    }
    private async directoryEntries(path: string, update?: (nodes: FSNode[]) => void) {
        await this.browser?.invalidateNavigation();
        const nodes = await projectDirectoryNodes(this.navigationFiles!, path);
        update?.(nodes);
        if (this.active === path) {
            await this.sidebarUI?.refresh();
            if (this.active === path) await this.projectNavigation?.refresh();
        }
        return nodes.map(node => this.directoryEntry(node));
    }
    private async showDirectoryMenu(event: MouseEvent, id: string): Promise<void> {
        await this.sidebarUI?.showItemMenu(event, id);
        for (let parent = parentBrowserPath(id); parent !== '/'; parent = parentBrowserPath(parent)) {
            if (resolveBrowserTarget(parent).kind !== 'project-conversations') break;
            this.sidebarUI?.setExpanded(parent, false);
        }
    }
    private directoryEntry(node: FSNode): DirectoryEntry {
        const target = resolveBrowserTarget(node.path), remote = target.kind === 'remote';
        return {id: node.path, name: directoryEntryName(node), type: target.kind === 'session' || remote && target.nativeSessionId ? 'session' : node.type,
            icon: this.sidebarUI!.getResourceIcon(node), created: node.createdAt > 0 ? node.createdAt : undefined,
            modified: node.modifiedAt > 0 ? node.modifiedAt : undefined, size: !remote && node.type === 'file' ? node.size : undefined,
            priority: navigationPriority(node.path),
            disabled: node.metadata._disabled === true, description: localSessionStatus(node.metadata.sessionActivity)?.text
                || String(node.metadata.navigationDescription ?? node.metadata.harnessLabel ?? '')};
    }
    private async createDirectoryEntry(path: string, type: 'file' | 'directory'): Promise<void> {
        await showNameDialog(t(type === 'file' ? 'project.createFile' : 'project.createFolder'), t('project.newFileName'), this.dialogs.signal, async name => {
            const driver = this.navigationFiles!.driver;
            if (type === 'file') await driver.createFile({ parentPath: path, name, content: '' });
            else await driver.createDirectory({ parentPath: path, name });
            await this.sidebarUI?.refresh();
            await this.openResource(path, { reload: true });
        });
    }
    private showTasks(sessionId: string): Promise<void> { return this.taskView.list(sessionId); }
    private showTask(path: string): Promise<void> { return this.taskView.detail(path); }
    private async exportSelection(context: VFSToolbarContext): Promise<void> {
        if (!context.selectedIds.length) throw new Error(t('vfs.toolbar.selectExport'));
        const archive = await (await this.backend.archiveExporter()).export(await Promise.all(context.selectedIds.map(path => archiveTarget(path, this.projects!))));
        if (!this.closed) downloadArchive(JSON.stringify(archive, null, 2));
    }
    private async importSelection(context: VFSToolbarContext): Promise<void> {
        const path = context.selectedIds[0] ?? context.parentPath ?? context.activeId ?? '/';
        const file = await chooseArchive(this.dialogs.signal);
        if (!file || this.closed) return;
        const content = await file.text();
        if (this.closed) return;
        await (await this.backend.archiveImporter()).import(content, await archiveTarget(path, this.projects!));
        if (this.closed) return;
        await this.sidebarUI?.refresh();
        await this.projectNavigation?.refresh();
    }
    private async exportSessionItem(item: { path: string; type: string }): Promise<{ name: string; content: string; mimeType: string } | null> {
        const target = resolveBrowserTarget(item.path);
        if (target.kind === 'remote' && target.profileId && target.nativeSessionId && this.projects)
            return this.backend.exportRemoteSession(target.folder, target.profileId, target.nativeSessionId, {signal: this.dialogs.signal, timeoutMs: 20_000});
        if (target.kind !== 'session') return null;
        return this.backend.exportSession(target.sessionId);
    }

    private async sessionPath(id: string): Promise<string> {
        const manifest = await this.sessions.get(id);
        return `${folderBrowserPath(manifest.folder)}/${id}`;
    }
    private fileNavigation: Promise<void> = Promise.resolve();
    private fileNavigationRevision = 0;
    private directorySelectionRevision = 0;
    private selectDirectoryItems(ids: string[]): void {
        ++this.directorySelectionRevision;
        this.sidebarUI?.cancelPendingSelection?.();
        this.sidebarUI?.setSelection(ids);
    }
    /** File content is ready before optional navigation I/O; stale work cannot select a newer route. */
    private scheduleFileNavigation(path: string, mode?: ProjectFileView): void {
        this.scheduleNavigation(path, {reveal: true, fileView: mode, preserveProject: true}, mode !== 'preserve');
    }
    private scheduleNavigation(path: string, options: ProjectNavigationOptions, select = true): void {
        this.pendingNavigation = {path, options, select};
        if (!this.navigationVisible || !this.navigationReady) return;
        const revision = ++this.fileNavigationRevision, active = this.active, selection = this.directorySelectionRevision;
        const current = () => !this.closed && this.visible && this.navigationVisible && revision === this.fileNavigationRevision && this.active === active;
        this.sidebar.inert = true;
        this.fileNavigation = this.fileNavigation.then(async () => {
            if (!current()) return;
            await traceBoot('projectFile.navigation', async () => this.projectNavigation?.sync(path, options));
            if (current() && !this.editor && !this.previewCleanup && !this.tabs.current?.failed && !this.container.inert) await this.sidebarUI?.expandPath(path);
            if (current() && select && selection === this.directorySelectionRevision) await this.selectPath(path);
            if (current()) this.pendingNavigation = undefined;
        }).catch(error => { if (current()) this.report(error); }).finally(() => { if (revision === this.fileNavigationRevision) this.sidebar.inert = false; });
    }
    /**
     * Follow a favorite row to its live resource. Returns false when the route is not a
     * favorite, so the caller keeps handling it as a normal navigation target.
     */
    private async openFavorite(resourceId: string, routePath: string, options: OpenResourceOptions, current: () => boolean): Promise<boolean> {
        const projects = this.projects;
        const favorite = projects && resolveBrowserTarget(routePath);
        if (!projects || favorite?.kind !== 'favorite') return false;
        const resolved = await this.backend.resolveFavorite(favorite.folder, favorite.favoriteId);
        if (!current()) return true;
        await this.openResource(resolved.path, { ...options, fileNavigation: fileViewFor(resolved.kind) });
        // The resolved file is now active; keep the favorite row selected instead of its target.
        if (resolved.kind === 'file' && this.active === resolved.path) await this.selectPath(resourceId);
        return true;
    }
    private async selectPath(path: string): Promise<void> {
        if (!this.navigationVisible || !this.navigationReady) {
            this.pendingNavigation = {path, options: {reveal: true, preserveProject: true}, select: true}; return;
        }
        const project = this.projectNavigation?.registeredProjects().filter(item => path.startsWith(folderBrowserPath(item.path) + '/'))
            .sort((a, b) => b.path.length - a.path.length)[0];
        const recent = project && this.sidebarUI?.getNode(projectConversationsPath(project.path, {recent: true}));
        const row = recent?.children?.find(item => item.metadata.custom.navigationTarget === path);
        await this.sidebarUI?.selectPath(row?.id ?? path);
    }
    private async creationFolder(parent?: string | null): Promise<string | null> {
        const root = this.sidebarUI?.getContentRoot?.();
        const selected = this.active?.startsWith('/') ? this.active : this.sidebarUI?.getActiveSession()?.id;
        const draftProject = parent == null && this.active?.startsWith('draft:') && this.projects
            ? await this.projects.get(this.active.slice(6)) : undefined;
        const path = parent ?? (draftProject ? folderBrowserPath(draftProject.path) : undefined)
            ?? (root && selected?.startsWith(root + '/') ? selected : root) ?? selected ?? this.active;
        let folder = path ? folderPathFromBrowserPath(path) : null;
        if (path && !isFlowPath(path)) {
            const target = resolveBrowserTarget(path.startsWith('/') ? path : '/' + path);
            if (target.kind === 'session') folder = (await this.sessions.get(target.sessionId)).folder ?? null;
        }
        if (!this.projects) return folder;
        const project = await this.projects.forFolder(folder);
        if (!project) throw new Error(t('project.selectForSession'));
        const reason = sessionCreationReason(this.projects, project.project.id);
        if (reason) throw new Error(reason);
        return folder && folder.startsWith(project.path + '/') ? folder : this.projects.sessionFolder(project);
    }
    private actionButton(parent: HTMLElement, label: string, action: () => Promise<unknown>): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.onclick = () => { button.disabled = true; void action().catch(error => this.report(error)).finally(() => { button.disabled = false; }); };
        parent.append(button); return button;
    }
    private async removeSession(id: string): Promise<void> {
        await this.lifecycle.deleteSession(id);
        for (const tab of this.tabs.values()) if (tab.value?.active === id) await this.tabs.close(tab.id);
        await this.sidebarUI?.refresh();
        await this.projectNavigation?.refresh();
    }
    getNavigationScope(): string {
        return folderBrowserPath(this.projectNavigation?.currentProject()?.path) || '/';
    }
    async restoreNavigationScope(scope: string): Promise<void> {
        ++this.fileNavigationRevision; this.pendingNavigation = undefined;
        this.sidebar.inert = false;
        this.projectNavigation?.cancelPending(); this.sidebarUI?.cancelPendingSelection?.();
        this.projectNavigation?.selectScope(scope); this.sidebarUI?.setSelection([]);
    }
    private toggleSidebar(): void {
        const layout = this.sidebar.closest<HTMLElement>('.mm-layout');
        if (layout && window.matchMedia('(max-width: 768px)').matches) backToPreviousPage(() => { layout.dataset.mobileView = 'list'; });
        else this.sidebarUI?.toggleSidebar();
    }
    private installProjectNavigation(): void {
        this.sidebar.classList.add('project-workbench');
        this.familyActions = new SessionFamilyActions(this.projects!.sessions, this.dialogs.signal, {
            open: id => this.openResource(id, { reload: this.active === id }), child: id => this.createChild(id),
            remove: id => this.removeSession(id),
            changed: async () => { await this.sidebarUI?.refresh(); await this.projectNavigation?.refresh(); },
            report: error => this.report(error),
        });
        this.projectNavigation = new ProjectNavigation(this.projects!, () => this.sidebarUI, {
            refresh: () => this.refresh(),
            projectRenamed: (from, to) => this.remapProjectRoutes(folderBrowserPath(from.path), folderBrowserPath(to.path), to.name),
            projectMenu: async (event, project) => {
                await this.syncMenu.refresh(project.project.id);
                if (!this.dialogs.signal.aborted && this.projectNavigation?.currentProject()?.project.id === project.project.id)
                    await this.sidebarUI?.showItemMenu(event, folderBrowserPath(project.path));
            },
            projectsChanged: projects => { for (const project of projects) void this.syncMenu.refresh(project.project.id)
                .catch(error => reportRemoteFailure(error, {stage: 'sync-status', projectId: project.project.id})); },
            syncIndicator: id => this.syncMenu.indicator(id), syncStatus: id => this.syncMenu.openStatus(id),
            navigate: path => this.openResource(path),
            createSession: path => this.startSessionDraft(path), createChild: id => this.createChild(id),
            retryDeletions: async () => {
                for (const entry of await this.repository.pendingSessionDeletions()) await this.lifecycle.deleteSession(entry.id);
                await this.sidebarUI?.refresh(); await this.projectNavigation?.refresh();
            },
            contentChanged: () => {}, importItems: context => this.importSelection(context), exportItems: context => this.exportSelection(context),
            createProject: path => this.createProject(path), report: error => this.report(error),
        });
    }
    private familyMenu(id: string) {
        const run = (action: () => Promise<unknown>) => () => { void action().catch(error => this.report(error)); };
        return [
            { id: 'new-child', label: t('project.newChild'), onClick: run(() => this.createChild(id)) },
            { id: 'move-under', label: t('project.moveUnder'), onClick: run(() => this.familyActions!.move(id)) },
            { id: 'promote-session', label: t('project.promoteSession'), onClick: run(() => this.familyActions!.promote(id)) },
            { id: 'delete-session-only', label: t('project.deleteSessionOnly'), onClick: run(() => this.familyActions!.remove(id)) },
        ];
    }
    async createChild(parentSessionId: string): Promise<string> {
        if (!this.projects) throw new Error('Projects unavailable');
        const parent = await this.sessions.get(parentSessionId);
        const project = await this.projects.forFolder(parent.folder);
        if (!project) throw new Error(t('project.selectForSession'));
        if (this.projects.remoteMounts?.projectOffline(project.project.id)) throw new Error(t('remote.projectOffline'));
        const id = await this.projects.sessions.createChild(parentSessionId);
        await this.sidebarUI?.refresh(); await this.openResource(id); this.editor?.focus?.(); return id;
    }
    private async createProject(selected?: string | null): Promise<void> {
        const path = selected ?? this.sidebarUI?.getActiveSession()?.id ?? '/';
        const folder = folderPathFromBrowserPath(path);
        const current = await this.projects!.forFolder(folder);
        const parent = current ? current.parentPath : folder;
        await showProjectDialog(this.projects!, parent, this.dialogs.signal, async () => {
            await this.sidebarUI?.refresh(); await this.projectNavigation?.refresh();
        });
    }
    private showWelcome(): void {
        const panel = document.createElement('div'); panel.className = 'mm-placeholder project-workbench__welcome';
        const mark = document.createElement('span'); mark.className = 'project-workbench__mark'; mark.textContent = 'X1';
        const title = document.createElement('h1'); title.textContent = t('project.welcome');
        const hint = document.createElement('p'); hint.textContent = t('project.welcomeHint');
        panel.append(mark, title, hint);
        const project = this.projectNavigation?.currentProject();
        if (project) {
            this.actionButton(panel, t('project.createSession'), () => this.startSessionDraft(folderBrowserPath(project.path)));
        }
        else if (this.projects) this.actionButton(panel, t('project.create'), () => this.createProject('/'));
        this.tabs.content.replaceChildren(panel);
    }
    private remapProjectRoutes(from: string, to: string, title: string): void {
        ++this.fileNavigationRevision;
        for (const tab of this.tabs.values()) {
            const next = remapProjectPath(tab.id, from, to);
            if (next !== tab.id) this.tabs.rename(tab.id, next, tab.id === from ? title : tab.title);
            if (tab.value?.active) tab.value.active = remapProjectPath(tab.value.active, from, to);
        }
        if (this.active) {
            const next = remapProjectPath(this.active, from, to);
            if (next !== this.active) { this.active = next; this.onSelect(this.getActiveResourceId() ?? '', 'replace'); }
        }
    }

    private async describeOpenTab(id: string): Promise<{ context?: string; location?: string }> {
        if (id.startsWith('@agent/')) return {context: t('toolbox.agents'), location: decodeURIComponent(id.slice(7))};
        if (id.startsWith('draft:')) {
            const project = await this.projects?.get(id.slice(6));
            return { context: project?.displayName ?? project?.name, location: project?.path };
        }
        const path = parseSessionRoute(id).path, target = resolveBrowserTarget(path);
        const sessionFolder = 'sessionId' in target ? (await this.sessions.get(target.sessionId)).folder : undefined;
        const folder = browserTargetFolder(target, path, sessionFolder);
        const project = await this.projects?.forFolder(folder);
        return { context: project?.displayName ?? project?.name,
            location: target.kind === 'files' || target.kind === 'project-files' ? target.path : folder ?? '/' };
    }
    private async editorMount(folder?: string | null, sessionId?: string, prepared?: { manifest: ConversationManifest; project?: ProjectFolder | null }): Promise<HTMLElement> {
        const mount = document.createElement('div'); mount.className = 'session-editor-mount';
        const project = prepared && 'project' in prepared ? prepared.project : await this.projects?.forFolder(folder);
        const manifest = prepared?.manifest ?? (sessionId ? await this.sessions.get(sessionId) : undefined);
        this.tabs.content.replaceChildren();
        if (this.tabs.current) {
            this.tabs.context(this.tabs.current.id, project?.displayName ?? project?.name);
            const target = this.tabs.current.id.startsWith('draft:') ? undefined : resolveBrowserTarget(parseSessionRoute(this.tabs.current.id).path);
            this.tabs.location(this.tabs.current.id, target?.kind === 'files' || target?.kind === 'project-files'
                ? target.path : folder ?? project?.path ?? '/');
        }
        if (sessionId && manifest) this.tabs.title(this.tabs.current!.id, manifest.title);
        this.tabs.content.append(mount); return mount;
    }
    private async openProjectFile(_path: string, target: { folder: string; path: string }, load: ViewLoad): Promise<void> {
        if (!this.projects) throw new Error('Projects unavailable');
        const project = await this.projects.forFolder(target.folder); load.check();
        const opened = await openProjectFileEditor(this.projects, target, load, {
            mountWindowList: container => this.tabs.mountWindowList(container),
            factory: this.fileFactory, recoveryScope: 'project:' + (project?.project.id ?? target.folder), mount: () => this.editorMount(target.folder),
            showBinary: (mount, path, bytes) => this.showBinary(mount, path, bytes),
            deferCleanup: cleanup => this.finishReads(cleanup),
            changed: () => this.refresh(),
            host: { chatFromFile: this.hostContext?.chatFromFile
                ? reference => this.hostContext!.chatFromFile!(reference, { projectFolder: target.folder }) : undefined,
                openFile: (file, anchor) => this.openLinkedFile(folderBrowserPath(target.folder) + '/@files' + projectRelativePath(file), anchor),
                toggleSidebar: () => this.toggleSidebar(),
                navigate: request => this.hostContext?.navigate(request) ?? Promise.resolve() },
        });
        if (opened.node.type === 'directory') {
            const read = this.showDirectory(_path, {fs: opened.context.context.fs, node: opened.node, signal: load.signal})
                .finally(() => opened.context.release());
            await load.read(() => read); load.check(); return;
        }
        this.editor = opened.editor; this.context = opened.context; this.previewCleanup = opened.previewCleanup;
        this.tabs.setIcon(this.tabs.current!.id, this.sidebarUI!.getResourceIcon(opened.node));
        this.tabs.title(this.tabs.current!.id, target.path.split('/').pop() || target.path);
        if (opened.editor) this.trackProjectFileRenames(opened.context.context.fs, target.folder, target.path);
    }

    private async openLinkedFile(path: string, anchor?: string): Promise<void> {
        await this.openResource(path);
        if (anchor) await this.editor?.navigateTo({ elementId: anchor });
    }
    private async openSearchMatch(row: ProjectSearchMatch, query: string): Promise<void> {
        const project = await this.projects?.forFolder(row.folder);
        if (!project || project.project.id !== row.projectId) throw new Error(t('project.search.navigateFailed'));
        if (row.bindingIdentity && row.bindingIdentity !== JSON.stringify(this.projects?.remoteMounts?.list(row.projectId))) throw new Error(t('project.search.navigateFailed'));
        const route = row.kind === 'remote-session' ? remoteSessionPath(row.folder, row.profileId!, row.sessionId!, row.archived)
            : row.kind === 'session' ? row.resourcePath! : folderBrowserPath(row.folder) + '/@files/' + row.path;
        if (row.kind === 'session') {
            const manifest = await this.repository.getManifest(row.sessionId!);
            const owner = await this.projects?.forFolder(manifest.folder);
            if (owner?.project.id !== row.projectId || folderBrowserPath(manifest.folder ?? null) + '/' + manifest.id !== route)
                throw new Error(t('project.search.navigateFailed'));
        }
        await this.openResource(row.kind === 'session' && row.branch ? sessionRoute(route, row.branch) : route);
        const activeId = row.kind === 'session' ? row.sessionId : route;
        if (!this.editor || this.active !== activeId) return;
        if (row.itemId) { await this.editor.navigateTo({elementId: row.kind === 'remote-session' ? 'native-item:' + row.itemId : row.itemId}); return; }
        if (row.kind === 'session') return;
        const editor = this.editor, results = await editor.search(searchKeywords(query)[0] ?? query);
        if (this.editor !== editor || this.active !== activeId) return;
        const offset = row.line ? this.editor.getText().split('\n').slice(0, row.line - 1).reduce((size, line) => size + line.length + 1, 0) : 0;
        const result = results.find(match => match.source === 'editor' && match.details.from >= offset) ?? results[0];
        if (result) this.editor.gotoMatch(result);
    }

    private trackProjectFileRenames(fs: IFileSystem, folder: string, path: string): void {
        const editor = this.editor, tab = this.tabs.current!;
        const remap = (event: { payload: { nodes: { oldPath: string; newPath: string }[] } }) => {
            for (const { oldPath, newPath } of event.payload.nodes) {
                if (path !== oldPath && !path.startsWith(oldPath + '/')) continue;
                path = newPath + path.slice(oldPath.length);
                const filename = path.split('/').pop()!;
                editor?.updateNodeId?.(path);
                editor?.setTitle?.(buildRenamedFilename(filename, filename).title);
                const next = folderBrowserPath(folder) + '/@files' + projectRelativePath(path);
                const selected = this.tabs.current === tab;
                this.tabs.rename(tab.id, next, filename); if (tab.value) tab.value.active = next;
                this.tabs.location(next, path);
                if (selected) { this.active = next; if (this.visible) this.onSelect(next, 'replace'); }
                this.scheduleRefresh('file-rename');
            }
        };
        const stops = [fs.on('node:renamed', remap), fs.on('node:moved', remap), fs.on('node:deleted', event => {
            if (event.payload.requestedPaths.some(deleted => path === deleted || path.startsWith(deleted + '/')))
                void this.tabs.close(tab.id, false).catch(error => this.report(error));
        })];
        this.fileRenameCleanup = () => stops.forEach(stop => stop());
    }

    private remoteAgentControls(folder?: string | null, initialProject?: SessionOpenView['project']): import('@itookit/ui-common').RemoteAgentControls | undefined {
        if (!folder || !this.projects?.remoteMounts) return;
        const projects = this.projects;
        const profiles = async () => {
            const project = initialProject !== undefined ? initialProject : await projects.forFolder(folder), remote = projects.remoteMounts!;
            initialProject = undefined;
            const mount = project && remote.list(project.project.id).find(m => m.at === '/' && m.serverProjectId && m.access === 'rw');
            if (!project || !mount) return [];
            const client = await remote.projectHarness(project.project.id, {timeoutMs: 3000});
            try { return (await client.profiles({timeoutMs: 3000})).profiles.filter(p => p.projectRuntime && p.capabilities.create)
                .map(p => ({id: 'remote:' + encodeURIComponent(JSON.stringify([mount.connectionId, mount.serverProjectId, p.id])), name: `${remote.connectionName(mount.connectionId!) ?? project.displayName ?? project.name} · ${p.kind} · ${p.id}`,
                    icon: ENTITY_ICONS.remoteAgent, category: t('harness.remoteAgents'), supportsModels: !!p.capabilities.models, attachmentKinds: p.capabilities.attachments}));
            } finally { await client.close(); }
        };
        return {list: async () => { try { return await profiles(); } catch { return []; } }, models: id => this.remoteAgentModels(folder, id, profiles), send: async (id, text, nativeSelection, files) => {
            if (!(await profiles()).some(p => p.id === id)) throw new Error(t('toolbox.unavailable'));
            const [connectionId, serverProjectId, profileId] = JSON.parse(decodeURIComponent(id.slice('remote:'.length))) as [string, string, string];
            const project = await projects.forFolder(folder);
            if (!project) throw new Error(t('toolbox.unavailable'));
            await this.openResource(remoteSessionPath(project.path, profileId) + '/@new', {initialInputState: {text}});
            const grant = projects.remoteMounts!.list(project.project.id).find(m => m.at === '/');
            if (grant?.connectionId !== connectionId || grant.serverProjectId !== serverProjectId) throw new Error(t('toolbox.unavailable'));
            if (!this.editor?.commands.sendMessage) throw new Error('Remote conversation editor unavailable');
            if (await this.editor.commands.sendMessage({text, ...(files?.length ? {files} : {}), ...(nativeSelection ? {nativeSelection} : {})}) === false) throw new Error(t('toolbox.unavailable'));
        }};
    }
    private async remoteAgentModels(folder: string, id: string, profiles: () => Promise<Array<{id: string; supportsModels?: boolean}>>): Promise<import('@itookit/ui-common').ConversationModelCatalog> {
        if (!(await profiles()).some(profile => profile.id === id && profile.supportsModels)) return {models: []};
        const projects = this.projects!, project = await projects.forFolder(folder);
        if (!project) throw new Error(t('toolbox.unavailable'));
        const [, , profileId] = JSON.parse(decodeURIComponent(id.slice('remote:'.length))) as string[];
        return projects.remoteMounts!.projectModels(project.project.id, profileId!, {timeoutMs: 30000});
    }
    private isRemoteProject(project: ProjectFolder): boolean {
        return project.project.source?.kind === 'remote' || !!this.projects?.remoteMounts?.list(project.project.id).some(mount => mount.at === '/');
    }
    private async openAgentSettings(agentId: string): Promise<void> {
        ++this.openIntent; this.onBeforeNavigate?.(); this.cancelViewLoad(); const load = this.viewLoads.begin();
        const work = this.tail.then(async () => {
            await this.leaveEditor(); load.check();
            const id = '@agent/' + encodeURIComponent(agentId), tab = await this.tabs.open(id, t('toolbox.agents'), false);
            if (tab.value) {await this.restoreEditor(tab.value); this.onSelect(id); return;}
            const mount = document.createElement('div'); mount.className = 'session-detail agent-workspace-editor'; tab.panel.append(mount);
            const editor = await this.createAgentSettingsEditor(agentId, mount, load.signal);
            try {load.check();} catch (error) {await editor.destroy(); mount.remove(); throw error;}
            this.editor = editor; this.active = id; this.activeBranch = undefined;
            this.tabs.context(id, t('toolbox.agents')); this.tabs.setIcon(id, ENTITY_ICONS.agent);
            this.tabs.bind(tab, editor); this.retainEditor(this.viewLoads.detach(load)); this.onSelect(id);
        });
        this.tail = work.catch(() => {}); await work;
    }
    private async createAgentSettingsEditor(agentId: string, mount: HTMLElement, signal: AbortSignal): Promise<IEditor> {
        if (!this.agentOptions || !this.projects) throw new Error(t('toolbox.unavailable'));
        const projects = this.projects;
        const mountSettings: NonNullable<EditorOptions['mountSettings']> = element => mountAgentProjectSettings(element, agentId, projects,
            this.agentProjects, projectId => this.showAgentSessions(agentId, projectId), project => {
                if (!agentId.startsWith('remote:')) return !this.isRemoteProject(project);
                const [connection] = JSON.parse(agentId.slice(7)) as string[];
                return !!projects.remoteMounts?.list(project.project.id).some(item => item.at === '/' && item.connectionId === connection);
            }, !agentId.startsWith('remote:'));
        if (agentId.startsWith('remote:')) {
            const view = await this.agentCatalog.get();
            const editor = new RemoteAgentDetailsEditor(mount, view.inventory, {target: {kind: 'file', path: '/@remote/' + encodeURIComponent(agentId) + '.agent'},
                signal, hostContext: this.hostContext, mountSettings}, projects);
            await editor.init(mount); return editor;
        }
        const definition = await this.agentOptions.read(agentId);
        if (!definition) throw new Error(t('toolbox.unavailable'));
        this.tabs.title('@agent/' + encodeURIComponent(agentId), definition.name);
        return this.agentOptions.createEditor(mount, {target: {kind: 'entity', entityType: 'agent', id: agentId}, signal,
            initialContent: JSON.stringify(definition), title: definition.name, hostContext: this.hostContext, mountSettings});
    }
    private async showAgentSessions(agentId: string, projectId?: string): Promise<void> {
        const configured = projectId ?? await this.agentProjects.read(agentId);
        const project = configured ? await this.projects!.get(configured) : await this.projects!.personal();
        await this.setAgentFilter(agentId);
        await this.openResource(folderBrowserPath(project.path), {reload: true});
    }
    private async setAgentFilter(agentId?: string): Promise<void> {
        if (this.agentFilter === agentId) return;
        if (!this.browser?.setSessionFilter) throw new Error(t('toolbox.unavailable'));
        await this.browser.setSessionFilter(agentId); if (this.closed) return;
        this.agentFilter = agentId; this.agentFilterBar.replaceChildren(); this.agentFilterBar.hidden = !agentId;
        this.searchPanel?.setSessionFilter(agentId);
        if (agentId) {
            const name = agentId.startsWith('remote:') ? (await this.agentCatalog.get()).inventory.remoteAgents.get(agentId)?.name
                : (await this.agentOptions?.read(agentId))?.name;
            const text = document.createElement('span'); text.textContent = t('agentWorkspace.sessionFilter', {name: name ?? agentId});
            this.agentFilterBar.append(text); this.actionButton(this.agentFilterBar, t('agentWorkspace.clearFilter'), async () => {
                await this.setAgentFilter(); const path = this.projectNavigation?.currentProject()?.path;
                if (path) await this.openResource(folderBrowserPath(path), {reload: true});
            });
        }
        await this.sidebarUI?.refresh();
    }
    private async startAgentDraft(agentId: string): Promise<void> {
        this.onBeforeNavigate?.();
        const configured = await this.agentProjects.read(agentId);
        const project = this.projectNavigation?.currentProject() ?? (configured ? await this.projects!.get(configured) : await this.projects!.personal());
        if (this.isRemoteProject(project)) throw new Error(t('agentWorkspace.localAgentProject'));
        if (this.closed) return;
        await this.startSessionDraft(folderBrowserPath(project.path), undefined, agentId);
        if (this.closed || !this.active?.startsWith('draft:')) return;
        this.projectNavigation?.selectScope(folderBrowserPath(project.path));
        const layout = this.container.closest<HTMLElement>('.mm-layout');
        if (layout) layout.dataset.mobileView = 'detail';
    }
    private draftPresentation(project: ProjectFolder): Pick<import('@itookit/ui-common').SessionDraftControls, 'scope' | 'executorScope'> {
        return {executorScope: this.isRemoteProject(project) ? 'remote' : 'local', scope: {
            id: project.project.id, label: project.displayName ?? project.name,
            choices: async () => (await this.projects!.list()).map(item => ({id: item.project.id, label: item.displayName ?? item.name,
                disabled: !!sessionCreationReason(this.projects!, item.project.id)})),
            select: async (id, selectedAgent, preferences) => {
                const target = await this.projects!.get(id);
                const localAgent = !this.isRemoteProject(target) && !selectedAgent?.startsWith('remote:') ? selectedAgent : undefined;
                await this.startSessionDraft(folderBrowserPath(target.path), undefined, preferences ? undefined : localAgent, preferences);
                this.projectNavigation?.selectScope(folderBrowserPath(target.path));
            },
        }};
    }
    private async localEditorOptions(prepared: SessionOpenView, context: FileSystemContextOwner, assets: FileSystemView,
        branch?: string, initialInputState?: EditorOptions['initialInputState'], signal?: AbortSignal): Promise<EditorOptions> {
        const manifest = prepared.manifest, id = manifest.id, project = prepared.project;
        return {signal, mountMoreMenu: this.familyActions ? container => this.familyActions!.mount(container, manifest) : undefined,
            mountCompactNavigation: container => this.tabs.mountCompactNavigation(container, project?.displayName ?? project?.name ?? '', () => this.toggleSidebar()),
            onStartConversationDraft: manifest.folder ? input => this.startSessionDraft(folderBrowserPath(manifest.folder), input) : undefined,
            initialData: await this.activatePrepared(prepared, branch), remoteAgents: this.remoteAgentControls(manifest.folder, project), initialInputState,
            resolveSubmission: project ? () => this.projects!.drafts.submissionForSession(project.project.id, id) : undefined,
            target: {kind: 'session', sessionId: id, branch: branch ?? manifest.currentBranch ?? 'main'}, files: context.context, assets, title: manifest.title,
            hostContext: {...this.hostContext!, directoryCommands: this.sessionDirectoryCommands(prepared), toggleSidebar: () => this.toggleSidebar()}};
    }
    private sessionDirectoryCommands(prepared: SessionOpenView): EditorHostContext['directoryCommands'] {
        if (!this.directoryMounts) return;
        const id = prepared.manifest.id;
        return {workspaceReadOnly: prepared.workspaceReadOnly,
            configureWorkspace: async mode => {if (await showMountDialog(this.directoryMounts!, this.files, id, mode, this.dialogs.signal)) await this.reloadAfterMount(id);},
            addDirectory: async (directory, access) => {
                if (!directory) {await this.manageMounts(id); return '挂载管理已关闭';}
                try {const result = await this.directoryMounts!.addDirectory(id, directory, access); await this.reloadAfterMount(id); return result;}
                catch (error) {throw localizeMountError(error);}
            }, setHome: async directory => {
                try {
                    if (directory) {const result = await this.directoryMounts!.setHome(directory); await this.reloadAfterMount(id); return result;}
                    if (await showMountDialog(this.directoryMounts!, this.files, id, 'home', this.dialogs.signal)) await this.reloadAfterMount(id);
                    return '默认目录设置已关闭';
                } catch (error) {throw localizeMountError(error);}
            }};
    }
    private async prepareLocalDraft(tab: WorkbenchTab<RetainedEditor>, id: string, mount: HTMLElement, signal: AbortSignal, createEditor = this.factory): Promise<IEditor> {
        const prepared = await this.backend.openSessionView(id), context = {context: prepared.context, release: () => prepared.dispose()};
        const assets = createFileSystemView({viewId: `editor-attachments:${id}`, mounts: [{mountId: 'attachments', at: '/', root: '/attachments', fs: prepared.context.fs, access: 'rw'}]});
        let editor: IEditor | undefined;
        try {
            signal.throwIfAborted();
            editor = await createEditor(mount, await this.localEditorOptions(prepared, context, assets, undefined, undefined, signal));
            signal.throwIfAborted();
            if (tab.value) {tab.value.context = context; tab.value.assets = assets;}
            if (this.tabs.current === tab) {this.context = context; this.assets = assets;}
            return editor;
        } catch (error) {
            try {await editor?.destroy();} finally {await Promise.allSettled([assets.dispose(), context.release()]);}
            throw error;
        }
    }
    private async prepareRemoteDraft(tab: WorkbenchTab<RetainedEditor>, project: ProjectFolder, draftId: string,
        request: import('@itookit/ui-common').SessionDraftMaterialization, signal: AbortSignal, nativeId?: string): Promise<IEditor> {
        const choices = await this.remoteAgentControls(project.path)!.list();
        if (!choices.some(choice => choice.id === request.agentId)) throw new Error(t('toolbox.unavailable'));
        const [connectionId, serverProjectId, profileId] = JSON.parse(decodeURIComponent(request.agentId!.slice(7))) as string[];
        const root = this.projects!.remoteMounts!.list(project.project.id).find(item => item.at === '/');
        if (root?.connectionId !== connectionId || root.serverProjectId !== serverProjectId) throw new Error(t('toolbox.unavailable'));
        const controls = await this.projects!.remoteMounts!.projectConversation(project.project.id, profileId!, nativeId, {signal, timeoutMs: 3000}, false, nativeId ? undefined : draftId);
        if (tab.value?.draft) tab.value.draft.remote = controls;
        let editor: IEditor | undefined;
        try {
            editor = await (request.createEditor ?? this.factory)(request.container, {signal, conversation: controls,
                conversationSource: {kind: controls.kind, label: harnessPresentation(controls.kind, profileId).label},
                title: choices.find(choice => choice.id === request.agentId)!.name, initialInputState: {agentId: request.agentId},
                onStartConversationDraft: input => this.startSessionDraft(folderBrowserPath(project.path), input),
                mountCompactNavigation: container => this.tabs.mountCompactNavigation(container, project.displayName ?? project.name, () => this.toggleSidebar()),
                hostContext: {...this.hostContext!, toggleSidebar: () => this.toggleSidebar()},
                onConversationSession: () => {void this.projects!.drafts.reconcile(project.project.id).catch(error => this.report(error));}});
            if (tab.value?.draft) tab.value.draft.remote = controls;
            signal.throwIfAborted(); return editor;
        } catch (error) {
            try {await editor?.destroy();} finally {await controls.close();}
            throw error;
        }
    }
    private async promoteDraftTab(event: ProjectDraftPromotion): Promise<void> {
        const tab = this.tabs.get(`draft:${event.projectId}`), value = tab?.value;
        if (!tab || value?.draft?.id !== event.draftId || this.closed) return;
        const project = await this.projects!.get(event.projectId);
        const path = event.remote ? remoteSessionPath(project.path, event.remote.profileId, event.remote.nativeSessionId) : event.sessionId;
        const title = event.remote ? value.draft.remote?.snapshot?.().title ?? formatDefaultFileTitle() : (await this.sessions.get(event.sessionId)).title;
        const duplicate = this.tabs.get(path), replaceActive = duplicate && duplicate !== tab && this.tabs.current === duplicate;
        if (duplicate && duplicate !== tab) await this.tabs.close(path, false);
        if (this.closed || this.tabs.get(tab.id) !== tab || value.draft?.id !== event.draftId) return;
        this.tabs.rename(tab.id, path, title); this.tabs.setIcon(path, event.remote ? ENTITY_ICONS.remoteSession : ENTITY_ICONS.chat);
        value.active = path; value.branch = event.remote ? undefined : 'main'; value.draft = undefined;
        const mount = tab.panel.querySelector<HTMLElement>('.session-editor-mount')!;
        const confirming = value.editor?.commands.confirmDraft?.((createEditor?: EditorFactory) => event.remote
            ? this.prepareRemoteDraft(tab, project, event.draftId, {container: mount, createEditor,
                agentId: 'remote:' + encodeURIComponent(JSON.stringify([event.remote.connectionId, event.remote.serverProjectId, event.remote.profileId]))}, this.dialogs.signal, event.remote.nativeSessionId)
            : this.prepareLocalDraft(tab, event.sessionId, mount, this.dialogs.signal, createEditor));
        if (event.remote) this.remoteStatus.attach(path, project.project.id);
        if (this.tabs.current === tab) {this.active = path; this.activeBranch = value.branch; this.onSelect(this.getActiveResourceId()!, 'replace');}
        this.scheduleRefresh('project.draftPromoted');
        await confirming;
        if (replaceActive) {this.tabs.activate(path); await this.restoreEditor(value); this.onSelect(this.getActiveResourceId()!, 'replace');}
    }
    async startSessionDraft(parent?: string, input?: {text: string; files: File[]}, agentId?: string,
        preferences?: import('@itookit/ui-common').SessionDraftPreferences): Promise<void> {
        const folder = await this.creationFolder(parent);
        this.cancelViewLoad(); const load = this.viewLoads.begin();
        let receiver: IEditor | undefined;
        const work = this.tail.then(async () => {
            await this.leaveEditor(); load.check();
            this.container.inert = false; this.container.classList.remove('project-workbench--offline');
            const project = await this.projects?.forFolder(folder);
            load.check();
            if (!project || !this.projects || !folder) throw new Error('Project required for a draft');
            this.projectNavigation?.showDraft(project);
            const draftId = `draft:${project.project.id}`;
            const draftPath = folderBrowserPath(project.path) + '/@new';
            const retained = this.tabs.get(draftId);
            const tab = await this.tabs.open(draftId, t('project.createSession'), false);
            this.tabs.setIcon(draftId, FILE_BROWSER_ICONS.newSession);
            if (retained?.value) { await this.restoreEditor(retained.value); receiver = this.editor;
                await this.selectPath(draftPath); this.onSelect(draftPath, 'replace'); return; }
            const mount = await this.editorMount(folder);
            const composer = await this.projects.drafts.open(project.project.id, folder);
            const draftOptions = createProjectDraftControls(composer, {
                check: async () => { load.check(); await this.creationFolder(folderBrowserPath(folder)); },
                identity: id => {
                    tab.conversationId = id; tab.panel.dataset.conversationId = id; mount.dataset.conversationId = id;
                    if (tab.value?.draft) tab.value.draft.id = id;
                },
                remote: request => this.prepareRemoteDraft(tab, project, tab.conversationId ?? composer.id!, request, load.signal),
                open: async (id, request) => {
                    if (request) return this.prepareLocalDraft(tab, id, request.container, load.signal, request.createEditor);
                    await Promise.all([this.openResource(id), this.sidebarUI?.refresh()]);
                    await this.tabs.close(draftId, false);
                    await this.selectPath(await this.sessionPath(id));
                    if (!this.editor) throw new Error('Session editor unavailable');
                    return this.editor;
                },
            }, this.draftPresentation(project));
            const editor = await this.factory(mount, { signal: load.signal, hostContext: {...this.hostContext!, toggleSidebar: () => this.toggleSidebar()},
                mountCompactNavigation: container => this.tabs.mountCompactNavigation(container, project.displayName ?? project.name, () => this.toggleSidebar()), sessionDraft: draftOptions, remoteAgents: this.remoteAgentControls(folder) });
            try { load.check(); } catch (error) { await editor.destroy(); mount.remove(); throw error; }
            this.editor = receiver = editor; this.active = draftId; this.editor.focus?.();
            tab.conversationId = composer.id; tab.panel.dataset.conversationId = composer.id;
            mount.dataset.conversationId = composer.id;
            this.retainEditor(this.viewLoads.detach(load));
            if (tab.value && composer.id) tab.value.draft = {id: composer.id, projectId: project.project.id};
            await this.selectPath(draftPath); this.onSelect(draftPath, 'replace');
        });
        this.tail = work.catch(() => {}); await work;
        if (input && receiver && this.editor === receiver) await receiver.commands.appendDraft?.(input);
        if (agentId && receiver && this.editor === receiver) await receiver.commands.selectDraftAgent?.(agentId);
        if (preferences && receiver && this.editor === receiver) await receiver.commands.inheritDraftPreferences?.(preferences);
    }

    async createResource(options: { title?: string; parentPath?: string | null; initialInputState?: { text?: string; agentId?: string } } = {}): Promise<string> {
        if (this.closed) throw new Error('Session workspace closed');
        const folder = await this.creationFolder(options.parentPath);
        const id = await this.sessions.create(options.title || formatDefaultFileTitle(), folder);
        const opening = this.openResource(id, { initialInputState: options.initialInputState });
        await Promise.all([opening, this.sidebarUI?.refresh()]);
        if (!this.closed && this.active === id) {
            // The editor can finish before its new sidebar entry is available.
            await this.selectPath(await this.sessionPath(id));
        }
        return id;
    }
    getActiveResourceId(): string | null {
        return this.active && this.activeBranch !== undefined ? sessionRoute(this.active, this.activeBranch) : this.active;
    }
    setWaitingInput(id: string, waiting: boolean): void {
        waiting ? this.waiting.add(id) : this.waiting.delete(id);
        if (!this.visible || this.closed) return;
        void this.sessionPath(id).then(path => { if (!this.closed && this.visible) this.sidebarUI?.setNodeAttention(path, this.waiting.has(id) ? t('project.waitingInput') : undefined); }).catch(error => this.report(error));
    }
    /** Editor open/close drives the L4 glob mount; a failure must not break the editor. */
    private mountEditorSkills(sessionId: string, path: string): void {
        this.openEditorTarget = { sessionId, path };
        void this.sessionSkills?.mountByGlob(sessionId, path).catch(error => this.report(error));
    }

    private async unmountEditorSkills(): Promise<void> {
        const open = this.openEditorTarget;
        this.openEditorTarget = undefined;
        if (open) await this.sessionSkills?.unmountByGlob(open.sessionId, open.path).catch(error => this.report(error));
    }

    private clearEditorFields(): void {
        this.editor = undefined; this.context = undefined; this.assets = undefined; this.editorLease = undefined;
        this.previewCleanup = undefined; this.fileRenameCleanup = undefined; this.active = null; this.activeBranch = undefined;
    }
    private retainEditor(cancel?: () => void): void {
        const tab = this.tabs.current; if (!tab || tab.value) return;
        tab.value = { editor: this.editor, context: this.context, assets: this.assets, previewCleanup: this.previewCleanup,
            renameCleanup: this.fileRenameCleanup, active: this.active, branch: this.activeBranch, cancel, skills: this.openEditorTarget };
        this.tabs.bind(tab, this.editor);
    }
    private async restoreEditor(value: RetainedEditor): Promise<void> {
        await value.editor?.activate?.();
        this.editor = value.editor; this.context = value.context; this.assets = value.assets;
        this.previewCleanup = value.previewCleanup; this.fileRenameCleanup = value.renameCleanup;
        this.active = value.active; this.activeBranch = value.branch;
        this.remoteStatus?.activate(this.tabs.current?.id);
        this.familyActions?.activate(this.tabs.current?.panel.querySelector('.session-family__section') ?? null);
        if (value.skills) this.mountEditorSkills(value.skills.sessionId, value.skills.path);
    }
    private async flushEditor(): Promise<void> {
        await this.editor?.flushPendingSave?.();
        if (this.editor?.isDirty?.() && !this.editor.flushPendingSave) throw new Error(t('workbench.pending'));
    }
    private async leaveEditor(saved = false): Promise<void> {
        if (this.tabs.current?.value) {
            if (!saved) await this.flushEditor();
            this.editor?.cancelPendingRender?.(); this.remoteStatus?.activate(undefined);
            await this.unmountEditorSkills(); this.clearEditorFields();
        } else await this.closeEditor();
    }
    private async disposeTab(tab: WorkbenchTab<RetainedEditor>): Promise<void> {
        const value = tab.value; if (!value) return;
        await value.editor?.flushPendingSave?.();
        if (value.editor?.isDirty?.() && !value.editor.flushPendingSave) throw new Error(t('workbench.pending'));
        value.lease ??= new EditorLease(value.editor, async () => {
            value.previewCleanup?.(); value.renameCleanup?.(); value.cancel?.();
            this.familyActions?.release(tab.panel.querySelector('.session-family__section'));
            if (this.openEditorTarget && value.skills?.sessionId === this.openEditorTarget.sessionId && value.skills.path === this.openEditorTarget.path) await this.unmountEditorSkills();
            await Promise.all([value.assets?.dispose(), value.context?.release()]);
        });
        await value.lease.dispose();
        this.remoteStatus?.detach(tab.id);
        if (this.tabs.current === tab) this.clearEditorFields();
    }

    private async closeEditor(): Promise<void> {
        if (!this.editorLease) {
            const editor = this.editor, assets = this.assets, context = this.context;
            this.editorLease = new EditorLease(editor, async () => {
                ++this.contentVersion;
                this.previewCleanup?.(); this.previewCleanup = undefined;
                this.fileRenameCleanup?.(); this.fileRenameCleanup = undefined;
                await this.unmountEditorSkills();
                const results = await Promise.allSettled([assets?.dispose(), context?.release()]);
                const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
                if (errors.length) throw new AggregateError(errors, 'Editor resource cleanup failed');
            });
        }
        await this.editorLease.dispose();
        this.editorLease = undefined;
        this.editor = undefined; this.assets = undefined; this.context = undefined; this.active = null;
        this.activeBranch = undefined;
    }
    async destroy(): Promise<void> {
        ++this.openIntent;
        this.cancelViewLoad();
        this.closed = true; ++this.fileNavigationRevision; this.projectNavigation?.destroy();
        await this.agentDrawer?.destroy();
        await this.agentCatalog.close();
        await this.remoteStatus?.destroy();
        this.searchPanel?.destroy();
        this.sidebarUI?.cancelPendingSelection?.(); this.dialogs.abort(); this.subscriptions.dispose();
        await Promise.all([this.tail, this.viewRefresh.close(), this.navigationTask?.catch(() => {})]); await this.fileNavigation; await Promise.all(this.readCleanup);
        await this.initialSession?.dispose(); this.initialSession = undefined;
        this.sidebarLayout.save(this.tabs.snapshot()); await this.tabs.destroy(); await this.closeEditor(); this.sidebarUI?.destroy(); this.sidebarLayout.destroy();
        if (this.projects?.remoteMounts) {
            this.container.inert = false;
            this.container.classList.remove('project-workbench--offline');
            this.container.removeAttribute('aria-disabled');
        }
        await this.navigationFiles?.dispose(); await this.browser?.dispose(); await this.chatConfiguration?.dispose(); this.tabs.content.replaceChildren();
    }
}

/** Session and Task entries are virtual containers, not writable creation directories. */
function sessionCreationParent(path: string | null): string | null {
    if (!path) return null;
    if (isFlowPath(path)) return null;
    const target = resolveBrowserTarget(path);
    if (target.kind === 'folder' || target.kind === 'files' || target.kind === 'project-files') return path;
    const folders = path.split('/').filter(Boolean);
    const sessionIndex = folders.findIndex(segment => !segment.startsWith('folder:'));
    return sessionIndex > 0 ? '/' + folders.slice(0, sessionIndex).join('/') : null;
}

function isFlowPath(path: string): boolean { return path === '/@flows' || path.startsWith('/@flows/'); }
/** Persisted expansion can name routes this build no longer serves; drop those instead of failing boot. */
function isExpandableDirectory(path: string): boolean {
    if (isFlowPath(path)) return true;
    try { return resolveBrowserTarget(path).kind === 'folder'; } catch { return false; }
}
