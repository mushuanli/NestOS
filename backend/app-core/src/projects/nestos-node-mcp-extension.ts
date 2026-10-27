import type { MCPConfigurationExtension, MCPConfigurationExtensionContext } from '@itookit/kernel-adapters/llm/core';
import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import { FSError } from '@itookit/vfs-core';
import { NESTOS_NODE_EXTENSION, isNestOSNodeTool, remoteMCPConnection, type NestOSNodeConfiguration } from './mcp-remote-connections';

/** nestos-node is one registered extension of standard MCP discovery. */
export function createNestOSNodeMCPExtension(): MCPConfigurationExtension {
    return {key:NESTOS_NODE_EXTENSION,matches:matchesNestOSNode,discover:discoverNestOSNode};
}
function matchesNestOSNode(server: MCPServer, discovery: MCPDiscovery): boolean {
    return server.transport === 'http' && !!server.endpoint && !!(server.apiKey || server.auth)
        && (Object.hasOwn(discovery.metadata ?? {},'itookit/nestos-node') || Object.hasOwn(discovery.metadata ?? {},'itookit/mindos-node') || Object.hasOwn(discovery.metadata ?? {},NESTOS_NODE_EXTENSION)
            || discovery.tools.some(tool => !!tool && isNestOSNodeTool(tool.name)));
}
async function discoverNestOSNode({server,discovery,callTool}: MCPConfigurationExtensionContext): Promise<NestOSNodeConfiguration> {
    const key = ['itookit/nestos-node', 'itookit/mindos-node', NESTOS_NODE_EXTENSION].find(key => Object.hasOwn(discovery.metadata ?? {}, key)) ?? NESTOS_NODE_EXTENSION;
    let value = discovery.metadata?.[key];
    if (!Object.hasOwn(discovery.metadata ?? {},key)) {
        const name = discovery.tools.find(tool => tool.name === 'nestos_node_capabilities')?.name
            ?? discovery.tools.find(tool => tool.name === 'mindos_node_capabilities')?.name
            ?? discovery.tools.find(tool => tool.name === 'piagent_capabilities')?.name
            ?? discovery.tools.find(tool => tool.name === 'fsagent_capabilities')?.name;
        if (!name) throw new FSError('ECAPABILITY','nestos-node capability discovery unavailable');
        const result = await callTool(name,{});
        if (!result || typeof result !== 'object' || (result as {isError?: boolean}).isError)
            throw new FSError('ECAPABILITY','nestos-node capability discovery failed');
        value = (result as {structuredContent?: unknown}).structuredContent;
    }
    return validateDescriptor(server,value);
}
function validateDescriptor(server: MCPServer, value: unknown): NestOSNodeConfiguration {
    const descriptor = value as NestOSNodeConfiguration | undefined;
    if (!descriptor || !(descriptor.serverId === null || typeof descriptor.serverId === 'string')
        || typeof descriptor.httpEndpoint !== 'string') throw new FSError('ECAPABILITY','Invalid nestos-node discovery');
    const http = new URL(descriptor.httpEndpoint,server.endpoint);
    if (http.username || http.password || http.search || http.hash) throw new FSError('EACCES','Invalid nestos-node HTTP endpoint');
    const extension = {...descriptor,mcpEndpoint:server.endpoint!,httpEndpoint:http.href.replace(/\/+$/,'')};
    if (!remoteMCPConnection({...server,extensions:{[NESTOS_NODE_EXTENSION]:extension}}))
        throw new FSError('ECAPABILITY','Invalid nestos-node discovery');
    return extension;
}
