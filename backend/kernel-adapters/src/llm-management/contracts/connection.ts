// Compatibility exports; communication contracts are owned by the client.
import type { DailyCost, ModelTier, ApiProtocol, LLMProvider, LLMConnection, ConnectionMeta } from '@itookit/driver-llm/contracts';
export type { ModelCategory, LLMModel, DailyCost, ModelTier, ApiProtocol, LLMProviderImplementation, LLMProvider, LLMConnection, ConnectionMeta, ConnectionTestResult, ProviderConnectionTestParams } from '@itookit/driver-llm/contracts';


// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * 在 provider 的模型目录中按 name（display name）查找模型。
 * 返回匹配的 model ID，未找到返回 undefined。
 */
function findModelByName(provider: LLMProvider, name: string): string | undefined {
    return provider.models.find(m => m.name === name)?.id;
}

/**
 * 跨 provider 解析 model ID。
 *
 * 当 connection 从 provider A 切换到 provider B 时，tiers 中存储的是 A 的 model ID，
 * 在 B 的模型目录中可能不存在。此函数尝试按以下策略解析：
 *   1. 直接 ID 匹配（modelId 在 provider.models 中存在）
 *   2. 在所有 provider 中查找 modelId 的 name，再在目标 provider 中按 name 匹配
 *   3. 在目标 provider 中按 name 直接匹配（当 modelId 恰好是 display name 时）
 *
 * @param modelId  待解析的模型 ID
 * @param provider  目标 provider
 * @param allProviders  所有 provider 的集合（用于跨 provider name 查找），可选
 * @returns 匹配到的 model ID，未匹配到返回 undefined
 */
export function resolveModelId(
    modelId: string,
    provider: LLMProvider,
    allProviders?: Iterable<LLMProvider>,
): string | undefined {
    // 1. Direct ID match
    if (provider.models.some(m => m.id === modelId)) return modelId;

    // 2. Cross-provider: find the model's name from any provider, then match by name
    if (allProviders) {
        for (const p of allProviders) {
            const srcModel = p.models.find(m => m.id === modelId);
            if (srcModel) {
                const match = findModelByName(provider, srcModel.name);
                if (match) return match;
                break; // found the source model but no name match in target
            }
        }
    }

    // 3. Fallback: try direct name match in target provider
    return findModelByName(provider, modelId);
}

/**
 * 将完整连接转换为安全元数据。
 * hasApiKey 从 provider.apiKey 解析。
 *
 * @param allProviders  所有 provider（用于跨 provider 的 model ID → name → ID 解析）
 */
export function toConnectionMeta(
    conn: LLMConnection,
    provider?: LLMProvider,
    allProviders?: Iterable<LLMProvider>,
): ConnectionMeta {
    // Tier config lives exclusively on Connection; Provider has no defaultTiers.
    const effectiveTiers = conn.tiers;
    const directModel =
        effectiveTiers?.optimal
        ?? provider?.models[0]?.id
        ?? '';
    const resolvedModel =
        provider && effectiveTiers?.optimal
            ? resolveModelId(effectiveTiers.optimal, provider, allProviders)
                ?? provider.models[0]?.id
                ?? ''
            : directModel;
    const pid = conn.providerId;

    return {
        id: conn.id,
        name: conn.name,
        providerId: pid,
        model: resolvedModel,
        tiers: effectiveTiers,
        hasApiKey: !!(provider?.apiKey?.trim()),
        // enabled = both connection and provider must be enabled (undefined treated as true)
        enabled: conn.enabled !== false && provider?.enabled !== false,
        metadata: conn.metadata as Record<string, unknown>,
        status: conn.status,
        temperature: conn.temperature ?? provider?.defaultTemperature,
        dailyCosts: conn.dailyCosts,
        protocol: conn.protocol,
    };
}

/**
 * 返回 Provider 的安全视图（剥离 apiKey）。
 * `getProviders()` 使用此函数对外暴露 provider 列表。
 */
export function toProviderMeta(provider: LLMProvider): Omit<LLMProvider, 'apiKey'> {
    const { apiKey: _apiKey, ...meta } = provider as LLMProvider & { apiKey?: string };
    return meta;
}

/** 解析指定 tier 对应的模型 ID */
/** 层级 fallback 顺序：fast → standard → optimal → model */
const TIER_FALLBACK: Record<ModelTier, ModelTier[]> = {
    fast:     ['fast', 'standard', 'optimal'],
    standard: ['standard', 'optimal'],
    optimal:  ['optimal'],
};

/**
 * 解析指定 tier 对应的模型 ID，未配置时自动向上 fallback。
 *
 * 例：选择「快速」但连接未配置 fast/standard → fallback 到 optimal → model
 */
export function resolveModelForTier(
    conn: Pick<ConnectionMeta, 'model' | 'tiers'>,
    tier: ModelTier,
): string {
    for (const t of TIER_FALLBACK[tier]) {
        const modelId = conn.tiers?.[t];
        if (modelId) return modelId;
    }
    return conn.model;
}

/** 解析最终温度：connection.temperature → provider.defaultTemperature → undefined */
export function resolveTemperature(
    conn: Pick<LLMConnection, 'temperature'>,
    provider?: Pick<LLMProvider, 'defaultTemperature'>,
): number | undefined {
    return conn.temperature ?? provider?.defaultTemperature;
}

/**
 * 聚合所有 Connection 的每日开销 → Provider 级别汇总。
 * 按日期合并，同名日期累加所有 Connection 的数据。
 */
export function aggregateProviderCosts(
    connections: Pick<LLMConnection, 'dailyCosts'>[],
): Record<string, DailyCost> {
    const result: Record<string, DailyCost> = {};
    for (const conn of connections) {
        if (!conn.dailyCosts) continue;
        for (const [date, c] of Object.entries(conn.dailyCosts)) {
            if (result[date]) {
                result[date].inputTokens += c.inputTokens;
                result[date].outputTokens += c.outputTokens;
                result[date].cost += c.cost;
                result[date].requests += c.requests;
            } else {
                result[date] = { ...c };
            }
        }
    }
    return result;
}

/** 返回下一个更低成本的层级，optimal → standard → fast → undefined */
export function getNextLowerTier(
    current: ModelTier,
    tiers: Partial<Record<ModelTier, string>>,
): ModelTier | undefined {
    if (current === 'optimal') return tiers.standard ? 'standard' : tiers.fast ? 'fast' : undefined;
    if (current === 'standard') return tiers.fast ? 'fast' : undefined;
    return undefined;
}

/**
 * 根据 Provider 能力与用户总开关解析联网搜索策略。
 *
 * @param capabilities  当前 Provider 能力（LLMProvider.capabilities）
 * @param enabled       用户是否启用联网搜索（总开关）
 * @param protocol      连接 API 协议；某些 Provider 的内置 search 仅在特定协议下可用
 *   （如 DeepSeek/OpenAI 的 `web_search` 内置工具在 `openai-responses` 协议下才生效，
 *   Gemini 的 `googleSearch` 在 `gemini-generate` 协议下生效）。
 * @returns 三态策略；enabled=false 时返回 'disabled'。
 */
export function resolveWebSearchStrategy(
    capabilities?: { serverSideWebSearch?: boolean },
    enabled = true,
    protocol?: ApiProtocol,
): WebSearchMode {
    if (!enabled) return 'disabled';
    const builtin = !!capabilities?.serverSideWebSearch && supportsServerSideSearch(protocol);
    return builtin ? 'builtin' : 'client-tool';
}

/** 判断协议是否支持 server-side 内置检索。未指定协议时按 Provider 能力判定（向后兼容）。 */
function supportsServerSideSearch(protocol?: ApiProtocol): boolean {
    if (!protocol) return true;
    return protocol === 'openai-responses' || protocol === 'gemini-generate';
}

export interface DefaultConnectionDef {
    /** 连接唯一 ID，'default' 表示系统默认连接 */
    id: string;
    /** 连接显示名称 */
    name: string;
    /** 引用的 Provider ID */
    providerId: string;
    /** Tier → model ID 映射 */
    tiers?: Partial<Record<ModelTier, string>>;
    /** API 协议类型；未设置时由 resolveProtocol() 自动推断 */
    protocol?: ApiProtocol;
}

export type WebSearchMode = 'builtin' | 'client-tool' | 'disabled';
