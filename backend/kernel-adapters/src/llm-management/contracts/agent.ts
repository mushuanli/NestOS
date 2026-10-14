// Agent configuration and management contracts.

import type { LLMConnection, ConnectionMeta, LLMProvider, DefaultConnectionDef, ConnectionTestResult, LLMModel, ProviderConnectionTestParams } from './connection';
import type { RestorableItem } from './restore';
import type { SkillDefinition } from '@itookit/tools/contracts';
import type { SystemPromptDefinition, PromptPreset } from '@itookit/tools/contracts';

// ─── Agent ────────────────────────────────────────────────────────────────────

export type AgentType = 'agent' | 'composite' | 'tool' | 'workflow';

export interface AgentConfig {
    systemPrompt?: string;
    /** Reference a System Prompt library entry (shared by multiple agents). */
    systemPromptId?: string;
    maxHistoryLength?: number;
    temperature?: number;
    mcpServers?: string[];
}

export interface AgentInterfaceDef {
    inputs: Array<{ name: string; type: string }>;
    outputs: Array<{ name: string; type: string }>;
}

/**
 * 预设 Prompt 条目（name → prompt）。
 * 用于 Agent 配置中预定义的快捷提示词，可在输入框下拉选择填入。
 * Re-exported from node-config (part of the unified system-prompt model).
 */
export type { PromptPreset } from '@itookit/tools/contracts';
export interface AgentDefinition {
    id: string;
    /** Version identifier. Phase 3: derived from SHA-256 of canonical JSON. */
    version?: string;
    name: string;
    type: AgentType;
    icon?: string;
    description?: string;
    config: AgentConfig;
    tags?: string[];
    interface?: AgentInterfaceDef;
    defaultPrompts?: PromptPreset[];
    createdAt?: number;
    modifiedAt?: number;

    // ── Phase 3: Structured capability declarations ──────────────────────

    /** System prompt — elevated to top-level for snapshot audit. */
    systemPrompt?: string;

    /** Tool & MCP capability declarations. */
    capabilityPolicy?: {
        /** Undefined selects host defaults; an empty array grants no direct tools. */
        toolIds?: string[];
        /** Static skill references (complements trigger-based progressive disclosure). */
        skillIds?: string[];
        mcpProfileIds: string[];
    };

    /** Memory configuration. */
    memoryPolicy?: {
        namespaceId: string;
        readScopes: string[];
        writeScopes: string[];
        retrievalLimit?: number;
    };

    /** Default context assembly policy. */
    defaultContextPolicy?: {
        tokenBudget?: number;
        automaticCompression?: boolean;
    };
}

/** 仅用于默认 agent 初始化，不持久化 initPath/initialTags */
export type InitialAgentDef = AgentDefinition & {
    initPath?: string;
    initialTags?: string[];
};

// ─── LLMSkill ─────────────────────────────────────────────────────────────────

/**
 * VFS 持久化 Skill 配置。
 * LLMSkill 现在是 SkillDefinition 的类型别名，两者统一为同一类型。
 * 旧格式数据（扁平 command/endpoint/parameters 字段）由 device-llm 读取时迁移。
 */
export type LLMSkill = SkillDefinition;

// ─── MCP ──────────────────────────────────────────────────────────────────────

export { MCP_PROTOCOL_VERSION, mcpTimeoutMs } from '@itookit/tools/mcp-contracts';
export type { MCPServer, MCPDiscovery } from '@itookit/tools/mcp-contracts';
import type { MCPServer, MCPDiscovery } from '@itookit/tools/mcp-contracts';

// ─── IConnectionReader ────────────────────────────────────────────────────────

/**
 * 连接只读接口 — Agent 消费所需的最小连接读取契约。
 * IConnectionService 和 IAgentConfigService 共同继承此接口，消除重复方法声明。
 */
export interface IConnectionReader {
    /** 返回安全元数据列表（不含 apiKey） */
    getConnections(): Promise<ConnectionMeta[]>;
    /** 按 ID 返回安全元数据 */
    getConnection(id: string): Promise<ConnectionMeta | undefined>;
    /** 返回默认连接的安全元数据 */
    getDefaultConnection(): Promise<ConnectionMeta | null>;
    /** 返回完整连接（含 apiKey），仅供 Settings UI 编辑表单使用 */
    getFullConnection(id: string): Promise<LLMConnection | null>;
    /** 监听连接数据变化 */
    onChange(listener: () => void): () => void;
    /** 同步返回连接列表（从内存缓存读取，无 apiKey） */
    listConnections(): ConnectionMeta[];
    /** 同步查找单个连接（从内存缓存读取，无 apiKey） */
    findConnection(id: string): ConnectionMeta | undefined;
    /** 获取单个 Provider 定义 */
    getProvider(providerId: string): LLMProvider | undefined;
    /** 列出所有 Provider（不含 apiKey，供 UI 列表使用） */
    getProviders(): LLMProvider[];
    /** 返回含 apiKey 的完整 Provider（仅供 Settings UI 编辑表单使用） */
    getFullProvider(id: string): LLMProvider | undefined;
}

// ─── IConnectionService ───────────────────────────────────────────────────────

/**
 * 连接配置服务接口 — 由 LLMDeviceDriver 实现。
 *
 * 读取方法返回 ConnectionMeta（不含 apiKey），保持隐私边界；
 * 仅 getFullConnection() / getFullProvider() 返回完整对象，供 Settings UI 编辑使用。
 */
export interface IConnectionService extends IConnectionReader {
    /** Persist the global default; null clears it without choosing a replacement. */
    setDefaultConnection(id: string | null): Promise<void>;
    /** 保存连接（接受完整连接，含 apiKey） */
    saveConnection(conn: LLMConnection): Promise<void>;
    /** 删除连接 */
    deleteConnection(id: string): Promise<void>;
    /** 返回所有内置 Provider 目录（含模型列表、baseURL 等） */
    getProviderDefaults(): Record<string, LLMProvider>;
    /** 保存 Provider 到 VFS（新建或更新，含 apiKey） */
    saveProvider(provider: LLMProvider): Promise<void>;
    /** 删除用户自定义 Provider（内置 Provider 不可删除） */
    deleteProvider(id: string): Promise<void>;
    /** 测试连接参数是否可用（实际发起 HTTP 请求；本地 provider 无需 apiKey） */
    testConnection(params: ProviderConnectionTestParams): Promise<ConnectionTestResult>;
    /** Read a model catalog without persisting the supplied Provider. */
    listProviderModels(provider: LLMProvider): Promise<LLMModel[]>;
}

// ─── ILLMManagementService ───────────────────────────────────────────────────

/**
 * LLM 设备全量管理接口 — 由 LLMDeviceDriver 实现。
 *
 * 聚合连接、MCP Server、Skill 三类资源的 CRUD，
 * 是 VFSAgentService 和 Settings UI 注入的唯一管理服务契约。
 */
export interface ILLMManagementService extends IConnectionService {
    // ── MCP Server ────────────────────────────────────────────────
    /** Capability of this service instance; absent means unsupported. */
    supportsMCPStdio?(): boolean;
    getMCPServers(): Promise<MCPServer[]>;
    saveMCPServer(server: MCPServer): Promise<void>;
    deleteMCPServer(id: string): Promise<void>;
    /** Connect with the supplied draft and discover the server capabilities. */
    testMCPServer(server: MCPServer): Promise<MCPDiscovery>;
    readMCPResource(serverId: string, uri: string): Promise<unknown>;
    getMCPPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<unknown>;

    // ── Skills ────────────────────────────────────────────────────
    getSkills(): Promise<LLMSkill[]>;
    saveSkill(skill: LLMSkill): Promise<void>;
    deleteSkill(id: string): Promise<void>;

    // ── Cost tracking ─────────────────────────────────────────────
    /** 记录一次请求费用到 cost.seq，按 sessionId|providerId|date 累加 */
    recordCost(params: {
        sessionId: string;
        providerId: string;
        connectionId: string;
        modelId: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
            cacheWriteTokens?: number;
            cacheReadTokens?: number;
            cost: number;
        };
    }): Promise<void>;
    /** 将 pricing 配置写入 VFS /llm/pricing.json（供 .llm 导入使用） */
    writePricing(config: import('./pricing').ModelPricingConfig): Promise<void>;
    /** 查询 cost.seq 记录，支持可选的时间范围和 provider 过滤（O(n) 遍历） */
    queryCosts(filter?: {
        dateFrom?: string;   // YYYY-MM-DD
        dateTo?: string;     // YYYY-MM-DD
        providerId?: string;
    }): Promise<import('./pricing').CostRecord[]>;
    /** 返回当前加载的 pricing 快照（从内存读取，同步） */
    getPricingConfig(): import('./pricing').ModelPricingConfig;
    /** 返回内置默认定价表（编译时常量 MODEL_PRICING，用于恢复出厂设置） */
    getPricingDefaults(): import('./pricing').ModelPricingConfig;

    // ── Defaults metadata ─────────────────────────────────────────
    /** 返回当前配置数据版本号，用于增量同步默认数据 */
    getConfigVersion(): number;
    /** 返回内置的默认 Agent 定义列表 */
    getDefaultAgents(): InitialAgentDef[];
    /** 返回内置的默认 Connection 定义列表（含多连接/同 Provider 场景） */
    getDefaultConnections(): DefaultConnectionDef[];
}

// ─── IAgentConfigService ────────────────────────────────────────────────────────────

/**
 * Agent 核心读取接口（SessionManager / AgentResolver 依赖）。
 * 继承 IConnectionReader 获得连接只读能力（Agent 可切换不同 connection），
 * 自身只添加 Agent 特有的读取方法。
 */
export interface IAgentConfigService extends IConnectionReader {
    init(): Promise<void>;
    getAgentConfig(agentId: string): Promise<AgentDefinition | null>;
    /** Host navigation target for the persisted Agent definition. */
    getAgentResourceId?(agentId: string): string | undefined;
    getAgents(): Promise<AgentDefinition[]>;
    /** 同步返回 agent 列表（从内存缓存读取） */
    listAgents(): AgentDefinition[];
    /** 同步查找单个 agent（从内存缓存读取） */
    findAgent(id: string): AgentDefinition | undefined;
    /** Resolve a System Prompt library entry by id. */
    getSystemPrompt(id: string): Promise<SystemPromptDefinition | null>;
    /** List all System Prompt library entries. */
    listSystemPrompts(): Promise<SystemPromptDefinition[]>;
    /** Upsert a System Prompt library entry. */
    saveSystemPrompt(prompt: SystemPromptDefinition): Promise<void>;
    /** Delete a System Prompt library entry by id. */
    deleteSystemPrompt(id: string): Promise<void>;
    /** List Skills so static skillIds can be resolved for Agent/Flow execution. */
    getSkills(): Promise<LLMSkill[]>;
}

// ─── IAgentManagementService ──────────────────────────────────────────────────

/**
 * 完整 Agent 管理接口（Settings UI 消费）。
 * 继承 IAgentService（读） + ILLMManagementService（连接/MCP/Skill 管理），
 * 并增加 Agent CRUD 和恢复/诊断能力。
 */
export interface IAgentManagementService extends IAgentConfigService, ILLMManagementService {
    // Agent CRUD
    saveAgent(agent: AgentDefinition, options?: { onDuplicate?: 'merge' | 'error' }): Promise<void>;
    deleteAgent(agentId: string): Promise<void>;

    // 恢复/诊断
    getRestorableItems(): Promise<RestorableItem[]>;
    restoreItem(type: 'provider' | 'connection' | 'agent', id: string): Promise<void>;
    /** 强制将所有内置 Provider / Connection / Agent 重置为出厂默认值（保留 apiKey） */
    resetAllDefaults(): Promise<void>;
}
