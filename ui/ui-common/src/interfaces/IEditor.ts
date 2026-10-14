/**
 * @file ui-common/interfaces/IEditor.ts
 * @description Defines the interface that any editor component must implement to be compatible with MDxWorkspace.
 * @interface
 */

import type { NavigationRequest, Heading } from '@itookit/common';
import type { FileSystemContext } from '@itookit/vfs-core';

export type EditorTarget =
    | { kind: 'file'; path: string; namespaceId?: string; sessionId?: string }
    | { kind: 'session'; sessionId: string; branch?: string }
    | { kind: 'entity'; entityType: 'agent' | 'skill' | 'flow' | 'mcp' | 'tool' | 'provider' | 'connection' | 'system-prompt'; id: string };

/** Validate an explicitly supplied target against its granted file context. */
export function normalizeEditorOptions<TSubmission>(options: EditorOptions<TSubmission>): EditorOptions<TSubmission> {
    const fs = options.files?.fs;
    if (options.target?.kind === 'file' && options.target.namespaceId && fs && options.target.namespaceId !== fs.viewId) throw new Error('Editor namespace does not match its file context');
    if (options.target && 'sessionId' in options.target && options.target.sessionId && options.files?.sessionId && options.target.sessionId !== options.files.sessionId) throw new Error('Editor Session does not match its file context');
    return options;
}
export function editorFilePath(options: EditorOptions): string | undefined {
    return options.target?.kind === 'file' ? options.target.path : undefined;
}
export function editorResourceId(options: EditorOptions): string | undefined {
    const target = options.target;
    return target?.kind === 'file' ? target.path : target?.kind === 'session' ? target.sessionId : target?.id;
}

export type { Heading } from '@itookit/common';

export type SearchResultSource = 'editor' | 'renderer';

interface SearchResultBase {
    text: string;
    context: string;
}

export type UnifiedSearchResult =
    | (SearchResultBase & {
        source: 'editor';
        details: { from: number; to: number };
    })
    | (SearchResultBase & {
        source: 'renderer';
        details: { element: HTMLElement };
    });

/**
 * 导航选项
 */
export interface NavigateToOptions {
    /** 是否使用平滑滚动动画 */
    smooth?: boolean;
    /** 是否高亮目标元素 */
    highlight?: boolean;
    /** 高亮持续时间（毫秒） */
    highlightDuration?: number;
}

export interface EditorFileReference {
    path: string;
    content: string;
    selection: boolean;
}

/**
 * 定义编辑器宿主环境提供的标准能力
 * 任何接管编辑器的容器（如 MemoryManager）都应提供这些能力
 */
export interface EditorHostContext {
    /** Open a resolved path in the editor's file namespace, optionally at a document anchor. */
    openFile?: (path: string, anchor?: string) => Promise<void>;
    /** Prepare a new chat draft; association is supplied by the file host, never inferred by MDX. */
    chatFromFile?: (reference: EditorFileReference, association?: {
        projectFolder?: string;
        sessionId?: string;
    }) => Promise<void>;
    /** Ask the host to confirm and execute resource deletion. */
    requestDelete?: (targets: readonly EditorTarget[]) => Promise<void>;
    /** 切换侧边栏 (无参则 toggle，有参则强制设为该状态) */
    toggleSidebar: (collapsed?: boolean) => void;

    /** 手动触发保存 (用于编辑器内部的 Save 按钮) */
    saveContent?: (nodeId: string, content: string) => Promise<void>;

    /** 
     * [通用] 请求导航到系统内的任意资源
     */
    navigate: (request: NavigationRequest) => Promise<void>;
    /** Explicit human commands; never exposed as model-callable tools. */
    directoryCommands?: {
        /** The host owns the workspace location; additional mounts remain editable. */
        workspaceReadOnly?: boolean;
        addDirectory(directory?: string, access?: 'ro' | 'rw'): Promise<string>;
        setHome(directory?: string): Promise<string>;
        configureWorkspace?(mode: 'workspace' | 'mount'): Promise<void>;
    };
}

// ✨ [重构] 提升 fs 和 nodeId 为核心配置
export interface ConfigurationFormControls<T, TDiscovery> {
    render(container: HTMLElement, record: T): void;
    read(record: T): T;
    tested?(record: T, discovery: TDiscovery): Promise<T>;
    committed?(): void;
    failed?(): void;
    dispose?(): void;
}

export interface EditorOptions<TSubmission = unknown> {
    onConversationSession?(sessionId: string): void;
    conversation?: import('./ConversationControls').ConversationControls;
    remoteAgents?: import('./ConversationControls').RemoteAgentControls;
    /** Explicit initial input for conversation editors. */
    initialInputState?: { text?: string; agentId?: string };
    /** A project draft is separate from Session history until first submission. */
    sessionDraft?: import('./SessionDraftControls').SessionDraftControls<TSubmission>;
    /** Resolve optional host correlation for a user-initiated submission. */
    resolveSubmission?(): Promise<TSubmission | undefined>;

    /** Cancels view construction and preview work, never persistence. */
    signal?: AbortSignal;
    target?: EditorTarget;
    files?: FileSystemContext;
    /** Explicit attachment directory; independent of a document owner. */
    assets?: import('@itookit/vfs-core').IFileSystem;
    /** 初始 Markdown 内容 */
    initialContent?: string;

    /** 初始模式 */
    initialMode?: 'edit' | 'render';
    /** Source text never enters Markdown parsing or preview. */
    contentFormat?: 'markdown' | 'text';

    /** 标题（可选） */
    title?: string;

    /** 编辑器界面语言 */
    language?: string;


    /** 是否只读 */
    readOnly?: boolean;

    /** 
     * [标准注入] 宿主上下文
     * 编辑器通过它控制外部 UI（如侧边栏、全局提示）
     */
    hostContext?: EditorHostContext;

    /** 插件列表 */
    plugins?: unknown[];

    /** 插件配置 */
    defaultPluginOptions?: Record<string, unknown>;
}

export interface EditorEventMap {
    change: undefined;
    interactiveChange: undefined;
    ready: undefined;
    modeChanged: { mode: 'edit' | 'render' };
    blur: undefined;
    focus: undefined;
    optimisticUpdate: undefined;
    saved: undefined;
    saveError: unknown;
    contentLoaded: undefined;
    error: unknown;
    blocksCollapsed: CollapseExpandResult;
    blocksExpanded: CollapseExpandResult;
}

export type EditorEvent = keyof EditorEventMap;
export type EditorEventCallback<E extends EditorEvent = EditorEvent> = (
    payload: EditorEventMap[E],
) => void;

/**
 * ✨ [新增] 折叠/展开操作的结果
 */
export interface CollapseExpandResult {
    /** 受影响的代码块数量 */
    affectedCount: number;
    /** 当前状态：是否全部折叠 */
    allCollapsed: boolean;
}

export abstract class IEditor {
    /**
     * IEditor实例不应直接构造，而应通过异步工厂函数创建。
     */
    protected constructor() {
        if (this.constructor === IEditor) {
            throw new Error("IEditor is an interface and cannot be instantiated directly.");
        }
    }

    /**
     * 异步初始化编辑器DOM和核心服务。
     * 这是创建实例后的第一步。
     * @param container - 编辑器将挂载的HTML元素。
     */
    abstract init(container: HTMLElement, initialContent?: string): Promise<void>;

    /**
     * 销毁编辑器实例并释放所有资源。
     * 此方法必须返回一个 Promise，以允许调用者等待异步清理/保存操作完成。
     * @returns {Promise<void>} A promise that resolves when destruction is complete.
     */
    abstract destroy(): Promise<void>;

    abstract getText(): string;
    abstract setText(markdown: string): void;

    abstract focus(): void;

    // --- 状态与UI交互 ---
    abstract getMode(): 'edit' | 'render';
    abstract switchToMode(mode: 'edit' | 'render'): Promise<void>;
    abstract setTitle(newTitle: string): void;
    abstract setReadOnly(isReadOnly: boolean): void;

    /** Sync the backing VFS path after a path-based node ID changes. */
    updateNodeId?: (newNodeId: string) => void;

    // --- 【优化】脏检查接口 ---
    /**
     * 检查编辑器内容是否自上次保存或加载以来被用户修改过。
     * @returns {boolean} 如果内容已修改，则返回 true。
     */
    abstract isDirty(): boolean;

    /** Save all pending edits; reject without disposing the editor on failure. */
    flushPendingSave?(): Promise<void>;
    cancelPendingRender?(): void;

    /**
     * 手动设置编辑器的脏状态。
     * @param {boolean} isDirty - 新的脏状态。
     */
    abstract setDirty(isDirty: boolean): void;

    /**
     * [新增] 清理未引用的伴生资源 (可选实现)
     * 用于移除当前文档中不再被引用但仍存在于伴生目录中的文件。
     * 这是一个维护性操作，通常由用户手动触发。
     * @returns 返回清理掉的文件数量，不支持则返回 null
     */
    async pruneAssets(): Promise<number | null> {
        return null;
    }

    // --- ✨ [新增] 代码块折叠/展开接口 ---

    /**
     * 折叠编辑器内所有代码块
     * 
     * @returns 操作结果，包含受影响的代码块数量
     * 
     * @example
     * ```typescript
     * const result = await editor.collapseBlocks();
     * console.log(`已折叠 ${result.affectedCount} 个代码块`);
     * ```
     */
    async collapseBlocks(): Promise<CollapseExpandResult> {
        // 默认实现：不支持的编辑器返回空结果
        return { affectedCount: 0, allCollapsed: true };
    }

    /**
     * 展开编辑器内所有代码块
     * 
     * @returns 操作结果，包含受影响的代码块数量
     * 
     * @example
     * ```typescript
     * const result = await editor.expandBlocks();
     * console.log(`已展开 ${result.affectedCount} 个代码块`);
     * ```
     */
    async expandBlocks(): Promise<CollapseExpandResult> {
        // 默认实现：不支持的编辑器返回空结果
        return { affectedCount: 0, allCollapsed: false };
    }

    /**
     * 切换所有代码块的折叠状态
     * 如果当前有任何展开的代码块，则全部折叠；否则全部展开
     * 
     * @returns 操作结果
     */
    async toggleBlocks(): Promise<CollapseExpandResult> {
        // 默认实现：委托给 collapse
        return this.collapseBlocks();
    }

    // --- 内容分析 ---
    abstract readonly commands: Readonly<Record<string, Function>>;

    async getHeadings(): Promise<Heading[]> {
        return [];
    }

    async getSearchableText(): Promise<string> {
        const content = this.getText();
        return content
            .replace(/^#+\s/gm, '')
            .replace(/\[(.*?)\]\(.*?\)/g, '$1')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[^`]+`/g, '')
            .trim();
    }

    async getSummary(): Promise<string | null> {
        return null;
    }

    /**
     * ✨ [重构] 导航到文档内的指定元素
     * 
     * 支持两种模式：
     * - render 模式：通过 DOM querySelector 查找并滚动到目标元素
     * - edit 模式：通过解析 Markdown 源码定位标题位置，使用 CodeMirror 滚动并高亮
     * 
     * @param target - 导航目标，包含 elementId（如 "heading-introduction"）
     * @param options - 导航选项
     */
    abstract navigateTo(target: { elementId: string }, options?: NavigateToOptions): Promise<void>;

    // --- 搜索 ---
    abstract search(query: string): Promise<UnifiedSearchResult[]>;
    abstract gotoMatch(result: UnifiedSearchResult): void;
    abstract clearSearch(): void;

    // --- 事件系统 ---
    abstract on<E extends EditorEvent>(
        eventName: E,
        callback: EditorEventCallback<E>,
    ): () => void;
}
