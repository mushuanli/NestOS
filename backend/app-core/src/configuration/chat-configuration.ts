import { getProviderDefaultProtocol } from '@itookit/driver-llm/contracts';
import type { ChatConfigurationSnapshot, ChatConfigurationView, IAgentConfigService } from '@itookit/kernel-adapters/contracts';

/** One host observation supplies all metadata needed by chat selectors. */
export async function createChatConfigurationView(service: IAgentConfigService): Promise<ChatConfigurationView> {
    let current: ChatConfigurationSnapshot;
    let closed = false, dirty = false, pending: Promise<void> | undefined;
    const listeners = new Set<() => void>();
    const refresh = (): Promise<void> => {
        dirty = true;
        return pending ??= (async () => {
            while (dirty && !closed) {
                dirty = false;
                const next = await readConfiguration(service);
                if (dirty || closed) continue;
                current = next;
                for (const listener of listeners) {
                    try { listener(); } catch { /* Each observer owns its own failure. */ }
                }
            }
        })().finally(() => {
            pending = undefined;
            if (dirty && !closed) void refresh().catch(() => console.warn('[ChatConfiguration] Refresh failed'));
        });
    };
    const unsubscribe = service.onChange(() => { void refresh().catch(() => console.warn('[ChatConfiguration] Refresh failed')); });
    try { await refresh(); } catch (error) { closed = true; unsubscribe(); throw error; }
    return {
        getConfigurationSnapshot: () => current,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose: async () => { closed = true; unsubscribe(); listeners.clear(); await pending; },
    };
}

async function readConfiguration(service: IAgentConfigService): Promise<ChatConfigurationSnapshot> {
    const agents = service.listAgents();
    const ids = [...new Set(agents.flatMap(agent => agent.config.systemPromptId ? [agent.config.systemPromptId] : []))];
    const [connections, fallback, presets] = await Promise.all([
        service.getConnections(), service.getDefaultConnection(),
        Promise.all(ids.map(async id => [id, (await service.getSystemPrompt(id))?.presets ?? []] as const)),
    ]);
    return structuredClone({ agents: agents.map(({id, name, icon, description, defaultPrompts, config, execution, availability}) => ({
        id, name, icon, description, defaultPrompts, ...(execution ? { execution } : {}), ...(availability ? { availability } : {}), config: {systemPromptId: config.systemPromptId,
            ...(config.imageProcessing ? {imageProcessing: structuredClone(config.imageProcessing)} : {})},
    })), connections, defaultConnectionId: fallback?.id,
        promptPresets: Object.fromEntries(presets),
        providers: service.getProviders().map(provider => ({id: provider.id, name: provider.name, enabled: provider.enabled, models: provider.models, defaultProtocol: getProviderDefaultProtocol(provider)})),
    });
}
