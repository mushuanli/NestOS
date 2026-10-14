// @file: device-llm/constants/llm-loader.ts
// .llm file loader — parses YAML-based LLM configuration files.
//
// .llm files are the canonical format for defining:
//   - provider / providers — LLMProvider definitions (API endpoint + model catalog)
//   - connections          — list of Connection (provider + tier mappings)
//   - agents               — list of AgentDefinition (config + system prompt)
//   - skills               — list of LLMSkill definitions
//   - mcp                  — MCP server configs

import yaml from 'js-yaml';
import type { LLMProvider, LLMModel, LLMConnection } from '@itookit/driver-llm/contracts';
import type { DefaultConnectionDef, AgentDefinition, AgentType, AgentConfig, ModelPricingEntry } from '@itookit/kernel-adapters/contracts';

// ─── .llm File Types ─────────────────────────────────────────────────────────

export interface LLMModelDef {
    id: string;
    name: string;
    icon?: string;
    preferredProtocol?: LLMModel['preferredProtocol'];
    category?: LLMModel['category'];
    thinkingMode?: LLMModel['thinkingMode'];
    contextWindow?: number;
    maxOutput?: number;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    supportsTools?: boolean;
    supportsAudio?: boolean;
    supportsVideo?: boolean;
    supportsStructuredOutput?: boolean;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
}

export interface LLMProviderDef {
    id: string;
    name: string;
    implementation: string;
    baseURL: string;
    apiKey?: string;
    icon?: string;
    authMethod?: 'bearer' | 'api-key' | 'query-param';
    supportsThinking?: boolean;
    requiresReferer?: boolean;
    isBuiltin?: boolean;
    enabled?: boolean;
    defaultTemperature?: number;
    /** OpenAI Responses API 兼容路径（如 DeepSeek 的 "/responses"），可选 */
    defaultPath?: string;
    anthropicPath?: string;
    geminiPath?: string;
    chatPath?: string;
    modelsPath?: string;
    supportedProtocols?: LLMProvider['supportedProtocols'];
    defaultProtocol?: LLMProvider['defaultProtocol'];
    responsesPath?: string;
    /** Responses API 推理行为配置（defaultThinkingEnabled 等），可选 */
    responses?: { defaultThinkingEnabled?: boolean };
    models: LLMModelDef[];
}

export interface LLMConnectionDef {
    id: string;
    name: string;
    providerId: string;
    tiers?: Record<string, string>;
}

/** Skill definition as stored in a .llm file — mirrors LLMSkill without runtime timestamps. */
export interface LLMSkillDef {
    id: string;
    name: string;
    description?: string;
    type?: string;              // SkillType; defaults to 'prompt' on import
    enabled?: boolean;          // defaults to true on import
    icon?: string;
    /** Alias for `instructions` (backward compat). */
    prompt?: string;
    instructions?: string;
    // HTTP
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
    // Shell
    command?: string;
    // Function-calling schema
    parameters?: Record<string, unknown>;
    // MCP
    mcpServerId?: string;
    mcpToolName?: string;
    // Behavior
    triggerStrategy?: string;
    autoLoad?: boolean;
    priority?: number;
    globs?: string[];
    correctionLog?: string;
    disableModelInvocation?: boolean;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
}

/** Agent definition as stored in a .llm file — mirrors AgentDefinition without runtime timestamps. */
export interface LLMAgentDef extends Omit<AgentDefinition, 'type' | 'config' | 'interface' | 'createdAt' | 'modifiedAt'> {
    id: string;
    name: string;
    type?: string;              // AgentType; defaults to 'agent' on import
    icon?: string;
    description?: string;
    config: {
        systemPrompt?: string;
        maxHistoryLength?: number;
        temperature?: number;
        mcpServers?: string[];
        [key: string]: unknown;
    };
    tags?: string[];
    interface?: unknown;
}

export interface LLMMCPDef {
    servers: Array<{
        name: string;
        transport: 'stdio' | 'http';
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
    }>;
    timeout?: number;
}

/**
 * .llm file root structure.
 *
 * A single bundle file can contain any combination of:
 *   providers + connections + agents + skills + mcp
 *
 * Singular `provider` is supported for backward compatibility.
 * Use `providers` (array) when a file bundles multiple providers.
 *
 * Dependency order (import respects this order automatically):
 *   providers → connections → agents (independent behavior) → skills → mcp
 */
export interface LLMConfigFile {
    /** Single provider — backward-compat shorthand. Prefer `providers` for new files. */
    provider?: LLMProviderDef;
    /** Multiple providers in one file. Takes precedence over singular `provider`. */
    providers?: LLMProviderDef[];
    connections?: LLMConnectionDef[];
    agents?: LLMAgentDef[];
    skills?: LLMSkillDef[];
    mcp?: LLMMCPDef;
    /**
     * 可选的 model pricing 配置。
     * 导入时：若存在，写入 VFS /llm/pricing.json（覆盖已有）。
     * 导出时：仅在调用方明确传入时才包含（不自动读取 VFS）。
     */
    pricing?: ModelPricingEntry[];
}

/** Normalized view: always returns a (possibly empty) array of providers. */
export function getProviderDefs(config: LLMConfigFile): LLMProviderDef[] {
    if (config.providers?.length) return config.providers;
    if (config.provider) return [config.provider];
    return [];
}

// ─── Import (YAML → typed objects) ──────────────────────────────────────────

/**
 * Parse a .llm YAML string into a typed LLMConfigFile.
 * Throws on invalid YAML or missing required fields.
 */
export function parseLLMConfig(yamlContent: string): LLMConfigFile {
    const raw = yaml.load(yamlContent) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid .llm file: root must be an object');
    }

    const config: LLMConfigFile = {
        // Support both singular `provider` and plural `providers`
        provider: !raw.providers && raw.provider ? (raw.provider as LLMProviderDef) : undefined,
        providers: raw.providers ? (raw.providers as LLMProviderDef[]) : undefined,
        connections: raw.connections ? (raw.connections as LLMConnectionDef[]) : undefined,
        agents: raw.agents ? (raw.agents as LLMAgentDef[]) : undefined,
        skills: raw.skills ? (raw.skills as LLMSkillDef[]) : undefined,
        mcp: raw.mcp ? (raw.mcp as LLMMCPDef) : undefined,
        pricing: raw.pricing ? (raw.pricing as ModelPricingEntry[]) : undefined,
    };

    validateLLMConfig(config);
    return config;
}

/**
 * Validate required fields in a parsed LLMConfigFile.
 * Throws a descriptive Error on the first violation found.
 */
function validateLLMConfig(config: LLMConfigFile): void {
    const providerDefs = config.providers ?? (config.provider ? [config.provider] : []);
    const providerIds = new Set<string>();

    for (const p of providerDefs) {
        if (!p.id)             throw new Error(`Provider missing required field: id`);
        if (!p.name)           throw new Error(`Provider "${p.id}" missing required field: name`);
        if (!p.implementation) throw new Error(`Provider "${p.id}" missing required field: implementation`);
        if (!p.baseURL)        throw new Error(`Provider "${p.id}" missing required field: baseURL`);
        if (!Array.isArray(p.models) || p.models.length === 0) {
            throw new Error(`Provider "${p.id}" must define at least one model`);
        }
        for (const m of p.models) {
            if (!m.id)   throw new Error(`Provider "${p.id}" has a model missing required field: id`);
            if (!m.name) throw new Error(`Provider "${p.id}" model "${m.id}" missing required field: name`);
        }
        providerIds.add(p.id);
    }

    for (const c of config.connections ?? []) {
        if (!c.id)         throw new Error(`Connection missing required field: id`);
        if (!c.name)       throw new Error(`Connection "${c.id}" missing required field: name`);
        if (!c.providerId) throw new Error(`Connection "${c.id}" missing required field: providerId`);
        if (providerIds.size > 0 && !providerIds.has(c.providerId)) {
            throw new Error(`Connection "${c.id}" references unknown provider: "${c.providerId}"`);
        }
    }
}

/**
 * Convert a parsed LLMProviderDef to the runtime LLMProvider type.
 */
export function toLLMProvider(def: LLMProviderDef): LLMProvider {
    return {
        id: def.id,
        name: def.name,
        implementation: def.implementation as LLMProvider['implementation'],
        baseURL: def.baseURL,
        icon: def.icon,
        supportsThinking: def.supportsThinking,
        requiresReferer: def.requiresReferer,
        isBuiltin: def.isBuiltin ?? true,
        enabled: def.enabled,
        defaultTemperature: def.defaultTemperature,
        authMethod: def.authMethod,
        apiKey: def.apiKey,
        defaultPath: def.defaultPath,
        anthropicPath: def.anthropicPath,
        geminiPath: def.geminiPath,
        chatPath: def.chatPath,
        modelsPath: def.modelsPath,
        supportedProtocols: def.supportedProtocols,
        defaultProtocol: def.defaultProtocol,
        responsesPath: def.responsesPath,
        responses: def.responses,
        models: def.models.map(m => ({ ...m } as LLMModel)),
        capabilities: {
            thinking: def.supportsThinking,
        },
    };
}

/**
 * Convert a parsed LLMAgentDef to the runtime AgentDefinition type.
 */
export function toRuntimeAgent(def: LLMAgentDef, timestamp = Date.now()): AgentDefinition {
    const snapshot = structuredClone(def);
    return {
        ...snapshot,
        id: def.id,
        name: def.name,
        type: (def.type ?? 'agent') as AgentType,
        icon: def.icon,
        description: def.description,
        config: {
            ...snapshot.config,
            systemPrompt: def.config.systemPrompt,
            maxHistoryLength: def.config.maxHistoryLength,
            temperature: def.config.temperature,
            mcpServers: snapshot.config.mcpServers,
        } as AgentConfig,
        tags: snapshot.tags,
        interface: snapshot.interface as AgentDefinition['interface'],
        createdAt: timestamp,
    };
}

/**
 * Convert a parsed LLMConnectionDef to the runtime LLMConnection type.
 * The returned connection has no apiKey (apiKey lives on the Provider).
 */
export function toRuntimeConnection(def: LLMConnectionDef): LLMConnection {
    return {
        id: def.id,
        name: def.name,
        providerId: def.providerId,
        tiers: def.tiers as LLMConnection['tiers'],
        createdAt: Date.now(),
    };
}

/**
 * Convert a parsed LLMConnectionDef to the runtime DefaultConnectionDef type.
 */
export function toConnectionDef(def: LLMConnectionDef): DefaultConnectionDef {
    const tiers: DefaultConnectionDef['tiers'] = {};
    if (def.tiers) {
        const tierKeys = ['optimal', 'standard', 'fast'] as const;
        for (const k of tierKeys) {
            if (def.tiers[k]) {
                (tiers as Record<string, string>)[k] = def.tiers[k];
            }
        }
    }
    return {
        id: def.id,
        name: def.name,
        providerId: def.providerId,
        tiers: Object.keys(tiers).length > 0 ? tiers : undefined,
    };
}

// ─── Reverse converters (runtime objects → .llm defs) ───────────────────────

/**
 * Convert runtime LLMProvider → LLMProviderDef (strips apiKey for safety).
 */
export function fromLLMProvider(p: LLMProvider): LLMProviderDef {
    return {
        id: p.id,
        name: p.name,
        implementation: p.implementation,
        baseURL: p.baseURL,
        icon: p.icon,
        authMethod: p.authMethod,
        supportsThinking: p.supportsThinking ?? p.capabilities?.thinking,
        requiresReferer: p.requiresReferer,
        isBuiltin: p.isBuiltin,
        enabled: p.enabled,
        defaultTemperature: p.defaultTemperature,
        defaultPath: p.defaultPath,
        anthropicPath: p.anthropicPath,
        geminiPath: p.geminiPath,
        chatPath: p.chatPath,
        modelsPath: p.modelsPath,
        supportedProtocols: p.supportedProtocols,
        defaultProtocol: p.defaultProtocol,
        responsesPath: p.responsesPath,
        responses: p.responses,
        models: p.models.map(m => ({
            id: m.id,
            name: m.name,
            icon: m.icon,
            preferredProtocol: m.preferredProtocol,
            category: m.category,
            thinkingMode: m.thinkingMode,
            supportsAudio: m.supportsAudio,
            supportsVideo: m.supportsVideo,
            supportsStructuredOutput: m.supportsStructuredOutput,
            contextWindow: m.contextWindow,
            maxOutput: m.maxOutput,
            supportsVision: m.supportsVision,
            supportsThinking: m.supportsThinking,
            supportsTools: m.supportsTools,
            inputPricePerMillion: m.inputPricePerMillion,
            outputPricePerMillion: m.outputPricePerMillion,
        })),
    };
}

/**
 * Convert runtime AgentDefinition → LLMAgentDef for .llm serialization.
 * Strips runtime-only timestamps.
 */
export function fromAgentDef(agent: AgentDefinition): LLMAgentDef {
    const { createdAt: _createdAt, modifiedAt: _modifiedAt, ...definition } = agent;
    return structuredClone({ ...definition, config: { ...definition.config } });
}

/**
 * Convert runtime DefaultConnectionDef → LLMConnectionDef (widen tiers to YAML format).
 */
export function fromConnectionDef(conn: DefaultConnectionDef): LLMConnectionDef {
    return {
        id: conn.id,
        name: conn.name,
        providerId: conn.providerId,
        tiers: conn.tiers as Record<string, string> | undefined,
    };
}

// ─── Export (typed objects → YAML) ───────────────────────────────────────────

/**
 * Serialize a LLMConfigFile to .llm YAML string.
 * Strips apiKey from provider automatically.
 */
export function serializeLLMConfig(config: LLMConfigFile): string {
    const out: Record<string, unknown> = {};

    const defs = getProviderDefs(config);
    if (defs.length === 1) {
        // Single provider → use singular key for readability / backward compat
        const { apiKey: _, ...p } = defs[0] as LLMProviderDef & { apiKey?: string };
        out.provider = p;
    } else if (defs.length > 1) {
        out.providers = defs.map(({ apiKey: _, ...p }: LLMProviderDef & { apiKey?: string }) => p);
    }

    if (config.connections?.length) {
        out.connections = config.connections;
    }
    if (config.agents?.length) {
        out.agents = config.agents;
    }
    if (config.skills?.length) {
        out.skills = config.skills;
    }
    if (config.mcp) {
        out.mcp = config.mcp;
    }

    if (config.pricing !== undefined) out.pricing = config.pricing;

    return yaml.dump(out, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
    });
}

/**
 * Serialize one provider + its connections to .llm YAML.
 */
export function exportToLLM(
    provider: LLMProvider,
    connections: DefaultConnectionDef[],
): string {
    return serializeLLMConfig({
        provider: fromLLMProvider(provider),
        connections: connections.map(fromConnectionDef),
    });
}

/**
 * Serialize multiple providers + connections to a single .llm YAML bundle.
 * Pass `options.pricing` to include model pricing entries in the bundle.
 */
export function exportBundleToLLM(
    providers: LLMProvider[],
    connections: DefaultConnectionDef[],
    options?: { pricing?: ModelPricingEntry[] },
): string {
    return serializeLLMConfig({
        providers: providers.map(fromLLMProvider),
        connections: connections.map(fromConnectionDef),
        pricing: options?.pricing,
    });
}
