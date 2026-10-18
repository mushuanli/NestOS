import {rememberPagePresentation, writePageHistory, type PagePresentation} from './navigation/page-history';
import {withInitialDirectory} from './browser/initial-directory';
import {OpenedViewProjection} from './lifecycle/opened-view';
import {openInitialView} from './lifecycle/initial-view';
import { ExecutorUsage } from './persistence/executor-usage';
import { INITIAL_CHAT_DOCUMENTS } from './persistence/documents';
import { observeNavigationVisibility } from './navigation/navigation-visibility';
import { cleanupGroup, type Cleanup } from './lifecycle/cleanup-group';
import { lazyResource } from './lifecycle/lazy-resource';
import { installStartPage, START_PAGE_ID, START_PAGE_SLUG } from './navigation/start-page';
import { workspaceStatus } from './navigation/workspace-status';
import { createSettingsAccess } from './configuration/settings-access';
import { twinSourceMenu } from './digital-twin/source-menu';
import { DEFAULT_HARNESS_TOOL_IDS } from '@itookit/app-contracts';
import { FSError } from '@itookit/vfs-core';
import { createFileChatHandler } from './projects/file-chat';
import { createOcrControls } from './configuration/ocr-controls';
import { ConfigurationDeletionDialog } from './configuration/delete-dialog';
import { createTwinModule } from './digital-twin';
import { createToolboxModule } from './toolbox';
import { TOOLBOX_SCOPE } from './toolbox/ToolboxWorkbench';
import { TOOLBOX_KINDS, legacyToolboxRoute, toolboxSettingsRoute } from './toolbox/routes';
import { createProjectModule } from './projects';
import { SESSION_BROWSER_SCOPE } from './projects/SessionWorkbench';
import { VfsUIPersistence } from './persistence/vfs-ui-state-store';
import { VfsJsonStore } from './persistence/vfs-json-store';
import { TOOLBOX_PREFERENCES_DOC } from './toolbox/ToolboxWorkbench';
import { setupHitlVfsBridge } from './workspaces/hitl-bridge';
import { createWorkspaceModule, restoreWorkspaceResource, type WorkspaceHandle } from './workspaces/module';
import { workspaceRoot, type WorkspaceController, type WorkspaceCreation } from '@itookit/app-contracts';
import { parseWorkspaceHash, resolveLegacyProjectResource } from './navigation/workspace-route';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import type { EditorFileType as FileTypeDefinition } from './browser/types';
import { connectEditorLifecycle } from './browser/editor-connector';
import {NavigationRequest, NAVIGATION_EVENTS, formatDefaultFileTitle, traceBoot} from '@itookit/common';
import { MenuItem } from '@itookit/ui-common';
import { EditorFactory } from '@itookit/ui-common';
import { Workbench } from './core/Workbench';
import { setupMobileWorkspaceView } from './navigation/mobile-workspace-view';
import { installMobileViewport } from './navigation/mobile-viewport';
import { installMobileShellState } from './navigation/mobile-shell-state';

import { AppOptions, AppHandle, WorkspaceConfig } from './types';
import { lazyMdxEditorFactory as defaultEditorFactory } from './browser/lazy-mdx';
import { FILE_REGISTRY, EditorTypeKey } from './config/file-registry';
import { themeService, ThemeMode } from './ThemeService';

export async function initApp(options: AppOptions): Promise<AppHandle> {
    const { defaultSlug, routeAliases = {}, onProgress } = options;
    const t0 = performance.now();
    let t = t0;
    const cleanupFns: Array<() => void | Promise<void>> = [];
    const sourceCleanupFns: Array<() => void | Promise<void>> = [];
    try {
    const logStep = (label: string) => {
        const now = performance.now();
        console.log(`[Boot] ${label}: +${(now - t).toFixed(0)}ms (累计 ${(now - t0).toFixed(0)}ms)`);
        t = now;
        onProgress?.(label);
    };

    // Mutable workspaces list — addWorkspace() appends here at services
    const workspaces: WorkspaceConfig[] = [...options.workspaces];

    const mentionableModules = (): string[] =>
        workspaces.filter(ws => ws.mentionAble === true).map(ws => ws.workspaceName);

    // ── Build route maps from workspace configs ────────────────────────────────

    // slug → elementId
    const routeMap: Record<string, string> = { ...routeAliases };
    // elementId → canonical slug (first mapping wins)
    const reverseRouteMap: Record<string, string> = {};

    const registerWorkspaceRoute = (ws: WorkspaceConfig) => {
        routeMap[ws.slug] = ws.elementId;
        if (!reverseRouteMap[ws.elementId]) reverseRouteMap[ws.elementId] = ws.slug;
    };

    workspaces.forEach(registerWorkspaceRoute);
    if (options.startPage) { routeMap[START_PAGE_SLUG] = START_PAGE_ID; reverseRouteMap[START_PAGE_ID] = START_PAGE_SLUG; }
    const toolboxId = workspaces.find(ws => ws.type === 'toolbox')?.elementId;
    if (toolboxId) for (const slug of TOOLBOX_KINDS) routeMap[slug] = toolboxId;

    const resolvedDefault = defaultSlug ?? (options.startPage ? START_PAGE_SLUG : workspaces[0]?.slug) ?? '';

    if (!options.services || !options.backend) throw new Error('AppOptions.services and AppOptions.backend are required');
    let services = options.services, backend = options.backend;
    const startupRoute = parseWorkspaceHash(location.hash, resolvedDefault);
    const startupWorkspace = workspaces.find(ws => ws.elementId === routeMap[startupRoute.slug]);
    const initialDocuments = startupWorkspace?.type === 'chat'
        ? INITIAL_CHAT_DOCUMENTS : ['theme'];
    const opened = options.initialView ?? (startupWorkspace?.type === 'chat' && typeof backend.openView === 'function' ? await openInitialView(backend, initialDocuments, startupRoute.resource) : undefined);
    const projection = opened ? new OpenedViewProjection(opened, services, backend) : undefined;
    if (projection) {
        cleanupFns.push(() => projection.dispose());
        await projection.start(); services = projection.services; backend = projection.backend;
    }
    cleanupFns.push(installMobileViewport());
    cleanupFns.push(installMobileShellState());
    const { vfs, llmDriver, sessionRepository, flowEngine, sessionFiles,
        kernel, sessionManager, commandBus } = services;
    const agentService = services.agentService;
    // UI state lives beside the theme in `etc:/ui`, so Web and Tauri share one
    // inspectable store instead of the webview's localStorage.
    const uiDocs = new VfsJsonStore(backend);
    if (opened) uiDocs.seed(opened.documents);
    else if (startupWorkspace?.type === 'chat') uiDocs.prefetch(initialDocuments);
    const executorUsage = new ExecutorUsage(uiDocs);
    cleanupFns.push(() => uiDocs.flush());
    const themeReady = themeService.init(uiDocs);
    cleanupFns.push(async () => { await themeReady.catch(() => {}); themeService.destroy(); });
    const uiState = new VfsUIPersistence(uiDocs);
    cleanupFns.push(() => uiState.flush());
    logStep('初始化界面服务…');
    await themeReady;

    const chatFromFile = createFileChatHandler(backend, request => handleNavigationRequest(request));
    const ocr = createOcrControls(() => backend.ocr(), agentService, request => handleNavigationRequest(request));
    cleanupFns.push(() => ocr.dispose());
    const deletionDialog = new ConfigurationDeletionDialog(services.configuration, undefined, ocr.deletionImpact, services.projects);
    const settings = createSettingsAccess(backend, () => workspaces, {
        agentService, connectionService: llmDriver, llmUiEditors: options.ui.llmUiEditors,
        excludedPages: toolboxId ? ['providers', 'connections', 'mcp-servers', 'system-prompts'] : [],
        connectBrowser: (browser, fs, container, factory) => connectEditorLifecycle(browser, fs, container, factory, { readOnly: true }),
        restoreFlows: options.ui.restoreFlowLibrary ? () => options.ui.restoreFlowLibrary!(commandBus) : undefined,
        requestDelete: targets => deletionDialog.request(targets),
    });
    cleanupFns.push(() => settings.close());
    const createChatFactory = (controls: import('@itookit/app-contracts/services').WorkbenchChatControls): EditorFactory => {
        const factory = options.ui.createChatEditor(agentService, {
            defaultHarnessToolIds: DEFAULT_HARNESS_TOOL_IDS, sessionManager, sessionRepository, ocr, commandBus,
            kernel: kernel.kernel, readTaskAttachment: backend.taskAttachment?.bind(backend), ...controls,
        });
        return async (container, config) => { await executorUsage.load(); return factory(container, {...config, executorUsage}); };
    };
    const agentFactory = options.ui.createAgentEditor(agentService, { defaultToolIds: DEFAULT_HARNESS_TOOL_IDS });

    // The backend owns the skill filesystem and its service subscriptions.
    const skillsFiles = lazyResource(() => backend.skillsFiles(), () => {});
    cleanupFns.push(() => skillsFiles.close());
    const skillsFactory = options.ui.createSkillEditor(agentService);

    // Workflows workspace: standalone design surface over the flows VFS module.
    const flowsFactory = options.ui.createFlowEditor({
        commands: commandBus,
        listConnections: async () => {
            const available = await agentService.getConnections();
            return available.map(connection => ({ id: connection.id, name: connection.name }));
        },
        listAgents: async () => (await agentService.getAgents()).map(agent => ({ id: agent.id, name: agent.name, description: agent.description })),
        listSystemPrompts: async () => (await agentService.listSystemPrompts()).map(prompt => ({ id: prompt.id, name: prompt.name, description: prompt.description })),
        listTools: async () => kernel.toolCatalog.getToolDefinitions().map(definition => {
            const id = definition.function?.name ?? definition.name ?? '';
            const rawDescription = definition.function?.description ?? definition.description;
            const description = typeof rawDescription === 'string' ? rawDescription : undefined;
            return { id, name: id, ...(description ? { description } : {}) };
        }).filter(tool => Boolean(tool.id)),
        listSkills: async () => (await agentService.getSkills()).map(skill => ({ id: skill.id, name: skill.name, description: skill.description })),
    });

    // ── 4. Workspace strategies ────────────────────────────────────────────────

    const factories: Record<string, EditorFactory> = {
        standard: defaultEditorFactory, agent: defaultEditorFactory,
        settings: settings.factory,  skills: skillsFactory, flows: flowsFactory,
    };
    const workspaceFiles = new Map<string, import('@itookit/vfs-core').FileSystemContext>();
    const filesForWorkspace = async (workspace: WorkspaceConfig): Promise<import('@itookit/vfs-core').FileSystemContext> => {
        const cached = workspaceFiles.get(workspace.elementId);
        if (cached) return cached;
        const fs = workspace.files?.fs ?? (workspace.type === 'settings' ? settings.files()
            : workspace.type === 'skills' ? await skillsFiles.get()
            : workspace.type === 'flows' ? flowEngine.engine
            : workspace.type === 'twin' ? await vfs.openFileSystem('/home/admin')
            : workspace.type === 'toolbox' ? await vfs.openFileSystem(workspaceRoot('agents'))
            : await vfs.openFileSystem(workspaceRoot(workspace.workspaceName)));
        const files = workspace.files ?? { fs, cwd: '/' };
        workspaceFiles.set(workspace.elementId, files);
        return files;
    };

    const editorFactoryMap: Record<EditorTypeKey, EditorFactory | undefined> = {
        standard: defaultEditorFactory,
        agent:    agentFactory as EditorFactory,
        flow:     flowsFactory,
    };

    // ── 5. File type resolver ──────────────────────────────────────────────────

    // contentParser for .agent files — embeds connectionId in searchableText
    // so all agents (even unopened) are searchable by connection/provider ID.
    const agentFileParser = (content: string) => {
        try {
            const def = JSON.parse(content);
            const parts = [def.name, def.description, def.config?.connectionId].filter(Boolean);
            return { summary: '', searchableText: parts.join(' '), headings: [] };
        } catch {
            return { summary: '', searchableText: '', headings: [] };
        }
    };

    // searchFilter for agent workspace — extends default corpus with ai_connectionLabel
    // so searching by human-readable provider/connection name works for opened agents.
    const agentSearchFilter = (item: VFSNodeUI, tokens: string[]) => {
        const connectionLabel = item.metadata.custom.ai_connectionLabel;
        const corpus = [
            item.metadata?.title ?? '',
            item.content?.summary ?? '',
            item.content?.searchableText ?? '',
            typeof connectionLabel === 'string' ? connectionLabel : '',
        ].join(' ').toLowerCase();
        return tokens.every(t => corpus.includes(t));
    };

    const fileRegistry = { ...FILE_REGISTRY, ...Object.fromEntries((options.fileTypes ?? []).map(type => [type.id, type])) };
    const getFileTypeDef = (typeId: string): FileTypeDefinition | null => {
        const def = fileRegistry[typeId];
        if (!def) { console.warn(`[app-shell] Unknown file type: ${typeId}`); return null; }
        const factory = def.editorType !== 'standard' ? editorFactoryMap[def.editorType] : undefined;
        const parser  = def.id === 'agent' ? agentFileParser
                      : undefined;
        return {
            extensions:           [def.extension.toLowerCase()],
            contentFormat:        def.contentFormat,
            icon:                 def.icon,
            editorFactory:        factory,
            contentParser:        parser,
            duplicateTransformer: def.duplicateTransformer,
        };
    };

    // ── 6. Manager cache + workspace loader ────────────────────────────────────

    const managerCache = new Map<string, WorkspaceHandle>();
    const navigationObservers = new Map<WorkspaceController, () => void>();
    let visibleWorkspaceId: string | undefined;
    let navigationRevision = 0, closed = false;
    // Deduplicate concurrent loads: if the same workspace is loading, reuse the promise.
    const pendingLoads = new Map<string, Promise<WorkspaceController | undefined>>();

    const doLoadWorkspace = async (
        wsConfig: WorkspaceConfig,
        own: (cleanup: Cleanup) => void,
        initialResource?: string,
    ): Promise<WorkspaceController | undefined> => {
        const { elementId } = wsConfig;

        const container = document.getElementById(elementId);
        if (!container) {
            console.warn(`[Shell] doLoadWorkspace: container #${elementId} not found in DOM`);
            return undefined;
        }

        container.querySelectorAll(':scope > :not(.workspace-status)').forEach(node => node.remove());

        // Create layout DOM (previously in memory-manager's Layout.ts).
        // Workbench no longer owns DOM — consumers create their own containers.
        const layoutEl = document.createElement('div');
        layoutEl.className = 'mm-layout';
        if (initialResource) layoutEl.dataset.workspaceOpening = 'true';

        const sidebarEl = document.createElement('div');
        sidebarEl.className = 'mm-sidebar';

        const editorEl = document.createElement('div');
        editorEl.className = 'mm-editor-area';

        layoutEl.appendChild(sidebarEl);
        layoutEl.appendChild(editorEl);
        container.appendChild(layoutEl);
        if (visibleWorkspaceId === elementId) options.onWorkspaceMounted?.({ editor: editorEl });
        own(setupMobileWorkspaceView(layoutEl, sidebarEl, editorEl, !!initialResource));

        const strategyType = wsConfig.type ?? 'standard';
        const factory = factories[strategyType] ?? defaultEditorFactory;

        if (strategyType === 'twin') {
            if (!services.digitalTwin) throw new Error('Digital twin is unavailable in this services');
            const module = createTwinModule({ service: services.digitalTwin, sidebar: sidebarEl, editor: editorEl,
                connections: async () => (await agentService.getConnections()).filter(connection => connection.enabled)
                    .map(connection => ({ id: connection.id, name: connection.name })),
                selected: path => selectionHistory(elementId, path, 'replace') });
            own(module.dispose); await module.workbench.start(); managerCache.set(elementId, module.workbench);
            if (visibleWorkspaceId !== elementId) await module.workbench.setVisible?.(false);
            else options.onWorkspaceReady?.({ editor: editorEl });
            return module.workbench;
        }

        if (strategyType === 'toolbox') {
            await executorUsage.load();
            const [storedPreferences, uiPersistence] = await Promise.all([
                uiDocs.read(TOOLBOX_PREFERENCES_DOC), uiState.port(TOOLBOX_SCOPE),
            ]);
            const module = await createToolboxModule({ services, backend, ocr, ui: options.ui, sidebar: sidebarEl, editor: editorEl,
                factories: { agents: agentFactory, skills: skillsFactory, flows: flowsFactory },
                uiPersistence, executorUsage,
                uiPreferences: { load: () => storedPreferences, save: value => uiDocs.write(TOOLBOX_PREFERENCES_DOC, value) },
                navigate: handleNavigationRequest, selected: path => selectionHistory(elementId, path, 'replace') });
            const toolbox = module.workbench;
            own(module.dispose); await toolbox.start(); managerCache.set(elementId, toolbox);
            // The toolbox renders inside the editor area, so both stages are already painted.
            if (visibleWorkspaceId !== elementId) await toolbox.setVisible?.(false);
            else options.onWorkspaceReady?.({ editor: editorEl });
            return toolbox;
        }

        if (strategyType === 'chat') {
            let sidebarReady = false;
            const revealSidebar = () => {
                if (sidebarReady || (visibleWorkspaceId && visibleWorkspaceId !== elementId)) return false;
                sidebarReady = true;
                requestAnimationFrame(() => { if (!closed) services.startBackground?.(); });
                options.onWorkspaceReady?.({ editor: editorEl });
                return true;
            };
            const [uiPersistence, workbenchState] = await traceBoot('workspace.chatState (parallel)', () => Promise.all([
                uiState.port(SESSION_BROWSER_SCOPE), uiState.workbenchPort(SESSION_BROWSER_SCOPE),
            ]));
            const module = createProjectModule({ services, backend, createFactory: createChatFactory, initialResource, deferNavigation: !!initialResource, projectSyncSetup: options.projectSyncSetup, projectSyncDirectory: options.projectSyncDirectory, sidebar: sidebarEl, container: editorEl,
                fileFactory: defaultEditorFactory, createFlowContextMenu: options.ui.createFlowContextMenu,
                onSidebarReady: revealSidebar,
                uiPersistence, workbenchState,
                onBeforeNavigate: () => {if (visibleWorkspaceId === elementId) rememberCurrentPage();},
                onSelect: (id, mode = 'push') => selectionHistory(elementId, id, mode),
                hostContext: { chatFromFile, toggleSidebar: collapsed => sidebarEl.classList.toggle('is-collapsed', collapsed ?? !sidebarEl.classList.contains('is-collapsed')), navigate: handleNavigationRequest } });
            own(module.dispose);
            await module.workbench.start(); managerCache.set(elementId, module.workbench);
            if (visibleWorkspaceId && visibleWorkspaceId !== elementId) {
                await module.workbench.setVisible?.(false); return module.workbench;
            }
            // Sidebar is populated from the catalog snapshot now; the editor area mounts later.
            revealSidebar();
            options.onSidebarInteractive?.();
            return module.workbench;
        }

        const { workspaceName: _workspaceName, plugins, mentionScope, aiEnabled, supportedFileTypes, showFileExtensions, ...uiPassThrough } = wsConfig;

        const fileTypes: FileTypeDefinition[] = (supportedFileTypes ?? [])
            .map(id => getFileTypeDef(id))
            .filter((x): x is FileTypeDefinition => !!x);

        const primaryType = supportedFileTypes?.[0];
        const primaryDef = primaryType ? fileRegistry[primaryType] : undefined;

        const flowContextMenu = options.ui.createFlowContextMenu<VFSNodeUI>({
            commands: commandBus,
            navigate: sessionId => handleNavigationRequest({ target: 'chat', resourceId: sessionId }),
        });
        const twinMenuLifetime = new AbortController(); own(() => twinMenuLifetime.abort());
        const uiOptions = {
            ...uiPassThrough,
            defaultExtension: primaryDef?.extension,
            fileCreation: {
                ...uiPassThrough.fileCreation,
                label:           uiPassThrough.fileCreation?.label           ?? primaryDef?.label           ?? 'File',
                title:           uiPassThrough.fileCreation?.title           ?? formatDefaultFileTitle(),
                content:         uiPassThrough.fileCreation?.content ?? (primaryType ? options.fileTemplates?.[primaryType] : undefined) ?? primaryDef?.defaultContent,
            },
            contextMenu: {
                items: (_item: VFSNodeUI, defaults: MenuItem<VFSNodeUI>[]) => {
                    if (uiPassThrough.readOnly) return [];
                    if (strategyType === 'flows') return flowContextMenu.items?.(_item, defaults) ?? defaults;
                    if (services.digitalTwin && ['emails', 'minds', 'home', 'projects'].includes(wsConfig.workspaceName)) return [...defaults,
                        ...twinSourceMenu(services.digitalTwin, async () => ({ kind: 'file', target: workspaceRoot(wsConfig.workspaceName) + '/' + _item.id.replace(/^\//, ''),
                            directory: _item.type === 'directory', label: _item.metadata.title || _item.id }),
                            async () => { await handleNavigationRequest({ target: 'twin', resourceId: '/sources' }); }, twinMenuLifetime.signal)];
                    return defaults;
                },
            },
            // Skills workspace: summary=skill ID, tags="disabled" pill, dot=enabled.
            ...(strategyType === 'skills' && {
                defaultUiSettings: { showSummary: true, showTags: true, showBadges: false },
            }),
            // Agent workspace: include ai_connectionLabel in search corpus.
            ...(strategyType === 'agent' && {
                searchFilter: agentSearchFilter,
            }),
        };

        const navigation = !initialResource && !wsConfig.files && ['standard', 'agent'].includes(strategyType)
            ? await backend.navigationView({root: workspaceRoot(wsConfig.workspaceName), scope: elementId}) : undefined;
        if (navigation) uiDocs.seed(navigation.documents);
        const [files, uiPersistence, workbenchState] = await Promise.all([
            navigation ? {...navigation.files, fs: withInitialDirectory(navigation.files.fs, navigation.directory)} : filesForWorkspace(wsConfig),
            uiState.port(elementId), uiState.workbenchPort(elementId),
        ]);
        const manager = new Workbench({
            sidebarContainer: sidebarEl,
            editorContainer: editorEl,
            files,
            editorFactory: factory,
            scopeId:       elementId, deferNavigation: !!initialResource,
            uiPersistence, workbenchState,
            fileTypes,
            uiOptions,
            showFileExtensions,
            editorConfig: {
                plugins:      plugins ?? [],
                readOnly:     false,
                mentionScope: mentionScope?.[0] === '*' ? mentionableModules() : mentionScope,
            },
            chatFromFile,
            aiConfig: { enabled: aiEnabled ?? true },
            onNavigate:      async (req: NavigationRequest) => handleNavigationRequest(req),
            onBeforeNavigate: () => {if (visibleWorkspaceId === elementId) rememberCurrentPage();},
            onSessionChange: (sessionId) => selectionHistory(elementId, sessionId, 'push'),
            onSidebarToggle: (collapsed) => {
                if (collapsed) {
                    sidebarEl.classList.add('is-collapsed');
                } else {
                    sidebarEl.classList.remove('is-collapsed');
                }
                setTimeout(() => window.dispatchEvent(new Event('resize')), 310);
            },
        });

        const controller: WorkspaceController & WorkspaceCreation = {
            start: () => manager.start(), destroy: () => manager.destroy(),
            setVisible: visible => manager.setVisible?.(visible),
            ...(manager.setNavigationVisible ? {setNavigationVisible: (visible: boolean) => manager.setNavigationVisible(visible)} : {}),
            openResource: id => manager.openFile(id), createResource: options => manager.createAndOpenFile(options),
            getActiveResourceId: () => manager.getActiveFilePath(),
        };
        // Start without resourceId to avoid double sessionSelected race with LLMFactory.
        let releaseHitl: (() => void) | undefined;
        const module = createWorkspaceModule(controller, async () => { releaseHitl?.(); await manager.destroy(); });
        own(module.dispose);
        await module.workbench.start();
        managerCache.set(elementId, module.workbench);
        if (visibleWorkspaceId && visibleWorkspaceId !== elementId) {
            await module.workbench.setVisible?.(false); return module.workbench;
        }

        // Bridge: session HITL status → vfs-ui session list highlight.
        // Calls manager.setWaitingInput() which delegates to VFSUIShell internally,
        // keeping bootstrap decoupled from the concrete VFSUIShell type.
        releaseHitl = setupHitlVfsBridge(sessionManager, (id, waiting) => manager.setNodeWaitingInput(id, waiting));

        // Sidebar is rendered; the editor mounts only if a resource is opened below.
        options.onWorkspaceReady?.({ editor: editorEl });
        return module.workbench;
    };

    /** Keep workspace creation independent of resource navigation; only the latest route may open content. */
    const loadWorkspace = (wsConfig: WorkspaceConfig, initialResource?: string): Promise<WorkspaceController | undefined> => {
        const { elementId } = wsConfig;
        if (pendingLoads.has(elementId)) return pendingLoads.get(elementId)!;
        if (managerCache.has(elementId)) return Promise.resolve(managerCache.get(elementId));
        const owned = cleanupGroup();
        const loading = doLoadWorkspace(wsConfig, owned.own, initialResource).then(manager => {
            cleanupFns.push(owned.close); return manager;
        }).catch(async error => {
            managerCache.delete(elementId); await owned.close(); throw error;
        }).finally(() => pendingLoads.delete(elementId));
        pendingLoads.set(elementId, loading);
        return loading;
    };

    // ── 7. Routing helpers ─────────────────────────────────────────────────────

    const resolveTarget = (target: string, resource?: string): string => {
        if (toolboxId && (target === 'settings' || target === routeMap.settings) && toolboxSettingsRoute(resource)) return toolboxId;
        if (toolboxId && legacyToolboxRoute(target)) return toolboxId;
        if (routeMap[target]) return routeMap[target];
        if (document.getElementById(target)) return target;
        const ws = workspaces.find(w => w.workspaceName === target);
        if (ws) return ws.elementId;
        return routeMap[resolvedDefault] ?? workspaces[0]?.elementId ?? '';
    };

    const updateHistory = (wsId: string, resourceId: string | null, mode: 'push' | 'replace'): void => {
        if (closed) return;
        const slug = reverseRouteMap[wsId] ?? wsId;
        const hash = resourceId ? `#/${slug}/${encodeURIComponent(resourceId)}` : `#/${slug}`;
        const view = mode === 'replace' && visibleWorkspaceId === wsId
            ? document.getElementById(wsId)?.querySelector<HTMLElement>('.mm-layout')?.dataset.mobileView : resourceId ? 'detail' : 'list';
        writePageHistory(wsId, resourceId, hash, mode, view);
    };

    let replayingHistory: symbol | undefined;
    const rememberCurrentPage = (): void => {
        if (closed || replayingHistory || !visibleWorkspaceId) return;
        const layout = document.getElementById(visibleWorkspaceId)?.querySelector<HTMLElement>('.mm-layout');
        rememberPagePresentation({mobileView: layout?.dataset.mobileView,
            navigationScope: managerCache.get(visibleWorkspaceId)?.getNavigationScope?.()});
    };
    const selectionHistory = (id: string, resource: string | null, mode: 'push' | 'replace'): void => {
        if (!closed && visibleWorkspaceId === id) updateHistory(id, resource, replayingHistory ? 'replace' : mode);
    };

    const performNavigation = async (workspaceId: string, resourceId?: string, sourceSlug?: string): Promise<void> => {
        const revision = ++navigationRevision;
        if (closed) return;
        let projectRouteError: FSError | undefined;
        const movedSettings = toolboxId && (sourceSlug === 'settings' || workspaceId === routeMap.settings) ? toolboxSettingsRoute(resourceId) : undefined;
        if (movedSettings) { workspaceId = toolboxId!; resourceId = movedSettings; }
        const legacyToolbox = toolboxId ? legacyToolboxRoute(sourceSlug ?? workspaceId, resourceId) : undefined;
        if (legacyToolbox) { workspaceId = toolboxId!; resourceId = legacyToolbox.path ?? '/' + legacyToolbox.kind; }
        if (closed || revision !== navigationRevision) return;
        visibleWorkspaceId = workspaceId;
        for (const [id, workbench] of managerCache) {
            void Promise.resolve(workbench.setVisible?.(id === workspaceId)).catch(error => console.error('[Shell] Workspace save failed', error));
        }
        console.log(`[Shell] performNavigation: ${workspaceId} resourceId=${resourceId ?? '—'} cached=${managerCache.has(workspaceId)}`);
        document.querySelectorAll('.workspace-view').forEach(ws => {
            ws.classList.toggle('active', ws.id === workspaceId);
        });
        document.querySelectorAll('.app-nav-btn').forEach(btn => {
            btn.classList.toggle('active', (btn as HTMLElement).dataset.target === workspaceId);
        });

        const container = document.getElementById(workspaceId);
        const targetLayout = container?.querySelector<HTMLElement>('.mm-layout');
        if (targetLayout) {
            if (resourceId) { targetLayout.dataset.workspaceOpening = 'true'; targetLayout.dataset.mobileView = 'detail'; }
            else delete targetLayout.dataset.workspaceOpening;
        }
        const dismissLoading = workspaceId !== START_PAGE_ID ? workspaceStatus(container) : () => {};
        try {
            if (sourceSlug === 'projects' && resourceId && workspaces.some(ws => ws.elementId === workspaceId && ws.type === 'chat')) {
                try { resourceId = await resolveLegacyProjectResource(resourceId, services.projects); }
                catch (error) {
                    if (!(error instanceof FSError) || !('reason' in error) || error.reason !== 'PROJECT_ROOT_OVERLAP') throw error;
                    projectRouteError = error; resourceId = undefined;
                    console.warn('[Project route]', { stage: 'legacy-root-overlap', error });
                }
            }
            if (closed || revision !== navigationRevision) return;
            const wsConfig = workspaces.find(w => w.elementId === workspaceId);
            const mgr = wsConfig ? await loadWorkspace(wsConfig, resourceId) : undefined;
            if (closed || revision !== navigationRevision) return;
            if (mgr && resourceId) {
                const wasAlreadyOpen = mgr.getActiveResourceId() === resourceId;
                await restoreWorkspaceResource(mgr, resourceId);
                if (closed || revision !== navigationRevision) return;
                // A retained editor needs the anchor forwarded explicitly.
                if (wasAlreadyOpen) {
                    const raw = sessionStorage.getItem('settings_anchor');
                    if (raw) {
                        try {
                            const { anchor } = JSON.parse(raw) as { anchor: string };
                            sessionStorage.removeItem('settings_anchor');
                            document.getElementById(workspaceId)?.dispatchEvent(
                                new CustomEvent('consume-anchor', { detail: { anchor } }),
                            );
                        } catch {
                            sessionStorage.removeItem('settings_anchor');
                        }
                    }
                }
            }
            options.onEditorReady?.();
        } catch (error) {
            if (!closed && revision === navigationRevision) {
                console.error('[Shell] Workspace navigation failed', error);
                workspaceStatus(container, error, () => { void performNavigation(workspaceId, resourceId, sourceSlug); });
            }
        } finally {
            dismissLoading();
            const manager = managerCache.get(workspaceId), layout = container?.querySelector<HTMLElement>('.mm-layout');
            if (!closed && revision === navigationRevision) {
                if (layout) delete layout.dataset.workspaceOpening;
                delete document.body.dataset.appStarting;
            }
            const sidebar = layout?.querySelector<HTMLElement>('.mm-sidebar');
            if (manager?.setNavigationVisible && layout && sidebar && !navigationObservers.has(manager)) {
                const stop = observeNavigationVisibility(layout, sidebar, visible => {
                    void Promise.resolve().then(() => manager.setNavigationVisible!(visible)).catch(error => {
                        console.error('[Navigation]', error);
                        workspaceStatus(sidebar, error, () => { void Promise.resolve().then(() => manager.setNavigationVisible!(true)).catch(console.error); });
                    });
                });
                navigationObservers.set(manager, stop);
                cleanupFns.push(() => {stop(); navigationObservers.delete(manager);});
            }
        }
        if (closed || revision !== navigationRevision) return;
        requestAnimationFrame(() => { if (!closed) services.startBackground?.(); });
        if (movedSettings || legacyToolbox) updateHistory(workspaceId, resourceId ?? null, 'replace');
        if (projectRouteError) {
            const workspace = document.getElementById(workspaceId);
            workspace?.querySelector('[data-project-route-error]')?.remove();
            const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.dataset.projectRouteError = '';
            notice.textContent = projectRouteError.message;
            (workspace?.querySelector('.workbench-tabs__panel:not([hidden])') ?? workspace)?.append(notice);
        }
    };

    const isProjectWorkspace = (id: string) => workspaces.some(ws => ws.elementId === id && ws.type === 'chat');
    const handleNavigationRequest = async (req: NavigationRequest): Promise<void> => {
        rememberCurrentPage();
        const moved = toolboxId && req.target === 'settings' ? toolboxSettingsRoute(req.resourceId, req.state?.anchor) : undefined;
        if (moved) req = { ...req, target: 'toolbox', resourceId: moved, state: undefined };
        const targetWsId = resolveTarget(req.target, req.resourceId);
        const action = req.action ?? 'open';
        console.log(`[Shell] handleNavigationRequest: action=${action} target=${req.target} → wsId=${targetWsId}`);

        switch (action) {
            case 'create': {
                updateHistory(targetWsId, null, 'push');
                await performNavigation(targetWsId, undefined, req.target);
                const mgr = managerCache.get(targetWsId);
                console.log(`[Shell] create: mgr found=${!!mgr} wsId=${targetWsId}`);
                if (mgr?.createResource) {
                    try {
                        const newId = await mgr.createResource({
                            title:    req.create?.title,
                            content:  req.create?.content,
                            parentPath: req.create?.parentPath,
                            initialInputState: req.state ? { agentId: req.state.agentId, text: req.state.inputText } : undefined,
                        });
                        console.log(`[Shell] createAndOpenFile ok: newId=${newId}`);
                        selectionHistory(targetWsId, newId, 'replace');
                    } catch (err) {
                        console.error('[Shell] createAndOpenFile failed:', err);
                    }
                } else {
                    console.warn(`[Shell] create skipped: no manager for wsId=${targetWsId}`);
                }
                break;
            }
            case 'reveal':
                updateHistory(targetWsId, req.resourceId ?? null, 'replace');
                await performNavigation(targetWsId, undefined, req.target);
                break;
            case 'focus':
                updateHistory(targetWsId, null, 'replace');
                await performNavigation(targetWsId, undefined, req.target);
                break;
            default: {
                if (req.state?.anchor) {
                    sessionStorage.setItem('settings_anchor', JSON.stringify({
                        target: req.target,
                        anchor: req.state.anchor,
                        timestamp: Date.now(),
                    }));
                }
                const resourceId = req.resourceId ?? (isProjectWorkspace(targetWsId) ? '/' : undefined);
                updateHistory(targetWsId, resourceId ?? null, 'push');
                await performNavigation(targetWsId, resourceId, req.target);
            }
        }
    };

    // ── 8. Event bindings ──────────────────────────────────────────────────────

    // Navigation listeners are global and outlive workspace managers. Keep them
    // on an AbortController so destroy() and startup failure can unregister them.
    const navigationAbort = new AbortController();
    cleanupFns.push(() => navigationAbort.abort());
    const navigationSignal = navigationAbort.signal;
    const entryResource = (id: string) => isProjectWorkspace(id)
        ? '/' : managerCache.get(id)?.getActiveResourceId() ?? null;

    document.querySelectorAll('.app-nav-btn[data-target]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation(); // prevent bubbling to delegated handler in app-specific main.ts
            const targetId = (e.currentTarget as HTMLElement).dataset.target;
            if (!targetId) return;
            rememberCurrentPage();
            const lastId = entryResource(targetId);
            updateHistory(targetId, lastId, 'push');
            void performNavigation(targetId, lastId ?? undefined);
        }, { signal: navigationSignal });
    });

    document.addEventListener(NAVIGATION_EVENTS.NAVIGATE, (e) => {
        const req = (e as CustomEvent).detail as NavigationRequest;
        if (req?.target) void handleNavigationRequest(req).catch(error => console.error('[Shell] Navigation failed', error));
    }, { signal: navigationSignal });

    window.addEventListener('popstate', (e) => {
        const state = e.state as ({ workspaceId: string; resourceId?: string } & PagePresentation) | null;
        const expectedHash = location.hash;
        const {slug, resource} = parseWorkspaceHash(location.hash, resolvedDefault);
        const replay = Symbol(); replayingHistory = replay;
        void performNavigation(state?.workspaceId ?? resolveTarget(slug, resource), state?.resourceId ?? resource, state ? undefined : slug)
            .then(async () => {
                if (closed || replayingHistory !== replay || location.hash !== expectedHash) return;
                if (state?.mobileView === 'list') await managerCache.get(state.workspaceId)?.restoreNavigationScope?.(state.navigationScope ?? '/');
                const layout = visibleWorkspaceId && document.getElementById(visibleWorkspaceId)?.querySelector<HTMLElement>('.mm-layout');
                if (!closed && replayingHistory === replay && layout && location.hash === expectedHash && ['list', 'detail'].includes(state?.mobileView ?? '')) layout.dataset.mobileView = state!.mobileView;
            }).finally(() => {if (replayingHistory === replay) replayingHistory = undefined;});
    }, { signal: navigationSignal });

    // ── 9. Initial navigation ──────────────────────────────────────────────────

    if (options.startPage) cleanupFns.push(installStartPage(workspaces, navigationSignal, id => {
        rememberCurrentPage();
        const lastId = entryResource(id);
        updateHistory(id, lastId, 'push'); void performNavigation(id, lastId ?? undefined);
    }));
    const initialRoute = parseWorkspaceHash(location.hash, resolvedDefault);
    const initWs = resolveTarget(initialRoute.slug, initialRoute.resource);
    const initialLoad = performNavigation(initWs, initialRoute.resource, initialRoute.slug);
    const initialRevision = navigationRevision;
    options.onShellReady?.();
    await initialLoad;
    if (initialRevision === navigationRevision) {
        const initialResource = managerCache.get(initWs)?.getActiveResourceId() ?? null;
        updateHistory(initWs, initialResource, 'replace');
    }

    // ── AppHandle ──────────────────────────────────────────────────────────────

    projection?.finishHydration();
    return {
        vfs,
        sessionFiles,
        services,

        async navigate(slug: string, resourceId?: string): Promise<void> {
            const wsId = resolveTarget(slug, resourceId);
            resourceId ??= isProjectWorkspace(wsId) ? '/' : undefined;
            updateHistory(wsId, resourceId ?? null, 'push');
            await performNavigation(wsId, resourceId, slug);
        },

        async setTheme(mode: ThemeMode): Promise<void> {
            await themeService.setMode(mode);
        },

        addWorkspace(config: WorkspaceConfig): void {
            if (!config.files) throw new Error('Dynamic workspace requires a file context');
            workspaceFiles.set(config.elementId, config.files);
            workspaces.push(config);
            registerWorkspaceRoute(config);
        },

        async removeWorkspace(elementId: string): Promise<void> {
            const index = workspaces.findIndex(ws => ws.elementId === elementId);
            if (index < 0) return;
            const manager = managerCache.get(elementId);
            await manager?.destroy();
            if (manager) {navigationObservers.get(manager)?.(); navigationObservers.delete(manager);}
            managerCache.delete(elementId); workspaceFiles.delete(elementId);
            workspaces.splice(index, 1);
            for (const [slug, id] of Object.entries(routeMap)) if (id === elementId) delete routeMap[slug];
            delete reverseRouteMap[elementId];
        },
        onDestroy(cleanup: () => void | Promise<void>, phase: 'consumers' | 'sources' = 'consumers'): void {
            (phase === 'sources' ? sourceCleanupFns : cleanupFns).push(cleanup);
        },

        async destroy(): Promise<void> {
            closed = true; ++navigationRevision; navigationAbort.abort();
            await Promise.allSettled(pendingLoads.values());
            for (const fn of [...cleanupFns].reverse().concat([...sourceCleanupFns].reverse())) {
                try { await fn(); } catch (error) { console.error('[App] Cleanup failed', error); }
            }
            cleanupFns.length = 0; sourceCleanupFns.length = 0;
        },
    };
    } catch (error) {
        delete document.body.dataset.appStarting;
        for (const close of [...cleanupFns].reverse().concat([...sourceCleanupFns].reverse())) {
            try { await close(); } catch (cleanupError) { console.error('[App] Startup cleanup failed', cleanupError); }
        }
        throw error;
    }
}
