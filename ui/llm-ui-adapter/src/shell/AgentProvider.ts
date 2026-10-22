// @file: llm-ui/shell/AgentProvider.ts
// Agent/Connection data-fetching helpers — extracted from LLMWorkspaceEditor.
// Pure async functions: no DOM access, no mutable state.

import { resolveChatModelForTier, resolveChatModelTiers, type IAgentConfigService, type ChatConfigurationSnapshot } from '@itookit/kernel-adapters/contracts';
import type { ExecutorOption, ConnectionOption } from '../domain/types';
import { ENTITY_ICONS, formatDefaultFileTitle, t } from '@itookit/common';
import { modelReasoning, type ConnectionMeta, type LLMProvider } from '@itookit/driver-llm/contracts';

export async function buildExecutorOptions(
    agentService: IAgentConfigService,
    remote?: import('@itookit/ui-common').RemoteAgentControls,
    configuration?: ChatConfigurationSnapshot,
): Promise<ExecutorOption[]> {
    const agents = configuration?.agents ?? agentService.listAgents();
    const promptIds = [...new Set(agents.map(agent => agent.config.systemPromptId).filter((id): id is string => !!id))];
    const prompts = new Map(await Promise.all(promptIds.map(async id => [id, configuration
        ? {presets: configuration.promptPresets[id] ?? []} : await agentService.getSystemPrompt(id)] as const)));

    const seen = new Set<string>();
    const options: ExecutorOption[] = [];

    // Ensure 'default' exists — inject fallback when absent in VFS
    if (!agents.some(a => a.id === 'default')) {
        options.push({ id: 'default', name: t('chatInput.defaultAssistant'), icon: ENTITY_ICONS.agent, category: t('chatInput.assistants') });
        seen.add('default');
    }

    for (const agent of agents) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        const shared = agent.config.systemPromptId ? prompts.get(agent.config.systemPromptId) : null;
        const presets = new Map([...(shared?.presets ?? []), ...(agent.defaultPrompts ?? [])].map(item => [item.name, item]));
        options.push({
            id: agent.id,
            name: agent.name,
            icon: agent.icon,
            category: t('chatInput.assistants'),
            description: agent.description,
            defaultPrompts: [...presets.values()],
            imageProcessing: agent.config.imageProcessing,
            modelDefaults: agent.modelDefaults,
            execution: agent.execution,
            composition: agent.composition,
            availability: agent.availability,
            supportsModels: agent.execution?.kind === 'flow' ? false : undefined,
        });
    }

    return [...options, ...await remote?.list() ?? []];
}

export function validateAgentId(agentService: IAgentConfigService, id: string): string {
    return agentService.findAgent(id) ? id : 'default';
}

export async function buildConnectionOptions(
    agentService: IAgentConfigService,
    configuration?: ChatConfigurationSnapshot,
): Promise<ConnectionOption[]> {
    if (configuration) return configuration.connections.map(connection => connectionOption(connection,
        configuration.providers.find(provider => provider.id === connection.providerId), configuration.defaultConnectionId));
    const [connections, defaultConnection] = await Promise.all([agentService.getConnections(), agentService.getDefaultConnection()]);
    const defaultId = defaultConnection?.id;

    return connections.map(c => connectionOption(c, agentService.getProvider(c.providerId), defaultId));
}

function connectionOption(connection: ConnectionMeta, provider: Pick<LLMProvider, 'id' | 'name' | 'enabled' | 'models' | 'defaultProtocol'> | undefined, defaultId?: string): ConnectionOption {
    const tiers = Object.fromEntries(Object.entries(resolveChatModelTiers(connection, provider))
        .map(([tier, model]) => [tier, model.name || model.id]));
    const resolvedTiers = Object.fromEntries((['optimal', 'standard', 'fast'] as const).map(tier => {
        const model = resolveChatModelForTier(connection, provider, tier);
        return [tier, model ? model.name || model.id : null];
    }));
    return {id: connection.id, isDefault: connection.id === defaultId, name: connection.name, enabled: connection.enabled !== false && provider?.enabled !== false,
        provider: connection.providerId, providerName: provider?.name ?? connection.providerId,
        hasApiKey: connection.hasApiKey, credentialsReady: connection.credentialsReady,
        hasTiers: !!(tiers.standard || tiers.fast), tiers, resolvedTiers,
        reasoningByTier: Object.fromEntries((['optimal', 'standard', 'fast'] as const).map(tier => {
            const model = resolveChatModelForTier(connection, provider, tier);
            return [tier, modelReasoning(model, connection.protocol ?? model?.preferredProtocol ?? provider?.defaultProtocol)];
        }))};
}
export function formatDefaultTitle(agentId: string, agentService: IAgentConfigService): string {
    const base = formatDefaultFileTitle();
    const agentName = sanitizeFileName(getAgentDisplayName(agentId, agentService));
    return `${base}_${agentName}`;
}

export function getAgentDisplayName(agentId: string, agentService: IAgentConfigService): string {
    const agent = agentService.findAgent(agentId);
    return agent?.name || agentId;
}

export function sanitizeFileName(name: string): string {
    return name
        .replace(/[\/\\:*?"<>|]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
