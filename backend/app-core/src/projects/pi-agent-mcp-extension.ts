import type { MCPConfigurationExtension, MCPConfigurationExtensionContext } from '@itookit/kernel-adapters/llm/core';
import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import { FSError } from '@itookit/vfs-core';
import { PI_AGENT_EXTENSION, isPiAgentTool, remoteMCPConnection, type PiAgentConfiguration } from './mcp-remote-connections';

/** pi-agent is one registered extension of standard MCP discovery. */
export function createPiAgentMCPExtension(): MCPConfigurationExtension {
    return {key:PI_AGENT_EXTENSION,matches:matchesPiAgent,discover:discoverPiAgent};
}
function matchesPiAgent(server: MCPServer, discovery: MCPDiscovery): boolean {
    return server.transport === 'http' && !!server.endpoint && !!(server.apiKey || server.auth)
        && (Object.hasOwn(discovery.metadata ?? {},PI_AGENT_EXTENSION)
            || discovery.tools.some(tool => !!tool && isPiAgentTool(tool.name)));
}
async function discoverPiAgent({server,discovery,callTool}: MCPConfigurationExtensionContext): Promise<PiAgentConfiguration> {
    let value = discovery.metadata?.[PI_AGENT_EXTENSION];
    if (!Object.hasOwn(discovery.metadata ?? {},PI_AGENT_EXTENSION)) {
        const name = discovery.tools.find(tool => tool.name === 'piagent_capabilities')?.name
            ?? discovery.tools.find(tool => tool.name === 'fsagent_capabilities')?.name;
        if (!name) throw new FSError('ECAPABILITY','pi-agent capability discovery unavailable');
        const result = await callTool(name,{});
        if (!result || typeof result !== 'object' || (result as {isError?: boolean}).isError)
            throw new FSError('ECAPABILITY','pi-agent capability discovery failed');
        value = (result as {structuredContent?: unknown}).structuredContent;
    }
    return validateDescriptor(server,value);
}
function validateDescriptor(server: MCPServer, value: unknown): PiAgentConfiguration {
    const descriptor = value as PiAgentConfiguration | undefined;
    if (!descriptor || !(descriptor.serverId === null || typeof descriptor.serverId === 'string')
        || typeof descriptor.httpEndpoint !== 'string') throw new FSError('ECAPABILITY','Invalid pi-agent discovery');
    const http = new URL(descriptor.httpEndpoint,server.endpoint);
    if (http.username || http.password || http.search || http.hash) throw new FSError('EACCES','Invalid pi-agent HTTP endpoint');
    const extension = {...descriptor,mcpEndpoint:server.endpoint!,httpEndpoint:http.href.replace(/\/+$/,'')};
    if (!remoteMCPConnection({...server,extensions:{[PI_AGENT_EXTENSION]:extension}}))
        throw new FSError('ECAPABILITY','Invalid pi-agent discovery');
    return extension;
}
