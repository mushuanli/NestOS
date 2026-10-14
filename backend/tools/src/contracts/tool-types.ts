// Tool execution metadata, requests and results.
// Owned by @itookit/tools; legacy shared packages forward these types.

/**
 * 工具副作用分类。
 *
 * 决定了调度策略：
 * - none     → 纯读操作，可安全并行执行
 * - local    → 本地副作用（文件写入等），需串行执行
 * - external → 外部副作用（网络请求等），需串行 + 用户确认
 */
export type ToolSideEffect = 'none' | 'local' | 'external';

/**
 * 工具权限决策
 */
export type ToolPermission = 'allowed' | 'denied' | 'ask_user';

/**
 * 工具定义元数据。
 *
 * 注意：这与 LLM 的 ToolDefinition（发给模型的 function schema）不同。
 * 这是工具自身的描述信息，包含副作用、超时等运行时属性。
 * 工具注册时需要同时提供此元数据和 LLM ToolDefinition。
 */
export interface ToolMeta {
    /** 工具唯一标识（与设备文件名一致，如 file_read） */
    id: string;
    /** 人类可读名称 */
    name: string;
    /** 工具描述 */
    description: string;
    /** 副作用分类 */
    sideEffect: ToolSideEffect;
    /** 执行超时（毫秒） */
    timeoutMs: number;
    /** 工具类型 */
    type: 'builtin' | 'plugin' | 'mcp';
    /** 是否默认启用 */
    enabled: boolean;
    /** 图标 */
    icon?: string;
    /** 标签 */
    tags?: string[];
    /**
     * Skill 加载器参数键名。
     *
     * 若设置，执行器在此工具调用成功后会取 args[skillLoaderArgKey] 作为 skillId，
     * 调用 contextManager.markSkillLoaded()，触发 agent:skill:loaded 事件。
     * 这样工具本身无需耦合执行器，执行器无需硬编码工具名。
     */
    skillLoaderArgKey?: string;
    /** Persist removal before invoking a live-scope Skill unloader. */
    skillUnloaderArgKey?: string;
}

/**
 * 工具执行请求
 */
export interface ToolProgress {
    /** Human-readable activity, including the resolved search scope where applicable. */
    message: string;
    /** Bounded replacement snapshot, not an authoritative final tool result. */
    output?: string;
}

export interface ToolInvokeRequest {
    onProgress?: (progress: ToolProgress) => Promise<void>;
    /** Host-only admission before legacy output truncation; never a model argument. */
    admitOutput?: (output: string) => Promise<{ output: string; contentRef?: import('@itookit/llm-context').ContentRef }>;
    /** 工具 ID */
    toolId: string;
    /** 调用参数（JSON Schema 验证后的对象） */
    args: Record<string, unknown>;
    /** 工作目录（用于文件/shell 类工具） */
    cwd?: string;
    /** 超时覆盖（毫秒） */
    timeoutMs?: number;
    /** 取消信号 */
    signal?: AbortSignal;
}

/**
 * 工具执行结果
 */
export interface ToolInvokeResult {
    /** Immutable source evidence for an externalized output. */
    contentRef?: import('@itookit/llm-context').ContentRef;
    /** 工具 ID */
    toolId: string;
    /** 是否成功 */
    success: boolean;
    /** 输出内容（字符串，直接作为 tool_result 喂回 LLM） */
    output: string;
    /** 执行耗时（毫秒） */
    durationMs: number;
    /** 错误详情（仅 success=false 时） */
    error?: string;
    /** Stable failure code for model correction and host diagnostics. */
    errorCode?: string;
    /** Only explicit, known tool failures may return to the model for correction. */
    recoverable?: boolean;
    /** Bounded, JSON-serializable output retained alongside the model-facing text. */
    data?: unknown;
    /** Either the text or structured result exceeded the output budget. */
    truncated?: boolean;
    /** 额外元数据 */
    metadata?: Record<string, unknown>;
    /** Trusted adapter snapshot after a successful Skill load; retained across context pruning. */
    skillContext?: {
        skillId: string;
        compactInstructions: string;
        tools?: Array<{ toolId: string; definition: import('@itookit/llm-context').ToolDefinition; external: boolean }>;
    };
}

/**
 * 权限规则
 */
export interface ToolPermissionRule {
    /** glob 风格的工具 ID 匹配 */
    toolPattern: string;
    /** 参数匹配条件（可选） */
    argPatterns?: Record<string, string>;
    /** 权限决策 */
    action: ToolPermission;
    /** 规则说明 */
    reason: string;
}

/**
 * 工具批量执行结果
 */
export interface ToolBatchResult {
    results: ToolInvokeResult[];
    /** 总耗时（毫秒） */
    totalDurationMs: number;
}

/**
 * 危险命令检测结果
 */
export interface DangerousCommandCheck {
    isDangerous: boolean;
    matchedPattern?: string;
    reason?: string;
}
