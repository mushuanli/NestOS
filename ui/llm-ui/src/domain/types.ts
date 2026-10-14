// @file: llm-ui/domain/types.ts

import type { JsonValue } from '@itookit/llm-flow/contracts';
import type { ModelTier } from '@itookit/driver-llm/contracts';
import type { PromptPreset } from '@itookit/llm-tasks/contracts';
import type { SessionTokenUsage } from '@itookit/llm-session/contracts';
import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';

export type { PromptPreset } from '@itookit/llm-tasks/contracts';

// ============================================================
// 节点操作
// ============================================================

export type NodeAction =
    | 'regenerate'
    | 'delete'
    | 'edit'
    | 'edit-and-retry'
    | 'edit-agent'
    | 'prev-sibling'
    | 'next-sibling';

export interface NodeActionCallback {
    (action: NodeAction, nodeId: string): void;
}

// ============================================================
// 折叠状态
// ============================================================

export type CollapseStateMap = Record<string, boolean>;

// ============================================================
// 分支
// ============================================================

export interface BranchItem {
    name: string;
    headNodeId: string;
    isCurrent: boolean;
}

export type BranchAction = 'create' | 'rename' | 'delete' | 'select';

// ============================================================
// UI 状态（持久化用）
// ============================================================

export interface UIState {
    collapse_states: CollapseStateMap;
    input_text?: string;
    input_agent_id?: string;
    /** Pure workspace preference; never changes the model context. */
    history_visibility?: 'visible' | 'hidden';
}

// ============================================================
// 执行器/模型选项（跨层共享的数据结构）
// ============================================================

export interface ExecutorOption {
    id: string;
    name: string;
    icon?: string;
    category?: string;
    description?: string;
    /** Agent 预设的快捷 Prompt 列表（供输入框下拉选择填入） */
    defaultPrompts?: PromptPreset[];
}

export interface ModelOption {
    id: string;
    name: string;
    provider?: string;
    contextLength?: number;
    description?: string;
}

/** 连接选项（用于 ChatInput 连接选择器，不含 apiKey） */
export interface ConnectionOption {
    isDefault?: boolean;
    id: string;
    name: string;
    provider?: string;
    /** 关联 Provider 是否已配置 apiKey，未配置时在选择器中置灰提示 */
    hasApiKey: boolean;
    /** 是否配置了 standard 或 fast tier（决定 tier 选择器是否有实际意义） */
    hasTiers: boolean;
    /** tier → model 显示名，供 tier quick-switch popup 展示。key 为 ModelTier，value 为 model name */
    tiers?: Partial<Record<ModelTier, string>>;
}

// ============================================================
// 会话设置
// ============================================================

export interface ChatSessionSettings {
    executionMode?: ChatExecutionMode;
    /** Fixed after the first accepted direct run. */
    executionModeLocked?: boolean;
    /**
     * Session connection selection.
     * Omitted means follow the global default.
     */
    connectionId?: string;
    /**
     * 模型层级偏好。
     * - `'auto'`     — Use the selected connection's optimal tier
     * - `'optimal'`  — 强制使用最优模型
     * - `'standard'` — 强制使用标准模型
     * - `'fast'`     — 强制使用快速/廉价模型
     */
    modelTier?: 'auto' | ModelTier;
    historyLength: number;
    temperature?: number;
    streamMode: boolean;
    /** 推理强度（仅支持 thinking 的模型生效），'auto' 表示使用连接默认 */
    reasoningEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh';
    /** 强制开启/关闭 thinking，undefined=auto（跟随模型默认） */
    thinkingEnabled?: boolean;
    /** 强制开启/关闭联网搜索，undefined=auto（provider 支持内置则用内置，否则客户端工具） */
    webSearchEnabled?: boolean;
    /** 追加到 Agent system prompt 的会话级指令，发送时拼接在原 system prompt 后 */
    systemPromptAppend?: string;
}

export const DEFAULT_SESSION_SETTINGS: ChatSessionSettings = {
    executionMode: 'chat',
    connectionId: undefined,
    modelTier: 'auto',
    historyLength: -1,
    temperature: undefined,
    streamMode: true,
    reasoningEffort: 'auto',
};

export interface ChatOverrides {
    executionMode?: ChatExecutionMode;
    /** Explicit Session connection; absent means follow the global default. */
    connectionId?: string;
    /** 模型层级覆盖（'auto' 不传此字段） */
    modelTier?: ModelTier;
    historyLength?: number;
    temperature?: number;
    streamMode?: boolean;
    /** 推理强度（仅支持 thinking 的模型生效） */
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    /** 强制开启/关闭 thinking（覆盖模型默认） */
    thinkingEnabled?: boolean;
    /** 强制开启/关闭联网搜索（覆盖 provider 自动决策；走底层内置或客户端 WebSearchTool） */
    webSearchEnabled?: boolean;
    /** 追加到 Agent system prompt（覆盖本次请求） */
    systemPromptAppend?: string;
    flowId?: string;
    flowRevision?: number;
    /** Workflow runtime parameters (matched against FlowRevision.parameters). */
    flowParameters?: Record<string, JsonValue>;
    branchMode?: 'continue' | 'fork';
    baseRoundId?: string;
    newBranchName?: string;
    retentionMode?: 'persistent' | 'temporary';
}

// ── Token meter types ──────────────────────────────────────────────────────

/**
 * UI 层 token 用量快照，由 TokenMeterPlugin 显示。
 * 直接复用 llm-session 的 SessionTokenUsage（llm-ui 本就依赖 llm-session，无需独立副本）。
 */
export type TokenStats = SessionTokenUsage;

// ── File mention types ──────────────────────────────────────────────────────

/**
 * 文件引用建议项（供 MentionPlugin 使用）
 */
export interface FileSuggestion {
    /** 文件名（显示用） */
    name: string;
    /**
     * 插入文本中的路径字符串。
     *
     * - VFS 模块相对路径：`./notes/api.md`
     * - Asset 路径：`@asset/xxx`
     * - 若以 `@` 开头则 AttachmentProcessor 可直接解析
     */
    path: string;
    /** 文件 MIME 类型（决定插入为图片还是链接） */
    mimeType?: string;
    /** 文件大小（字节） */
    size?: number;
}

// ── Skill invocation types ──────────────────────────────────────────────────

export interface SkillInvocation {
    skillId: string;
    /** Named arguments: --key value */
    args: Record<string, string>;
    /**
     * File paths resolved from:
     *   - Markdown links: [file.ts](./file.ts)  ← inserted by MentionPlugin
     *   - Direct @refs:   @auth.ts
     */
    filePaths: string[];
    /** Glob patterns from @*.ts / @src/*.ts syntax */
    globPatterns: string[];
    /** Remaining free text (after removing args/files) */
    text: string;
    /** Text selected in textarea at invocation time (captured by ChatInput) */
    selectionText?: string;
}

// ── Skill picker types ──────────────────────────────────────────────────────

/**
 * Skill 信息（供 UI 渲染，不含内部实现细节）
 */
export interface SkillInfo {
    versionDigest?: string;
    unversioned?: boolean;
    versionPolicy?: import('@itookit/tools/contracts').SkillVersionPolicy;
    drift?: import('@itookit/tools/contracts').SkillVersionDrift;
    id: string;
    name: string;
    description: string;
    /** 当前会话是否已加载 */
    loaded: boolean;
    /** 输入区复选框是否可加载：disabled / 静默 / action 的未加载项为 false（设计约定） */
    enabled: boolean;
    /**
     * 定义层面的启用状态，与上面的「可否勾选加载」无关。
     * `/sk-<id>` 手动词令对 action / 静默 Skill 也出现，因此按本字段过滤。
     */
    definitionEnabled: boolean;
    /** 该 Skill 提供的工具数量 */
    toolCount: number;
    toolIds?: string[];
    authorizedToolCount?: number;
    capabilitiesManagedByFlow?: boolean;
    icon?: string;
}
