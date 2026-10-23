// @file: kernel-adapters/llm-management/constants/pricing.ts
// pricing.json 加载工具 + 路径常量。
// Device-owned pricing contracts; this module only handles VFS I/O and model projection.

import type { IFileSystem } from '@itookit/vfs-core';
import type { LLMModel } from '@itookit/driver-llm/contracts';
import type { ModelPricingConfig, ModelPricingEntry } from '@itookit/device-llm/contracts';
import { lookupPricingEntry, extractPrices } from '@itookit/device-llm/contracts';

export const PRICING_FILE_PATH = '/llm/pricing.json';
export const COST_SEQ_PATH     = '/llm/cost.seq';

/**
 * Load persisted pricing, seeding missing data from the supplied host defaults.
 * Invalid persisted data falls back to a fresh copy of those defaults.
 */
export async function loadPricingConfig(engine: IFileSystem, defaults: ModelPricingConfig = { model_pricing: [] }): Promise<ModelPricingConfig> {
    const defaultConfig = structuredClone(defaults);

    try {
        const exists = await engine.driver.exists(PRICING_FILE_PATH);
        if (!exists) {
            await writePricingConfig(engine, defaultConfig);
            return defaultConfig;
        }
        const nodeId = await engine.driver.resolvePath(PRICING_FILE_PATH);
        if (!nodeId) return defaultConfig;
        const raw = await engine.driver.readContent(nodeId);
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
        const config = JSON.parse(text) as ModelPricingConfig;
        const supplied = new Set(config.model_pricing.flatMap(entry => entry.fallbackFor ?? []));
        const ids = new Set(config.model_pricing.map(entry => entry.id));
        const missing = defaultConfig.model_pricing.filter(entry => entry.fallbackFor?.length && !ids.has(entry.id))
            .map(entry => ({...entry, fallbackFor: entry.fallbackFor!.filter(id => !supplied.has(id))})).filter(entry => entry.fallbackFor.length);
        return {...config, model_pricing: [...config.model_pricing, ...missing]};
    } catch (e) {
        console.warn('[LLMDeviceDriver] pricing.json load failed, using supplied defaults:', e);
        return defaultConfig;
    }
}

/** 写入 pricing.json（供首次初始化和 .llm 导入时使用） */
export async function writePricingConfig(
    engine: IFileSystem,
    config: ModelPricingConfig,
): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    const exists = await engine.driver.exists(PRICING_FILE_PATH);
    if (exists) {
        const nodeId = await engine.driver.resolvePath(PRICING_FILE_PATH);
        if (nodeId) await engine.driver.writeContent(nodeId, content);
    } else {
        // Ensure /llm directory exists
        if (!(await engine.driver.exists('/llm'))) {
            await engine.driver.createDirectory({ name: 'llm', parentPath: null });
        }
        const node = await engine.driver.createFile({ name: 'pricing.json', parentPath: '/llm' });
        await engine.driver.writeContent(node.path, content);
    }
}

/**
 * 用 pricing 配置覆盖 LLMModel 的定价字段。
 * 找不到匹配时透传原值（内联常量已预填）。
 */
export function applyPricingToModel(
    model: LLMModel,
    providerId: string,
    config: ModelPricingConfig,
): LLMModel {
    const entry = lookupPricingEntry(config, providerId, model.id);
    if (!entry) return model;
    return { ...model, ...extractPrices(entry) };
}

// Re-export for convenience
export type { ModelPricingEntry, ModelPricingConfig };
