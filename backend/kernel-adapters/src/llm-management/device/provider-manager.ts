import { isProvider, isStoredProvider } from './argument-validation';
// @file: device-llm/device/provider-manager.ts
//
// ProviderManager — manages LLMProvider catalog (built-in + user custom).

import type { LLMProvider } from '@itookit/driver-llm/contracts';
import type { IFileSystem } from '@itookit/vfs-core';
import { snapshotLlmPresets, type LlmManagementPresets } from '../contracts/presets';
import { loadPricingConfig, writePricingConfig, applyPricingToModel } from '../constants/pricing';
import type { ModelPricingConfig } from '../constants/pricing';
import { VFSHelpers } from './vfs-helpers';

const PROVIDERS_DIR = '/llm/.providers';

export class ProviderManager {
    private _providers: Map<string, LLMProvider> =
        new Map<string, LLMProvider>();
    private _pricingConfig!: ModelPricingConfig;

    constructor(
        private readonly engine: IFileSystem,
        private readonly helpers: VFSHelpers,
        private readonly onChanged: () => void,
        private readonly presets: LlmManagementPresets = snapshotLlmPresets(),
    ) {}

    async loadPricing(): Promise<void> {
        this._pricingConfig = await loadPricingConfig(this.engine, this.presets.pricing);
    }

    /**
     * Writes missing built-in providers to VFS on first boot;
     * syncs structural fields for existing entries.
     */
    async syncDefaultProviders(preLoaded?: LLMProvider[]): Promise<void> {
        const existing = preLoaded ?? await this.helpers.loadJsonFilesFromDir<LLMProvider>(PROVIDERS_DIR, undefined, isStoredProvider);
        const existingIds = new Set(existing.map(p => p.id));
        for (const [key, def] of Object.entries(this.presets.providers)) {
            if (!existingIds.has(key)) {
                await this.writeProviderToDisk({ ...def, id: key, isBuiltin: true });
            } else {
                // Built-in definition may have changed (e.g. anthropicPath fix).
                // Sync structural fields while preserving user data like apiKey.
                const vfs = existing.find(p => p.id === key);
                // Explicit protocol configuration marks user-owned endpoint settings.
                if (vfs && def && !vfs.supportedProtocols) {
                    const needsUpdate =
                        vfs.baseURL !== def.baseURL ||
                        vfs.anthropicPath !== def.anthropicPath ||
                        vfs.implementation !== def.implementation ||
                        vfs.defaultPath !== def.defaultPath;
                    if (needsUpdate) {
                        await this.writeProviderToDisk({
                            ...vfs,
                            baseURL: def.baseURL,
                            anthropicPath: def.anthropicPath,
                            implementation: def.implementation,
                            defaultPath: def.defaultPath,
                            isBuiltin: true,
                        });
                    }
                }
            }
        }
    }

    reloadProvidersFrom(fromVFS: LLMProvider[]): void {
        const merged = new Map(Object.entries(this.presets.providers).map(([k, v]) => [k, { ...v, id: k }]));
        for (const p of fromVFS.filter(isStoredProvider)) {
            if ((p as any).__deleted) { merged.delete(p.id); continue; }
            const def = this.presets.providers[p.id];
            // 内置 Provider：VFS 用户数据优先，但合并内置定义的结构性能力字段
            // （capabilities.serverSideWebSearch / thinking 等），否则旧数据在
            // 保存时丢过 capabilities 会导致内置联网搜索能力永久失效。
            if (def && p.isBuiltin) {
                merged.set(p.id, {
                    ...def,
                    ...p,
                    capabilities: { ...(def.capabilities ?? {}), ...(p.capabilities ?? {}) },
                });
            } else {
                merged.set(p.id, p);
            }
        }
        // Apply pricing config to all model price fields
        for (const [id, provider] of merged) {
            merged.set(id, {
                ...provider,
                models: provider.models.map(m => applyPricingToModel(m, provider.id, this._pricingConfig)),
            });
        }
        this._providers = merged;
    }

    async saveProvider(provider: LLMProvider, systemFS?: IFileSystem): Promise<void> {
        if (!isProvider(provider)) throw new TypeError('Invalid LLM provider');
        await this.writeProviderToDisk(provider, systemFS);
        this._providers.set(provider.id, provider);
        this.onChanged();
    }

    async deleteProvider(id: string, systemFS?: IFileSystem): Promise<void> {
        const provider = this._providers.get(id);
        if (provider?.isBuiltin) {
            // Mark as deleted in VFS rather than removing the file, so
            // reloadProvidersFrom & syncDefaultProviders skip re-creation.
            await this.writeProviderToDisk({ ...provider, __deleted: true } as LLMProvider & { __deleted?: boolean }, systemFS);
        } else {
            await this.deleteProviderFromDisk(id, systemFS);
        }
        this._providers.delete(id);
        this.onChanged();
    }

    /** Get provider without apiKey (safe for UI listing) */
    getProvider(providerId: string): LLMProvider | undefined {
        const p = this._providers.get(providerId);
        if (!p) return undefined;
        return this.stripProviderApiKey(p);
    }

    /** List all providers without apiKey */
    getProviders(): LLMProvider[] {
        return [...this._providers.values()].map(p => this.stripProviderApiKey(p));
    }

    /** Return full provider with apiKey (Settings UI only) */
    getFullProvider(id: string): LLMProvider | undefined {
        return this._providers.get(id);
    }

    getProviderDefaults(): Record<string, LLMProvider> {
        return structuredClone(this.presets.providers);
    }

    getPricingConfig(): import('@itookit/kernel-adapters/contracts').ModelPricingConfig {
        return this._pricingConfig ?? { model_pricing: [] };
    }

    getPricingDefaults(): import('@itookit/kernel-adapters/contracts').ModelPricingConfig {
        return structuredClone(this.presets.pricing);
    }

    async writePricing(config: import('@itookit/kernel-adapters/contracts').ModelPricingConfig): Promise<void> {
        await writePricingConfig(this.engine, config);
        this._pricingConfig = config;
        this.reloadProvidersFrom([...this._providers.values()].filter(p => !p.isBuiltin));
    }

    /** Expose the full provider map for cross-manager use */
    getFullProviderMap(): Map<string, LLMProvider> {
        return this._providers;
    }

    private async writeProviderToDisk(provider: LLMProvider, systemFS?: IFileSystem): Promise<void> {
        await this.helpers.engineUpsert(
            `${PROVIDERS_DIR}/${provider.id}.json`,
            JSON.stringify(provider, null, 2),
            systemFS,
        );
    }

    private async deleteProviderFromDisk(id: string, systemFS?: IFileSystem): Promise<void> {
        const fs = systemFS ?? this.engine;
        const nodeId = await fs.driver.resolvePath(`${PROVIDERS_DIR}/${id}.json`);
        if (nodeId) await fs.driver.delete([nodeId]);
    }

    private stripProviderApiKey(provider: LLMProvider): LLMProvider {
        const { apiKey: _apiKey, ...meta } = provider as LLMProvider & { apiKey?: string };
        return meta as LLMProvider;
    }
}
