import { snapshotLlmPresets, type LlmManagementPresets } from './contracts/presets';
import { getProviderDefs, toLLMProvider, toConnectionDef, toRuntimeAgent, type LLMConfigFile } from './constants/llm-loader';

export type PresetConflictPolicy = 'reject' | 'keep' | 'replace';
export interface ComposeLlmPresetsOptions {
    onConflict?: PresetConflictPolicy;
    /** Static catalogs default to timestamp zero; runtime imports may supply their clock. */
    timestamp?: number;
}

/** Merge catalog fields without global mutation or I/O; Skills and MCP remain service imports. */
export function composeLlmPresets(base: Partial<LlmManagementPresets>, configs: readonly LLMConfigFile[],
    options: ComposeLlmPresetsOptions = {}): LlmManagementPresets {
    const result = snapshotLlmPresets(base);
    const policy = options.onConflict ?? 'reject';
    if (!['reject', 'keep', 'replace'].includes(policy)) throw new Error('Unknown preset conflict policy');
    for (const config of configs) {
        const providers = mergeEntries(Object.values(result.providers), getProviderDefs(config).map(toLLMProvider), policy);
        result.providers = Object.fromEntries(providers.map(provider => [provider.id, provider]));
        result.connections = mergeEntries(result.connections, (config.connections ?? []).map(toConnectionDef), policy);
        result.agents = mergeEntries(result.agents, (config.agents ?? []).map(agent => toRuntimeAgent(agent, options.timestamp ?? 0)), policy);
        result.pricing.model_pricing = mergeEntries(result.pricing.model_pricing, config.pricing ?? [], policy);
    }
    return snapshotLlmPresets(result);
}

function mergeEntries<T extends { id: string }>(existing: T[], incoming: T[], policy: PresetConflictPolicy): T[] {
    const entries = new Map(existing.map(entry => [entry.id, entry]));
    for (const entry of incoming) {
        if (entries.has(entry.id)) {
            if (policy === 'reject') throw new Error(`Duplicate preset id: ${entry.id}`);
            if (policy === 'keep') continue;
        }
        entries.set(entry.id, entry);
    }
    return [...entries.values()];
}
