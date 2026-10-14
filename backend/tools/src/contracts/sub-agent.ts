// @file: common/interfaces/agent/sub-agent.ts
// 子代理路由器接口定义。

import type { ModelTier } from '@itookit/driver-llm/contracts';

/**
 * 子代理路由器接口。
 *
 * 核心理念："子代理是上下文防火墙"。
 *
 * 当主 Agent 需要执行大量 I/O（搜索文件、读取多个模块、追踪调用链）时，
 * 中间结果会迅速填满主代理的上下文窗口。
 *
 * 子代理解决方案：
 *   - 独立上下文：子代理拥有全新、空白的上下文窗口
 *   - 精确指令：只传递一个明确的任务描述，不传递主代理历史
 *   - 摘要返回：子代理完成后只返回精炼的结果摘要
 *   - 成本优化：子代理可使用更便宜/更快的模型
 *
 * 效果：主代理上下文增量仅为摘要大小（~500 tokens），
 * 而非完整中间过程（可能 50K+ tokens）。
 */
export interface ISubAgentRouter {
    /**
     * 将任务委托给子代理执行。
     *
     * @param task 子代理任务描述
     * @returns    精炼后的结果摘要
     */
    delegate(task: SubAgentTask): Promise<SubAgentResult>;

    /**
     * 中止当前子代理执行。
     */
    abort(): void;
}

/**
 * 子代理任务。
 */
export interface SubAgentTask {
    /** 任务指令（精确、自包含，不引用主代理历史） */
    instruction: string;
    /**
     * 允许使用的工具 ID 列表。
     *
     * 默认只允许只读工具（file_read / glob_search / grep_search），
     * 防止子代理产生副作用。
     */
    allowedTools?: string[];
    /** 期望的响应格式提示（如 "返回 JSON 数组" / "返回文件路径:行号格式"） */
    responseFormat?: string;
    /** 最大执行轮次 @default 10 */
    maxRounds?: number;
    /** 使用的 LLM 连接 ID（默认使用 subAgent 角色对应的连接） */
    connectionId?: string;
    /**
     * 请求的模型层级（需连接配置 `tiers`）。
     * 优先级低于 `modelName`（精确 model ID）。
     */
    modelTier?: ModelTier;
    /** 工作目录（继承自主代理，用于工具执行） */
    cwd?: string;
    // ── Mission extensions ───────────────────────────────────
    /** Override default sub-agent system prompt (used by delegate_agent with AgentDefinition) */
    systemPrompt?: string;
    /** Override model name (used by delegate_agent with AgentDefinition) */
    modelName?: string;
    /**
     * VFS paths of reference files (journal, summaries) appended to the system prompt.
     * Sub-agent reads these at its discretion for mission context.
     */
    contextFiles?: string[];
}

/**
 * 子代理执行结果。
 */
export interface SubAgentResult {
    /** 是否成功 */
    success: boolean;
    /**
     * 精炼后的结果摘要（返回给主代理）。
     *
     * 子代理负责将所有中间结果提炼为简洁的摘要，
     * 只包含主代理需要的信息。
     */
    summary: string;
    /** 子代理实际执行的轮次 */
    rounds: number;
    /** Token 使用统计 */
    tokenUsage: { input: number; output: number };
    /** 错误信息（仅 success=false 时） */
    error?: string;
}
