import { CONST_CONFIG_VERSION, LLM_PROVIDERS, DEFAULT_CONNECTIONS, DEFAULT_AGENTS, MODEL_PRICING } from './constants';
import { snapshotLlmPresets, type LlmManagementPresets, type ProviderConnectionPolicy } from './contracts/presets';

/** Optional MindOS catalog; the mechanism entry never imports this module. */
export function createMindosLlmPresets(): LlmManagementPresets {
    return snapshotLlmPresets({ version: CONST_CONFIG_VERSION, providers: LLM_PROVIDERS,
        connections: DEFAULT_CONNECTIONS, agents: DEFAULT_AGENTS, pricing: { model_pricing: MODEL_PRICING } });
}

export const firstChatModelConnection: ProviderConnectionPolicy = (provider, connections) => {
    const model = provider.models.find(model => (model.category ?? 'chat') === 'chat');
    if (provider.enabled === false || !model || connections.some(connection => connection.providerId === provider.id)) return;
    const base = `provider-${provider.id}`;
    let id = base, suffix = 1;
    while (connections.some(connection => connection.id === id)) id = `${base}-${suffix++}`;
    return { id, name: provider.name, providerId: provider.id, enabled: true, tiers: { optimal: model.id } };
};
