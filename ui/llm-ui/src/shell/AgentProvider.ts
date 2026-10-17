// @file: llm-ui/shell/AgentProvider.ts
// Agent/Connection data-fetching helpers — extracted from LLMWorkspaceEditor.
// Pure async functions: no DOM access, no mutable state.

import { resolveChatModelTiers, type IAgentConfigService } from '@itookit/kernel-adapters/contracts';
import type { ExecutorOption, ConnectionOption } from '../domain/types';
import { formatDefaultFileTitle } from '@itookit/common';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';

export async function buildExecutorOptions(
    agentService: IAgentConfigService,
    remote?: import('@itookit/ui-common').RemoteAgentControls,
): Promise<ExecutorOption[]> {
    const agents = agentService.listAgents();
    const promptIds = [...new Set(agents.map(agent => agent.config.systemPromptId).filter((id): id is string => !!id))];
    const prompts = new Map(await Promise.all(promptIds.map(async id => [id, await agentService.getSystemPrompt(id)] as const)));

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
        const shared = agent.config.systemPromptId ? prompts.get(agent.config.systemPromptId) : null;
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
    const [connections, defaultConnection] = await Promise.all([agentService.getConnections(), agentService.getDefaultConnection()]);
    const defaultId = defaultConnection?.id;

    return connections
        .filter(c => c.enabled !== false && agentService.getProvider(c.providerId)?.enabled !== false)
        .map(c => connectionOption(c, agentService.getProvider(c.providerId), defaultId));
}

function connectionOption(connection: ConnectionMeta, provider: LLMProvider | undefined, defaultId?: string): ConnectionOption {
    const tiers = Object.fromEntries(Object.entries(resolveChatModelTiers(connection, provider))
        .map(([tier, model]) => [tier, model.name || model.id]));
    return {id: connection.id, isDefault: connection.id === defaultId, name: connection.name,
        provider: connection.providerId,
        hasApiKey: connection.hasApiKey, credentialsReady: connection.credentialsReady,
        hasTiers: !!(tiers.standard || tiers.fast), tiers};
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
