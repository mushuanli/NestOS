import type { MCPServer } from '@itookit/tools/mcp-contracts';
/** Canonical cells discovery extension key. */
export const CELLS_EXTENSION = 'itookit/cells';
export interface CellsConfiguration {
    authorization?: import('@itookit/cells-driver').RemoteAuthorization;
    version: 1; mcpEndpoint: string; httpEndpoint: string; fileProtocol: 'fs-agent-http-v1';
    serverId: string | null; harness: boolean; projects?: boolean; projectProtocol?: string; legacy?: boolean;
}
/** Read the cells descriptor attached by verified MCP discovery. */
export function cellsConfiguration(server: MCPServer): CellsConfiguration | undefined {
    return server.extensions?.[CELLS_EXTENSION] as CellsConfiguration | undefined;
}
export function isCellsTool(name: unknown): boolean { return name === 'cells_capabilities'; }
