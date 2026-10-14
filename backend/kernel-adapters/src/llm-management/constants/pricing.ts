// @file: device-llm/constants/pricing.ts
// pricing.json 加载工具 + 路径常量。
// 类型来自 @itookit/common；此文件只负责 VFS IO 和模型字段覆盖。

import type { IFileSystem } from '@itookit/vfs-core';
import type { LLMModel } from '@itookit/driver-llm/contracts';
import type { ModelPricingConfig, ModelPricingEntry } from '@itookit/kernel-adapters/contracts';
import { lookupPricingEntry, extractPrices } from '@itookit/kernel-adapters/contracts';

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
        return JSON.parse(text) as ModelPricingConfig;
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
