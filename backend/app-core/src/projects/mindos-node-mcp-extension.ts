import type { MCPConfigurationExtension, MCPConfigurationExtensionContext } from '@itookit/kernel-adapters/llm/core';
import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import { FSError } from '@itookit/vfs-core';
import { MINDOS_NODE_EXTENSION, isMindOSNodeTool, remoteMCPConnection, type MindOSNodeConfiguration } from './mcp-remote-connections';

/** mindos-node is one registered extension of standard MCP discovery. */
export function createMindOSNodeMCPExtension(): MCPConfigurationExtension {
    return {key:MINDOS_NODE_EXTENSION,matches:matchesMindOSNode,discover:discoverMindOSNode};
}
function matchesMindOSNode(server: MCPServer, discovery: MCPDiscovery): boolean {
    return server.transport === 'http' && !!server.endpoint && !!(server.apiKey || server.auth)
        && (Object.hasOwn(discovery.metadata ?? {},'itookit/mindos-node') || Object.hasOwn(discovery.metadata ?? {},MINDOS_NODE_EXTENSION)
            || discovery.tools.some(tool => !!tool && isMindOSNodeTool(tool.name)));
}
async function discoverMindOSNode({server,discovery,callTool}: MCPConfigurationExtensionContext): Promise<MindOSNodeConfiguration> {
    const key = Object.hasOwn(discovery.metadata ?? {}, 'itookit/mindos-node') ? 'itookit/mindos-node' : MINDOS_NODE_EXTENSION;
    let value = discovery.metadata?.[key];
    if (!Object.hasOwn(discovery.metadata ?? {},key)) {
        const name = discovery.tools.find(tool => tool.name === 'mindos_node_capabilities')?.name
            ?? discovery.tools.find(tool => tool.name === 'piagent_capabilities')?.name
            ?? discovery.tools.find(tool => tool.name === 'fsagent_capabilities')?.name;
        if (!name) throw new FSError('ECAPABILITY','mindos-node capability discovery unavailable');
        const result = await callTool(name,{});
        if (!result || typeof result !== 'object' || (result as {isError?: boolean}).isError)
            throw new FSError('ECAPABILITY','mindos-node capability discovery failed');
        value = (result as {structuredContent?: unknown}).structuredContent;
    }
    return validateDescriptor(server,value);
}
function validateDescriptor(server: MCPServer, value: unknown): MindOSNodeConfiguration {
    const descriptor = value as MindOSNodeConfiguration | undefined;
    if (!descriptor || !(descriptor.serverId === null || typeof descriptor.serverId === 'string')
        || typeof descriptor.httpEndpoint !== 'string') throw new FSError('ECAPABILITY','Invalid mindos-node discovery');
    const http = new URL(descriptor.httpEndpoint,server.endpoint);
    if (http.username || http.password || http.search || http.hash) throw new FSError('EACCES','Invalid mindos-node HTTP endpoint');
    const extension = {...descriptor,mcpEndpoint:server.endpoint!,httpEndpoint:http.href.replace(/\/+$/,'')};
    if (!remoteMCPConnection({...server,extensions:{[MINDOS_NODE_EXTENSION]:extension}}))
        throw new FSError('ECAPABILITY','Invalid mindos-node discovery');
    return extension;
}
