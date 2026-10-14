/**
 * 单条 prompt 历史记录
 */
export interface PromptHistoryEntry {
    /** 用户输入的原文 */
    text: string;
    /** 记录时间戳 */
    timestamp: number;
    /** 使用的 agent ID */
    agentId?: string;
    /** 所在会话 ID */
    sessionId?: string;
}

/**
 * 搜索/过滤选项
 */
export interface HistoryQueryOptions {
    /** 模糊搜索关键词 */
    query?: string;
    /** 按 agent 过滤 */
    agentId?: string;
    /** 返回条数限制，默认 50 */
    limit?: number;
    /** 偏移量（分页） */
    offset?: number;
}
