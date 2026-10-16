import type { EditorFileType as FileTypeDefinition, EditorResolver as CustomEditorResolver } from './browser/types';
import type { NavigationRequest } from '@itookit/common';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { ApplicationServices } from '@itookit/app-contracts/services';
import type { FileCreationConfig, EditorFactory, EditorOptions, ContextMenuConfig } from '@itookit/ui-common';
import type { IFileSystem } from '@itookit/vfs-core';
import type { ThemeMode } from './ThemeService';
import type { VFSUIOptions } from '@itookit/vfs-ui';
import type {
    ISessionRepository,
    IAgentManagementService,
    IAgentConfigService,
    IPrivilegedCommandService,
} from '@itookit/llm-session/contracts';
import type { LLMUIEditors } from '@itookit/app-settings';

export type WorkspaceType = 'standard' | 'settings' | 'agent' | 'chat' | 'skills' | 'flows' | 'toolbox' | 'twin';

export interface WorkspaceConfig {
    /** Explicit application file context. workspaceName selects the default user directory. */
    files?: import('@itookit/vfs-core').FileSystemContext;
    elementId: string;
    workspaceName: string;
    /** URL hash segment, e.g. 'chat', 'files', 'agents' */
    slug: string;
    type?: WorkspaceType;
    title: string;
    supportedFileTypes: string[];
    syncEnabled: boolean;
    isProtected?: boolean;
    isSystem?: boolean;
    plugins?: string[];
    mentionScope?: string[];
    mentionAble?: boolean;
    aiEnabled?: boolean;
    readOnly?: boolean;
    initialSidebarCollapsed?: boolean;
    searchPlaceholder?: string;
    /**
     * 在文件树中显示文件扩展名（如 .md / .ts / .pdf）。
     * 外部文件系统挂载（home、mount）设为 true；内部模块保持 false（默认）。
     */
    showFileExtensions?: boolean;
    /** Instant file creation config — passed through to VFSUIShell */
    fileCreation?: FileCreationConfig;
}

// ── UI 装配契约 ──────────────────────────────────────────────────────────
//
// app-shell 不直接依赖 @itookit/llm-ui：编辑器工厂 / AI 右键菜单 / LLM 设置
// 编辑器均通过 AppOptions.ui 由 apps 入口注入。契约类型定义在 app-shell
// （装配层，已依赖全部所需类型），llm-ui 的实现靠结构类型在入口处兼容。

export interface ChatEditorDeps {
    defaultHarnessToolIds?: readonly string[];
    sessionManager: import('@itookit/llm-session/contracts').SessionViewPort;
    sessionRepository: ISessionRepository;
    ocr?: import('@itookit/ui-common').OcrControls;
    commandBus?: ICommandBus;
    kernel?: import('@itookit/durable-kernel/contracts').EditorTaskControlPlane;
    privilegedCommands?: IPrivilegedCommandService;
    sessionSkills?: import('@itookit/tools/contracts').SessionSkillControls;
}

export interface FlowEditorDeps {
    commands: ICommandBus;
    /** Optional override for the run action (defaults to create-session + navigate). */
    onRunFlow?: (flowId: string, revision: number) => void;
    /** Global LLM connections available to bind flow-level connection slots to. */
    listConnections?: () => Promise<Array<{ id: string; name: string }>>;
    listAgents?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listSystemPrompts?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listTools?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
    listSkills?: () => Promise<Array<{ id: string; name: string; description?: string }>>;
}

export interface AIContextMenuDeps {
    agentService: IAgentConfigService;
    engine: IFileSystem;
    filesOnly?: boolean;
}

/** Structural subset of a VFS node the AI context menu needs (mirrors llm-ui's NodeItem). */
export interface AIContextMenuNode {
    id: string;
    type: 'file' | 'directory';
    metadata: { title: string; custom: Record<string, unknown> };
}

export interface AppUI {
    restoreFlowLibrary?(commands: ICommandBus): Promise<number>;
    createFlowContextMenu<TNode extends { id: string; type: 'file' | 'directory' }>(deps: {
        commands: ICommandBus;
        navigate(sessionId: string): void | Promise<void>;
    }): ContextMenuConfig<TNode>;
    createChatEditor(agentService: IAgentConfigService, deps: ChatEditorDeps): EditorFactory;
    createAgentEditor(agentService: IAgentManagementService, options?: { defaultToolIds?: readonly string[] }): EditorFactory;
    createFlowEditor(deps: FlowEditorDeps): EditorFactory;
    createSkillEditor(agentService: IAgentManagementService): EditorFactory;
    createAIContextMenu<TNode extends AIContextMenuNode>(deps: AIContextMenuDeps): ContextMenuConfig<TNode>;
    llmUiEditors: LLMUIEditors;
}

/** Containers a staged boot overlay can target once the workspace shell exists. */
export interface BootWorkspaceParts {
    /** Editor area that grows from empty to the mounted editor. */
    editor: HTMLElement;
}

export interface AppOptions {
    fileTypes?: import('./config/file-registry').AppFileTypeConfig[];
    /** Host UI for selecting a server/project and persisting a fresh binding. */
    projectSyncSetup?(projectId: string, signal: AbortSignal): Promise<void>;
    projectSyncDirectory?(projectId: string, signal: AbortSignal): Promise<void>;
    /** Application capabilities. The UI never creates an execution runtime. */
    services: ApplicationServices;
    /** Host-bound application queries and commands; no construction dependencies. */
    backend: import('@itookit/app-contracts/services').ApplicationBackend;
    workspaces: WorkspaceConfig[];
    /** Product templates are provided by the host, never loaded from an execution adapter. */
    fileTemplates?: Readonly<Record<string, string>>;
    /** Startup slug; defaults to start when enabled, otherwise the first workspace. */
    defaultSlug?: string;
    /** Provide the lightweight #/start route without loading a workspace. */
    startPage?: boolean;
    /** Extra slug → elementId aliases, e.g. { home: 'home-workspace' } */
    routeAliases?: Record<string, string>;
    /** Called during boot steps; use this to drive a loading overlay. */
    onProgress?: (msg: string) => void;
    /** Navigation handlers are installed; global startup UI can be dismissed. */
    onShellReady?: () => void;
    /** The workspace columns exist; reveal the empty sidebar while its data is loading. */
    onWorkspaceMounted?: (parts: BootWorkspaceParts) => void;
    /** The workspace layout and sidebar data are ready; resource content may still be loading. */
    onWorkspaceReady?: (parts: BootWorkspaceParts) => void;
    /** The Session sidebar has finished initializing and can accept navigation. */
    onSidebarInteractive?: () => void;
    /** The active workspace's initial resource operation completed (or none was requested). */
    onEditorReady?: () => void;
    /** UI implementations (editor factories, AI menu, LLM settings editors) injected by the entry app. */
    ui: AppUI;
}

export interface AppHandle {
    navigate(slug: string, resourceId?: string): Promise<void>;
    /** Set the global UI theme and persist to etc:/ui/theme.json */
    setTheme(mode: ThemeMode): Promise<void>;
    /** Register a dynamically created workspace (e.g. a local mount tab). */
    addWorkspace(config: WorkspaceConfig): void;
    removeWorkspace(elementId: string): Promise<void>;
    /** Unsubscribe all global event listeners and release resources. */
    destroy(): Promise<void>;
    /** Host-owned resources close with the application, in reverse registration order. */
    onDestroy(cleanup: () => void | Promise<void>, phase?: 'consumers' | 'sources'): void;
    vfs: ApplicationServices['vfs'];
    sessionFiles: import('@itookit/app-contracts/services').SessionFilesPort;
    services: ApplicationServices;
}

// ── Workbench config ────────────────────────────────────────────────────

export interface WorkbenchConfig {
    chatFromFile?: import('@itookit/ui-common').EditorHostContext['chatFromFile'];
    /** Preferred input: an already authorized file context. The host owns its lifetime. */
    files: import('@itookit/vfs-core').FileSystemContext;
    /** VFS 侧边栏挂载容器（消费方负责创建 DOM） */
    sidebarContainer: HTMLElement;
    /** 编辑器挂载容器（消费方负责创建 DOM） */
    editorContainer: HTMLElement;
    /** Scope ID 用于多实例隔离 (localStorage key, modal ID 等) */
    scopeId?: string;
    editorFactory?: EditorFactory;
    editorConfig?: Partial<EditorOptions> & {
        refreshFileMetadata?: boolean;
        canCreateEntries?: boolean;
        mentionScope?: string[];
    };
    onNavigate?: (request: NavigationRequest) => Promise<void>;
    onSessionChange?: (sessionId: string | null) => void;
    onSidebarToggle?: (collapsed: boolean) => void;
    workbenchState?: import('./workbench/state').WorkbenchStatePort;
    uiOptions?: Partial<Omit<VFSUIOptions, 'defaultEditorFactory'>>;
    /** Host-owned sidebar snapshot storage; omitted means the workspace restores nothing. */
    uiPersistence?: import('@itookit/vfs-ui').UIPersistencePort;
    fileTypes?: FileTypeDefinition[];
    customEditorResolver?: CustomEditorResolver;
    showFileExtensions?: boolean;
    defaultContentConfig?: { fileName: string; content: string };
    createConfig?: { initialInputState?: { text?: string; agentId?: string } };
    aiConfig?: { enabled: boolean; activeRules?: string[] };
}
