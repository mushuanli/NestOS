import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { DEFAULT_HARNESS_TOOL_IDS } from '../presets/harness-tools';
export interface ToolGrantTarget { id: string; serverId?: string }
export function toolGrant(tool: ToolGrantTarget, agent: AgentDefinition) {
    const key = tool.serverId ? 'mcpProfileIds' : 'toolIds';
    const id = tool.serverId ?? tool.id.slice('builtin:'.length);
    const defaults = tool.serverId ? (agent.capabilityPolicy ? [] : agent.config.mcpServers ?? []) : DEFAULT_HARNESS_TOOL_IDS;
    return { key, id, ids: agent.capabilityPolicy?.[key] ?? defaults } as const;
}
