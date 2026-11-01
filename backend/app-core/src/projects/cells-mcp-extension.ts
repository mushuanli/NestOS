import type { MCPConfigurationExtension, MCPConfigurationExtensionContext } from '@itookit/kernel-adapters/llm/core';
import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import { FSError } from '@itookit/vfs-core';
import { CELLS_EXTENSION, isCellsTool, remoteMCPConnection, type CellsConfiguration } from './mcp-remote-connections';

/** cells is one registered extension of standard MCP discovery. */
export function createCellsMCPExtension(): MCPConfigurationExtension {
    return {key:CELLS_EXTENSION,matches:matchesCells,discover:discoverCells};
}
function matchesCells(server: MCPServer, discovery: MCPDiscovery): boolean {
    return server.transport === 'http' && !!server.endpoint && !!(server.apiKey || server.auth)
        && (Object.hasOwn(discovery.metadata ?? {},CELLS_EXTENSION)
            || discovery.tools.some(tool => !!tool && isCellsTool(tool.name)));
}
async function discoverCells({server,discovery,callTool}: MCPConfigurationExtensionContext): Promise<CellsConfiguration> {
    const key = CELLS_EXTENSION;
    let value = discovery.metadata?.[key];
    if (!Object.hasOwn(discovery.metadata ?? {},key)) {
        const name = discovery.tools.find(tool => tool.name === 'cells_capabilities')?.name;
        if (!name) throw new FSError('ECAPABILITY','cells capability discovery unavailable');
        const result = await callTool(name,{});
        if (!result || typeof result !== 'object' || (result as {isError?: boolean}).isError)
            throw new FSError('ECAPABILITY','cells capability discovery failed');
        value = (result as {structuredContent?: unknown}).structuredContent;
    }
    return validateDescriptor(server,value);
}
function validateDescriptor(server: MCPServer, value: unknown): CellsConfiguration {
    const descriptor = value as CellsConfiguration | undefined;
    if (!descriptor || !(descriptor.serverId === null || typeof descriptor.serverId === 'string')
        || typeof descriptor.httpEndpoint !== 'string') throw new FSError('ECAPABILITY','Invalid cells discovery');
    const http = new URL(descriptor.httpEndpoint,server.endpoint);
    if (http.username || http.password || http.search || http.hash) throw new FSError('EACCES','Invalid cells HTTP endpoint');
    const extension = {...descriptor,mcpEndpoint:server.endpoint!,httpEndpoint:http.href.replace(/\/+$/,'')};
    if (!remoteMCPConnection({...server,extensions:{[CELLS_EXTENSION]:extension}}))
        throw new FSError('ECAPABILITY','Invalid cells discovery');
    return extension;
}
