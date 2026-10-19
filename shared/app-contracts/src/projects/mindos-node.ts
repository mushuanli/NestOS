import type { MCPServer } from '@itookit/tools/mcp-contracts';
/** Stable persisted extension key; product names do not migrate saved grants. */
export const MINDOS_NODE_EXTENSION = 'itookit/pi-agent';
const LEGACY_EXTENSION = 'itookit/fs-agent';
export interface MindOSNodeConfiguration {
    authorization?: import('@itookit/mindos-node-driver').RemoteAuthorization;
    version: 1; mcpEndpoint: string; httpEndpoint: string; fileProtocol: 'fs-agent-http-v1';
    serverId: string | null; harness: boolean; projects?: boolean; projectProtocol?: string; legacy?: boolean;
}
/** Saved grants retain their identities across the product rename. */
export function mindosNodeConfiguration(server: MCPServer): MindOSNodeConfiguration | undefined {
    return (server.extensions?.['itookit/mindos-node'] ?? server.extensions?.[MINDOS_NODE_EXTENSION] ?? server.extensions?.[LEGACY_EXTENSION]) as MindOSNodeConfiguration | undefined;
}
export function isMindOSNodeTool(name: unknown): boolean { return name === 'mindos_node_capabilities' || name === 'piagent_capabilities' || name === 'fsagent_capabilities'; }
