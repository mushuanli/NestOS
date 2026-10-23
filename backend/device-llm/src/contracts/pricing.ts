// Pricing configuration and cost record contracts.

// ─── Pricing Config ──────────────────────────────────────────────────────────

/**
 * 单个模型的定价条目。
 * price = [input, output, cache_write, cache_read]，单位 USD/M tokens。
 *
 * providers 字段语义：
 *   - key absent               → 该 provider 不支持此模型
 *   - providers.foo = []       → 路由使用 entry.id，反向查找也匹配 entry.id
 *   - providers.foo = ["a","b"]→ 路由使用 "a"，反向查找匹配 "a" 或 "b"
 *
 * names 字段语义（按 model name 归属定价，补充 providers 的 model ID 匹配）：
 *   - names = ["claude-opus", "opus"] → model.name 等于其中任意一个时命中此条目
 *   - id = "default"                  → 特殊保留 ID，作为全局 fallback 定价
 */
export interface ModelPricingEntry {
    /** 逻辑定价 ID，如 "claude-opus"；"default" 为全局 fallback */
    id: string;
    /** [inputPerM, outputPerM, cacheWritePerM, cacheReadPerM]，USD */
    price: [number, number, number, number];
    /** provider → 实际 model ID 列表 */
    providers: Record<string, string[]>;
    /**
     * 模型名称别名列表（按 model name 归属定价）。
     * 当 modelId === entry.id 或 modelId 匹配 names[] 中任意一项时，命中此条目。
     * 支持 `*` 通配符，如 `claude-opus-*` 匹配所有以 claude-opus- 开头的 model ID。
     * 与 providers 字段互补：providers 按 providerId+modelId 精确匹配，
     * names 按 model name 宽松匹配，适合自定义/未知 provider 的模型归类。
     */
    names?: string[];
    /** Provider defaults, used only when no model entry matches. */
    fallbackFor?: string[];
}

/** pricing.json 根结构 */
export interface ModelPricingConfig {
    model_pricing: ModelPricingEntry[];
    /** Read-only vendor references supplied by the host, independent of editable ledger rates. */
    reference_catalog?: import('./model-price-catalog').ModelPriceCatalog;
}

// ─── Cost Record ─────────────────────────────────────────────────────────────

/**
 * cost.seq 的 value 类型。
 * key = `{sessionId}|{providerId}|{date}`，同 key 每次请求累加。
 * 一个 session 切换 provider 后产生独立记录（不同 key）。
 */
export interface CostRecord {
    sessionId: string;
    providerId: string;
    /** 实际使用的连接 ID，比 provider 更细粒度 */
    connectionId: string;
    /** 实际使用的模型 ID */
    modelId: string;
    /** YYYY-MM-DD */
    date: string;
    inputTokens: number;
    outputTokens: number;
    /** cache 写入 token（cache_creation_input_tokens，仅 Anthropic） */
    cacheWriteTokens?: number;
    /** cache 读取 token（cache_read_input_tokens，仅 Anthropic） */
    cacheReadTokens?: number;
    /** 费用，USD */
    cost: number;
    /** 本 key 累计请求次数 */
    requests: number;
}

// ─── Pricing Lookup ──────────────────────────────────────────────────────────

/**
 * 按 (providerId, actualModelId) 反向查找对应定价条目。
 *
 * 匹配优先级：
 *   1. providers 精确匹配（providerId + modelId）
 *   2. names 匹配（modelId === entry.id 或匹配 entry.names[] 中任意一项，支持 * 通配符）
 *   3. fallbackFor contains providerId
 *   4. id = "default" global fallback
 *
 * 找不到任何匹配时返回 undefined，调用方应 fallback 到内联常量价格。
 */
export function lookupPricingEntry(
    config: ModelPricingConfig,
    providerId: string,
    actualModelId: string,
): ModelPricingEntry | undefined {
    return resolvePricingEntry(config, providerId, actualModelId)?.entry;
}

export type PricingBasis = 'model' | 'provider-default' | 'global-default';
/** Materialize editable defaults from the caller's global template, without inventing rates. */
export function ensureProviderPricing(config: ModelPricingConfig, providerIds: Iterable<string>): ModelPricingConfig {
    const template = config.model_pricing.find(entry => entry.id === 'default' && !entry.fallbackFor?.length);
    if (!template) return config;
    const covered = new Set(config.model_pricing.flatMap(entry => entry.fallbackFor ?? []));
    const ids = new Set(config.model_pricing.map(entry => entry.id));
    const added: ModelPricingEntry[] = [];
    for (const provider of providerIds) {
        if (covered.has(provider)) continue;
        let id = `provider-default-${provider}`, suffix = 1;
        while (ids.has(id)) id = `provider-default-${provider}-${suffix++}`;
        ids.add(id); covered.add(provider);
        added.push({id, fallbackFor: [provider], providers: {}, price: [...template.price]});
    }
    return added.length ? {...config, model_pricing: [...config.model_pricing, ...added]} : config;
}
/** Resolution mechanism; catalogs and fallback prices are supplied by the host. */
export function resolvePricingEntry(config: ModelPricingConfig, providerId: string, modelId: string):
    {entry: ModelPricingEntry; basis: PricingBasis} | undefined {
    let global: ModelPricingEntry | undefined, provider: ModelPricingEntry | undefined, named: ModelPricingEntry | undefined;
    for (const entry of config.model_pricing) {
        if (entry.fallbackFor?.length) {
            if (!provider && entry.fallbackFor.includes(providerId)) provider = entry;
            continue;
        }
        if (entry.id === 'default') { global = entry; continue; }
        const ids = Object.hasOwn(entry.providers, providerId) ? entry.providers[providerId] : undefined;
        if (ids !== undefined && (ids.length ? ids : [entry.id]).includes(modelId)) return {entry, basis: 'model'};
        if (!named && (matchesName(modelId, entry.id) || entry.names?.some(name => matchesName(modelId, name)))) named = entry;
    }
    return named ? {entry: named, basis: 'model'} : provider ? {entry: provider, basis: 'provider-default'}
        : global ? {entry: global, basis: 'global-default'} : undefined;
}

/** 将 glob 模式（仅支持 * 通配符）转为 RegExp 并测试目标字符串 */
const _reCache = new Map<string, RegExp>();
function matchesName(target: string, pattern: string): boolean {
    if (!pattern.includes('*')) return target === pattern;
    let re = _reCache.get(pattern);
    if (!re) {
        re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        _reCache.set(pattern, re);
    }
    return re.test(target);
}

/** 从 ModelPricingEntry 解构为具名价格字段 */
export function extractPrices(entry: ModelPricingEntry): {
    inputPricePerMillion: number;
    outputPricePerMillion: number;
    cacheWritePricePerMillion: number;
    cacheReadPricePerMillion: number;
} {
    return {
        inputPricePerMillion:      entry.price[0],
        outputPricePerMillion:     entry.price[1],
        cacheWritePricePerMillion: entry.price[2],
        cacheReadPricePerMillion:  entry.price[3],
    };
}

// ─── Cost Aggregation ────────────────────────────────────────────────────────

/** 聚合一组 CostRecord 为汇总值（过滤后调用） */
export function aggregateCostRecords(records: CostRecord[]): {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    cost: number;
    requests: number;
} {
    let inputTokens = 0, outputTokens = 0, cacheWriteTokens = 0,
        cacheReadTokens = 0, cost = 0, requests = 0;
    for (const r of records) {
        inputTokens      += r.inputTokens;
        outputTokens     += r.outputTokens;
        cacheWriteTokens += r.cacheWriteTokens ?? 0;
        cacheReadTokens  += r.cacheReadTokens  ?? 0;
        cost             += r.cost;
        requests         += r.requests;
    }
    return { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, cost, requests };
}
