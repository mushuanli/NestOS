import type { MCPServer } from '@itookit/tools/mcp-contracts';
/** Stable persisted extension key; product names do not migrate saved grants. */
export const NESTOS_NODE_EXTENSION = 'itookit/pi-agent';
const LEGACY_EXTENSION = 'itookit/fs-agent';
export interface NestOSNodeConfiguration {
    authorization?: import('@itookit/nestos-node-driver').RemoteAuthorization;
    version: 1; mcpEndpoint: string; httpEndpoint: string; fileProtocol: 'fs-agent-http-v1';
    serverId: string | null; harness: boolean; projects?: boolean; projectProtocol?: string; legacy?: boolean;
}
/** Saved grants retain their identities across the product rename. */
export function nestosNodeConfiguration(server: MCPServer): NestOSNodeConfiguration | undefined {
    return (server.extensions?.['itookit/nestos-node'] ?? server.extensions?.['itookit/mindos-node'] ?? server.extensions?.[NESTOS_NODE_EXTENSION] ?? server.extensions?.[LEGACY_EXTENSION]) as NestOSNodeConfiguration | undefined;
}
export function isNestOSNodeTool(name: unknown): boolean { return name === 'nestos_node_capabilities' || name === 'mindos_node_capabilities' || name === 'piagent_capabilities' || name === 'fsagent_capabilities'; }
