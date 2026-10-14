import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { DEFAULT_HARNESS_TOOL_IDS } from '../presets/harness-tools';
import { FSError } from '@itookit/vfs-core';
export interface ToolGrantTarget { id: string; serverId?: string }
export interface AgentGrantStore { getAgents(): Promise<AgentDefinition[]>; saveAgent(agent: AgentDefinition): Promise<void> }
export function toolGrant(tool: ToolGrantTarget, agent: AgentDefinition) {
    const key = tool.serverId ? 'mcpProfileIds' : 'toolIds';
    const id = tool.serverId ?? tool.id.slice('builtin:'.length);
    const defaults = tool.serverId ? (agent.capabilityPolicy ? [] : agent.config.mcpServers ?? []) : DEFAULT_HARNESS_TOOL_IDS;
    return { key, id, ids: agent.capabilityPolicy?.[key] ?? defaults } as const;
}
export async function saveToolGrant(store: AgentGrantStore, tool: ToolGrantTarget, agentId: string, enabled: boolean): Promise<void> {
    if (!tool.serverId && !tool.id.startsWith('builtin:')) throw new FSError('EINVAL', 'Unknown tool grant target');
    const agent = (await store.getAgents()).find(item => item.id === agentId);
    if (!agent) throw new FSError('ENOENT', 'Agent not found');
    const { key, id, ids } = toolGrant(tool, agent), next = new Set(ids);
    if (enabled) next.add(id); else next.delete(id);
    await store.saveAgent({ ...agent, capabilityPolicy: {
        mcpProfileIds: agent.capabilityPolicy ? [] : agent.config.mcpServers ?? [],
        ...agent.capabilityPolicy, [key]: [...next],
    } });
}
