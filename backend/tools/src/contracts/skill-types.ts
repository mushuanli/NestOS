// @file: common/interfaces/skills/skill-types.ts
// Skill 相关的核心类型定义。

import type { ToolDefinition } from '@itookit/llm-context';

/**
 * Skill 类型分类。
 *
 * - builtin:  代码内置（如 load_skill 元工具自身）
 * - http:     远程 HTTP 端点，包装为 function-calling 工具
 * - shell:    本地 Shell 命令，包装为 function-calling 工具
 * - prompt:   纯 Markdown 指令注入，不产生可调用工具（最常用）
 * - mcp:      通过 MCP 协议提供
 * - custom:   用户自定义脚本
 */
export type SkillType = 'builtin' | 'http' | 'shell' | 'prompt' | 'mcp' | 'custom';

/** 触发策略：reference（自动按需）| action（纯手动 slash 命令） */
export type SkillTriggerStrategy = 'reference' | 'action';

/** 作用域层级（文件系统 Skill 专用） */
export type SkillScopeLevel = 'vfs' | 'global-fs' | 'parent-fs' | 'local-fs';

export type SkillVersionPolicy = 'keep-old' | 'require-reload';

/** Persisted executable definition and resolved instruction content. */
export interface SkillVersionSnapshot {
    format: 1;
    digest: string;
    definition: SkillDefinition;
    instructions: string;
    compactInstructions: string;
    policy: SkillVersionPolicy;
}

export interface SkillVersionDrift {
    expectedDigest: string;
    observedDigest: string;
    detectedAt: number;
    policy: SkillVersionPolicy;
}

/**
 * Compact Instructions 区块：历史压缩时必须保留的关键规则。
 *
 * 从 SKILL.md 中 `## Compact Instructions` 区块提取。
 */
export interface CompactSection {
    /** 区块标题（通常为 "Compact Instructions"） */
    marker: string;
    /** `[红线]` 前缀的关键规则列表 */
    redLines: string[];
    /** 原始 Markdown 内容（完整区块文本） */
    rawContent: string;
}

/**
 * 修正日志配置。
 *
 * AI 犯错时写入日志，加载 Skill 时注入历史修正记录。
 */
export interface SkillCorrectionLog {
    /** Explicit virtual project root supplied by the source; otherwise use the Skill scope root. */
    root?: string;
    /** 日志文件路径（相对项目根，例: "docs/agent-corrections.md"） */
    path: string;
    /** 是否启用 */
    enabled: boolean;
}

/** Durable program implemented and registered by a Skill plugin. */
export interface SkillTaskProgramRef {
    kind: string;
    version: string;
}

/**
 * Glob 空间联动模式配置。
 *
 * 匹配文件打开时自动挂载 Skill（L4 层）。
 */
export interface SkillGlobPattern {
    /** Glob 模式，支持 * ** ? {a,b} */
    pattern: string;
    /** 文件打开时自动挂载，默认 true */
    autoMount: boolean;
    /** 文件关闭后若无更多匹配则自动卸载，默认 true */
    autoUnmount: boolean;
}

/**
 * 四层路由分类结果。
 *
 * 由 SkillDeviceDriver.getRouteLayers() 返回，
 * ContextManager 据此构建 P2/P3/P4 系统 Prompt 区段。
 */
export interface SkillRouteLayer {
    /** L1：静默层——disableModelInvocation=true，完全不进入 Prompt */
    silent: SkillDefinition[];
    /** L2：索引层——未加载的 reference skill，仅 id+description 进入 P4 */
    index: SkillDefinition[];
    /** L3：动态挂载层——已加载的 reference skill，完整 instructions 进入 P2 */
    dynamicMount: SkillDefinition[];
    /** L4：空间联动层——glob 匹配挂载的 skill，完整 instructions 进入 P3 */
    spatial: SkillDefinition[];
}

/**
 * 语义匹配上下文（可选）。
 */
export interface SkillMatchContext {
    /** 当前打开的文件路径列表 */
    openFiles?: string[];
    /** 当前工作目录 */
    cwd?: string;
    /** 最近用户消息（用于语义增强） */
    recentUserMessages?: string[];
}

/**
 * 解析后的 Compact Instructions。
 */
export interface ParsedCompactInstructions {
    /** [红线] 规则列表 */
    redLines: string[];
    /** 完整格式化文本（用于注入压缩提示词） */
    fullText: string;
}

/**
 * Skill 定义。
 *
 * Skill = 一组相关的工具 + 系统指令 + 触发条件。
 *
 * 这是渐进式暴露（Progressive Disclosure）的核心单元：
 * 平时 LLM 只看到基础工具 + "有哪些 Skill 可以加载"的提示，
 * 当需要某个 Skill 时通过 load_skill 工具加载。
 */
export interface SkillDefinition {
    /** 唯一标识 */
    id: string;
    /** 名称 */
    name: string;
    /** 描述（显示在 AvailableSkillsSection 中） */
    description: string;
    /** 类型 */
    type: SkillType;
    /** 是否启用 */
    enabled: boolean;
    /** 图标 */
    icon?: string;

    /** 注入到系统提示词的指令（Markdown 格式） */
    instructions: string;

    /**
     * 此 Skill 附带的工具定义列表。
     *
     * 加载 Skill 时，这些工具会注册到 device-tools 中，
     * 并在系统提示词中添加 instructions。
     */
    tools: SkillToolBinding[];

    /**
     * 触发自动加载的关键词/正则模式。
     *
     * 当任务 prompt 匹配任一 pattern 时，自动加载此 Skill。
     */
    triggerPatterns: string[];

    /** 是否随会话自动加载（核心 Skill 设为 true） */
    autoLoad: boolean;

    /** 加载优先级（越小越优先） */
    priority: number;

    /** Host-configured behavior when a persisted loaded definition changes. */
    versionPolicy?: SkillVersionPolicy;

    /** HTTP 端点配置（type='http' 时使用） */
    endpoint?: string;
    method?: 'GET' | 'POST' | 'PUT';
    headers?: Record<string, string>;

    /** LLM function-calling 参数 Schema（type='http' 时使用） */
    parameters?: Record<string, unknown>;

    /** Shell 命令（type='shell' 时使用） */
    command?: string;

    /** MCP Server 引用 ID（type='mcp' 时使用） */
    mcpServerId?: string;
    /** MCP Server 上的具体工具名称（type='mcp' 时使用） */
    mcpToolName?: string;

    /** 额外元数据 */
    metadata?: Record<string, unknown>;
    createdAt?: number;
    modifiedAt?: number;

    // ── 新增字段（全部可选，向后兼容）──

    /** 触发策略（undefined 视为 reference，向后兼容） */
    triggerStrategy?: SkillTriggerStrategy;

    /** 存储来源：vfs（VFS 持久化）| filesystem（文件系统扫描） */
    source?: 'vfs' | 'filesystem';

    /** 作用域层级（文件系统 Skill 专用） */
    scopeLevel?: SkillScopeLevel;

    /** 作用域根目录绝对路径（CWD 变更时判断可见性） */
    scopeRoot?: string;

    /** 禁止模型通过 load_skill 调用（L1 静默层，action skill 设为 true） */
    disableModelInvocation?: boolean;

    /** Glob 模式列表，文件打开时自动挂载（L4 空间联动） */
    globs?: string[];

    /** Compact Instructions 压缩保护区块 */
    compact?: CompactSection | null;

    /** 修正日志配置 */
    correctionLog?: SkillCorrectionLog;

    /** 参考文档路径列表（按需加载的背景知识） */
    referencePaths?: string[];

    /** 输出模板路径 */
    templatePath?: string;

    /** 文件系统根目录（source='filesystem' 时填入） */
    fsRoot?: string;

    /** 是否支持 Subagent 委托执行 */
    supportsSubagent?: boolean;

    /** Subagent 角色标识（与 buildSubagentSystemPrompt 配合使用） */
    subagentRole?: string;
    /** Default model for a delegated child explicitly selecting this Skill. */
    subagentModel?: string;

    /** 多步 Skill 的 Durable TaskProgram；未设置时 Skill 仅提供指令和工具。 */
    taskProgram?: SkillTaskProgramRef;
}

/**
 * Skill 工具绑定。
 *
 * 描述 Skill 附带的一个工具：其 LLM 定义和执行方式。
 */
export interface SkillToolBinding {
    /** 工具 ID */
    toolId: string;
    /** LLM ToolDefinition */
    definition: ToolDefinition;
    /**
     * 执行方式：
     * - 'builtin':   由 kernel-adapters 注册的内置工具处理（skill 只保存引用）
     * - 'http':      HTTP 调用 skill 的 endpoint
     * - 'shell':     本地 Shell 命令，支持 {{argName}} 模板替换
     * - 'handler':   由 Skill 自身的 handler 函数处理（预留）
     */
    executionType: 'builtin' | 'http' | 'shell' | 'handler' | 'mcp';
    mcpServerId?: string;
    mcpToolName?: string;
    /** Argument vector for shell bindings; avoids shell interpolation. */
    args?: string[];
    /**
     * Shell 命令模板（executionType='shell'）。
     * 支持 {{argName}} 占位符，由 LLM 传入的参数替换。
     * 例：`git log --oneline -{{n}} -- {{path}}`
     */
    command?: string;
    /** 工具副作用（用于并行策略） */
    sideEffect?: import('./tool-types').ToolSideEffect;
    /** 超时覆盖 */
    timeoutMs?: number;
}

/**
 * Skill 加载结果
 */
export interface SkillLoadResult {
    /** Skill ID */
    skillId: string;
    /** 是否成功加载 */
    success: boolean;
    /** 新增的工具 ID 列表 */
    toolIds: string[];
    /** Instructions captured at load time for durable consumers. */
    instructions?: string;
    /** Critical rules captured with the loaded instructions. */
    compactInstructions?: string;
    snapshot?: SkillVersionSnapshot;
    /** 错误信息（仅 success=false 时） */
    error?: string;
}
