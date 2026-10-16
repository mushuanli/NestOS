import type { MCPServer } from '@itookit/tools/mcp-contracts';
export const PI_AGENT_EXTENSION = 'itookit/pi-agent';
const LEGACY_EXTENSION = 'itookit/fs-agent';
export interface PiAgentConfiguration {
    authorization?: import('@itookit/piagent-driver').RemoteAuthorization;
    version: 1; mcpEndpoint: string; httpEndpoint: string; fileProtocol: 'fs-agent-http-v1';
    serverId: string | null; harness: boolean; projects?: boolean; projectProtocol?: string; legacy?: boolean;
}
/** Saved grants retain their identities across the product rename. */
export function piAgentConfiguration(server: MCPServer): PiAgentConfiguration | undefined {
    return (server.extensions?.[PI_AGENT_EXTENSION] ?? server.extensions?.[LEGACY_EXTENSION]) as PiAgentConfiguration | undefined;
}
export function isPiAgentTool(name: unknown): boolean { return name === 'piagent_capabilities' || name === 'fsagent_capabilities'; }
