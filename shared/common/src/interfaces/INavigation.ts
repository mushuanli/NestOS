// @file: common/interfaces/INavigation.ts

/**
 * 统一导航请求协议
 * 
 * 设计原则：
 * 1. 自包含 — 所有意图信息在 request 内，不依赖 sessionStorage 等侧通道
 * 2. 类型安全 — 按 action 类型细分字段，而非 any
 * 3. 可序列化 — 可存入 history.state，支持浏览器前进/后退
 * 4. 单向流 — 调用方描述意图，接收方决定如何执行
 * 
 * 参考：
 * - VS Code: IOpenEditorOptions { resource, options: { selection, preview } }
 * - Notion: { pageId, blockId, viewType }
 * - Obsidian: { file, state: { mode, source, line } }
 */
export interface NavigationRequest {
    /**
     * 目标模块的语义标识 (URL slug)
     * 
     * 标准值：
     * - 'chat'      -> LLM 会话工作区
     * - 'agents'    -> Agent 配置工作区  
     * - 'settings'  -> 设置工作区
     * - 'anki'      -> Anki 卡片工作区
     * - 'prompts'   -> Prompt 库工作区
     * - 'projects'  -> 项目工作区
     * - 'emails'    -> 邮件草稿工作区
     * - 'private'   -> 私密笔记工作区
     * 
     * 特殊值：
     * - 'self'      -> 当前模块（用于模块内导航）
     */
    target: string;

    /**
     * 导航动作类型
     * 
     * - 'open'   : 打开已有资源（默认）
     * - 'create' : 创建新资源
     * - 'reveal' : 在侧边栏中定位但不打开
     * - 'focus'  : 聚焦到目标模块（不改变当前打开的文件）
     */
    action?: 'open' | 'create' | 'reveal' | 'focus';

    /**
     * 目标资源 ID（action='open' | 'reveal' 时使用）
     */
    resourceId?: string;

    /**
     * 创建参数（action='create' 时使用）
     * 
     * 自包含：所有创建所需信息都在这里，
     * 目标模块不需要从 sessionStorage 等外部源读取。
     */
    create?: {
        /** 新资源标题 */
        title?: string;
        /** 初始内容 */
        content?: string;
        /** 父目录路径 */
        parentPath?: string | null;
    };

    /**
     * 初始状态（创建后或打开后应用）
     * 
     * 用于预填输入框、选择 agent 等。
     * 接收方按自己的能力选择性处理。
     */
    state?: {
        /** 输入框预填文本 */
        inputText?: string;
        /** 预选 agent */
        agentId?: string;
        /** 编辑模式 */
        mode?: 'edit' | 'view' | 'preview';
        /** 定位锚点（heading ID、行号等） */
        anchor?: string;
        /** 搜索高亮 */
        searchQuery?: string;
    };

    /**
     * 导航选项（控制导航行为本身）
     */
    options?: {
        /** 是否在新标签/面板中打开 */
        newTab?: boolean;
        /** 是否替换当前历史记录（而非 push） */
        replaceHistory?: boolean;
        /** 导航后是否聚焦 */
        focus?: boolean;
    };
}

/**
 * 导航事件类型（用于全局事件总线）
 */
export const NAVIGATION_EVENTS = {
    /** 请求导航 */
    NAVIGATE: 'app:navigate',
    /** 导航完成 */
    NAVIGATED: 'app:navigated',
    /** 请求返回 */
    NAVIGATE_BACK: 'app:navigate-back',
} as const;
