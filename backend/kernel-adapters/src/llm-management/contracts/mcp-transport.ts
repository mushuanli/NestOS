import type { LLMLogSink } from '@itookit/driver-llm/contracts';
import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import type { Transport } from '@modelcontextprotocol/client';
import type { MCPServerConfig } from '../skills/types';

/** A host supplies one independently owned transport per connection. */
export type MCPStdioTransportFactory = (config: MCPServerConfig) => Transport | Promise<Transport>;
export interface MCPConfigurationExtension {
    key: string;
    /** Matching is local and must never probe an unrelated server. */
    matches(server: MCPServer, discovery: MCPDiscovery): boolean;
    discover(context: MCPConfigurationExtensionContext): Promise<unknown>;
}
export interface MCPConfigurationExtensionContext {
    server: MCPServer;
    discovery: MCPDiscovery;
    /** Uses the authenticated connection that performed standard discovery. */
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface MCPConnectionOptions {
    /** Omitted: use Node stdio when available. False: disable stdio explicitly. */
    stdioTransport?: MCPStdioTransportFactory | false;
    resolveCredential?(reference: string): string | Promise<string>;
    extensions?: readonly MCPConfigurationExtension[];
    beforeSave?(server: MCPServer, previous?: MCPServer): void | Promise<void>;
    beforeDelete?(id: string): void | Promise<void>;
    configurationChanged?(): void | Promise<void>;
    logger?: LLMLogSink;
    clientInfo?: { name: string; version: string };
}

/** Preserve host service identity while detaching caller-owned client metadata. */
export function snapshotMCPConnectionOptions(options: MCPConnectionOptions = {}): MCPConnectionOptions {
    const clientInfo = options.clientInfo;
    if (clientInfo !== undefined && (!clientInfo || typeof clientInfo !== 'object'
        || [clientInfo.name, clientInfo.version].some(value => typeof value !== 'string' || !value.trim()))) {
        throw new Error('MCP client name and version must be non-empty strings');
    }
    const extensions = options.extensions?.map(entry => Object.freeze({key:entry.key,
        matches:entry.matches.bind(entry),discover:entry.discover.bind(entry)}));
    return Object.freeze({ ...options, ...(extensions ? {extensions:Object.freeze(extensions)} : {}),
        ...(clientInfo ? { clientInfo: Object.freeze({ ...clientInfo }) } : {}) });
}
