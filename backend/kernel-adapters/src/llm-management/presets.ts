import { CONST_CONFIG_VERSION, DEFAULT_CONNECTIONS, DEFAULT_AGENTS } from './constants';
import {createLlmDeviceCatalog} from '@itookit/device-llm';
import { snapshotLlmPresets, type LlmManagementPresets, type ProviderConnectionPolicy } from './contracts/presets';
import type { LLMProvider } from '@itookit/driver-llm/contracts';

/** API templates are available on demand without seeding their providers into user storage. */
export function createMindosProviderTemplates(): LLMProvider[] {
    return Object.values(createLlmDeviceCatalog().providers).filter(provider => provider.id !== 'custom' && provider.credentialMode !== 'host');
}

/** Optional MindOS catalog; the mechanism entry never imports this module. */
export function createMindosLlmPresets(): LlmManagementPresets {
    const device = createLlmDeviceCatalog();
    const providers = Object.fromEntries(['deepseek', 'volcengine', 'doubao-speech'].map(id => [id, device.providers[id]]));
    return snapshotLlmPresets({ version: CONST_CONFIG_VERSION, providers, providerReferences: device.providerReferences,
        connections: DEFAULT_CONNECTIONS.filter(connection => connection.providerId in providers),
        agents: DEFAULT_AGENTS, pricing: device.pricing });
}

export const firstChatModelConnection: ProviderConnectionPolicy = (provider, connections) => {
    const model = provider.models.find(model => (model.category ?? 'chat') === 'chat');
    if (provider.enabled === false || !model || connections.some(connection => connection.providerId === provider.id)) return;
    const base = `provider-${provider.id}`;
    let id = base, suffix = 1;
    while (connections.some(connection => connection.id === id)) id = `${base}-${suffix++}`;
    return { id, name: provider.name, providerId: provider.id, enabled: true, tiers: { optimal: model.id } };
};
