// @file: llm-ui/shell/AgentProvider.ts
// Agent/Connection data-fetching helpers — extracted from LLMWorkspaceEditor.
// Pure async functions: no DOM access, no mutable state.

import type { IAgentConfigService } from '@itookit/kernel-adapters/contracts';
import type { ExecutorOption, ConnectionOption } from '../domain/types';
import { formatDefaultFileTitle } from '@itookit/common';
import type { ModelTier } from '@itookit/driver-llm/contracts';

export async function buildExecutorOptions(
    agentService: IAgentConfigService,
    remote?: import('@itookit/ui-common').RemoteAgentControls,
): Promise<ExecutorOption[]> {
    const agents = agentService.listAgents();

    const seen = new Set<string>();
    const options: ExecutorOption[] = [];

    // Ensure 'default' exists — inject fallback when absent in VFS
    if (!agents.some(a => a.id === 'default')) {
        options.push({ id: 'default', name: 'Default Assistant', icon: '🤖', category: 'System' });
        seen.add('default');
    }

    for (const agent of agents) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        const shared = agent.config.systemPromptId ? await agentService.getSystemPrompt(agent.config.systemPromptId) : null;
        const presets = new Map([...(shared?.presets ?? []), ...(agent.defaultPrompts ?? [])].map(item => [item.name, item]));
        options.push({
            id: agent.id,
            name: agent.name,
            icon: agent.icon,
            category: agent.type === 'agent' ? 'Agents' :
                agent.type === 'workflow' ? 'Workflows' : 'Other',
            description: agent.description,
            defaultPrompts: [...presets.values()],
        });
    }

    return [...options, ...await remote?.list() ?? []];
}

export function validateAgentId(agentService: IAgentConfigService, id: string): string {
    return agentService.findAgent(id) ? id : 'default';
}

export async function buildConnectionOptions(
    agentService: IAgentConfigService,
): Promise<ConnectionOption[]> {
    const connections = await agentService.getConnections();
    const defaultId = (await agentService.getDefaultConnection())?.id;

    return connections
        .filter(c => c.enabled !== false && agentService.getProvider(c.providerId)?.enabled !== false)
        .map(c => {
            // Use getProvider() — same cache as getProviders() but more direct
            const provider = agentService.getProvider(c.providerId);
            const tiersMap: Partial<Record<ModelTier, string>> = {};

            // Map tier model IDs → display names from provider catalog
            for (const [tier, modelId] of Object.entries(c.tiers ?? {}) as [ModelTier, string][]) {
                if (!modelId) continue;
                const modelName = provider?.models.find(m => m.id === modelId)?.name;
                tiersMap[tier] = modelName ?? modelId;
            }
            // Always populate optimal from c.model (already resolved by toConnectionMeta)
            if (!tiersMap.optimal && c.model) {
                const modelName = provider?.models.find(m => m.id === c.model)?.name;
                tiersMap.optimal = modelName ?? c.model;
            }

            return {
                id: c.id,
                isDefault: c.id === defaultId,
                name: c.name,
                provider: c.providerId,
                hasApiKey: c.hasApiKey,
                hasTiers: !!(c.tiers?.standard || c.tiers?.fast),
                tiers: tiersMap,
            };
        });
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
