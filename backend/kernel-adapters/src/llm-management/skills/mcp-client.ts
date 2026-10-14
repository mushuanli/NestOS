import { mcpAuthenticatedFetch } from './mcp-auth';
// @file: device-llm/skills/mcp-client.ts
//
// MCPClient — MCP (Model Context Protocol) client.
// Manages connections to multiple MCP servers via stdio / Streamable HTTP transports.

import { snapshotMCPConnectionOptions, type MCPConnectionOptions } from '../contracts/mcp-transport';
import { MCP_PROTOCOL_VERSION, type MCPDiscovery } from '@itookit/tools/mcp-contracts';
import { type ToolDefinition } from '@itookit/llm-context';
import type { MCPConfig, MCPServerConfig } from './types';

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

// ─── Internal types ───────────────────────────────────────────────────────────

export interface MCPToolInfo {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

// ─── Skill-compatible interfaces ──────────────────────────────────────────────

export interface MCPSkillResult {
    success: boolean;
    data?: any;
    error?: string;
    duration?: number;
    metadata?: Record<string, any>;
}

export interface MCPSkillContext {
    sessionId?: string;
    userId?: string;
    timeout?: number;
    signal?: AbortSignal;
    extra?: Record<string, any>;
}

export interface MCPSkill {
    definition: {
        id: string;
        name: string;
        description: string;
        type: 'mcp';
        tool: ToolDefinition;
        enabled?: boolean;
        metadata?: Record<string, any>;
    };
    execute(args: Record<string, any>, context?: MCPSkillContext): Promise<MCPSkillResult>;
}

// ─── MCPClient ────────────────────────────────────────────────────────────────

/**
 * MCP 客户端
 *
 * 管理多个 MCP 服务器连接。
 * 工具命名规范：`serverName/toolName` → 函数名 `serverName_toolName`
 */
export class MCPClient {
    private servers = new Map<string, MCPServerConnection>();
    private tools = new Map<string, { server: string; tool: MCPToolInfo }>();

    private get log() { return this.options.logger ?? noopLog; }
    private readonly options: MCPConnectionOptions;
    constructor(private config?: MCPConfig, options: MCPConnectionOptions = {}) { this.options = snapshotMCPConnectionOptions(options); }

    async initialize(): Promise<void> {
        if (!this.config?.servers) return;
        for (const serverConfig of this.config.servers) {
            try {
                await this.connectServer(serverConfig);
            } catch (error: any) {
                this.log.error('Failed to connect MCP server', { server: serverConfig.name, error: error.message });
            }
        }
    }

    async connectServer(config: MCPServerConfig): Promise<void> {
        this.log.debug('Connecting MCP server', { name: config.name, transport: config.transport });

        const connection = new MCPServerConnection(config, this.options);
        await connection.connect();
        this.servers.set(config.name, connection);

        const tools = await connection.listTools();
        for (const tool of tools) {
            this.tools.set(`${config.name}/${tool.name}`, { server: config.name, tool });
        }

        this.log.info('MCP server connected', { name: config.name, toolCount: tools.length });
    }

    async disconnectServer(name: string): Promise<void> {
        const connection = this.servers.get(name);
        if (!connection) return;

        await connection.disconnect();
        this.servers.delete(name);

        for (const [key, value] of this.tools) {
            if (value.server === name) this.tools.delete(key);
        }
    }

    async disconnectAll(): Promise<void> {
        for (const name of this.servers.keys()) {
            await this.disconnectServer(name);
        }
    }

    getToolDefinitions(): ToolDefinition[] {
        return Array.from(this.tools.entries()).map(([key, { tool }]) => ({
            type: 'function',
            function: {
                name: key.replace('/', '_'),
                description: tool.description,
                parameters: tool.inputSchema,
            },
        }));
    }

    getSkills(): MCPSkill[] {
        return Array.from(this.tools.entries()).map(([key, { server, tool }]) => {
            const skillId = key.replace('/', '_');
            const self = this;
            return {
                definition: {
                    id: skillId,
                    name: tool.name,
                    description: tool.description,
                    type: 'mcp' as const,
                    tool: {
                        type: 'function',
                        function: {
                            name: skillId,
                            description: tool.description,
                            parameters: tool.inputSchema,
                        },
                    },
                    metadata: { server, originalName: tool.name },
                },
                execute(args: Record<string, any>, context?: MCPSkillContext): Promise<MCPSkillResult> {
                    return self.callTool(server, tool.name, args, context);
                },
            };
        });
    }

    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, any>,
        context?: MCPSkillContext,
    ): Promise<MCPSkillResult> {
        const connection = this.servers.get(serverName);
        if (!connection) {
            return { success: false, error: `MCP server not connected: ${serverName}` };
        }

        try {
            const data = await connection.callTool(toolName, args, {
                timeout: context?.timeout ?? this.config?.timeout ?? 30000,
                signal: context?.signal,
            });
            return { success: true, data };
        } catch (error: any) {
            return { success: false, error: error.message ?? 'MCP tool call failed' };
        }
    }

    getServerStatus(): Record<string, { connected: boolean; toolCount: number }> {
        const result: Record<string, { connected: boolean; toolCount: number }> = {};
        for (const [name, connection] of this.servers) {
            const toolCount = Array.from(this.tools.values()).filter(t => t.server === name).length;
            result[name] = { connected: connection.isConnected(), toolCount };
        }
        return result;
    }
}

// ─── MCPServerConnection ──────────────────────────────────────────────────────

export class MCPServerConnection {
    private client: import('@modelcontextprotocol/client').Client | undefined;
    private connecting: Promise<void> | undefined;
    private closing = false;
    private readonly options: MCPConnectionOptions;
    constructor(private readonly config: MCPServerConfig, options: MCPConnectionOptions = {}, private readonly onConnectionFailure?: (error: unknown) => void) { this.options = snapshotMCPConnectionOptions(options); }

    connect(): Promise<void> {
        if (this.client) return Promise.resolve();
        return this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    }

    private async open(): Promise<void> {
        const { Client } = await import('@modelcontextprotocol/client');
        const client = new Client(this.options.clientInfo ?? { name: 'mcp-client', version: '1.0.0' }, {
            inputRequired: { autoFulfill: false },
            versionNegotiation: { mode: 'auto', probe: {timeoutMs:this.config.timeout ?? 30000,maxRetries:0} },
        });
        const transport = await this.createTransport();
        let transportError: Error | undefined;
        client.onerror = error => {
            transportError = error;
            if (this.client === client && !this.closing) this.onConnectionFailure?.(error);
        };
        try { await client.connect(transport, { timeout: this.config.timeout ?? 30000 }); }
        catch (error) { await client.close(); throw transportError ?? error; }
        client.onclose = () => {
            if (this.client !== client) return;
            this.client = undefined;
            if (!this.closing) this.onConnectionFailure?.(new Error('Connection closed'));
        };
        this.client = client;
    }

    private async createTransport() {
        const config = this.config;
        if (config.transport === 'stdio') {
            if (this.options.stdioTransport === false) throw new Error('MCP stdio is disabled by the host');
            if (this.options.stdioTransport) return this.options.stdioTransport(config);
            if (typeof window !== 'undefined') throw new Error('MCP stdio requires a desktop or Node host');
            if (!config.command) throw new Error('MCP stdio requires command');
            const { createStdioTransport } = await import('#mcp-stdio');
            return createStdioTransport(config);
        }
        if (!config.url) throw new Error('MCP remote transport requires url');
        const url = new URL(config.url);
        if (config.transport !== 'http') throw new Error(`MCP ${MCP_PROTOCOL_VERSION} supports only stdio and Streamable HTTP; update transport ${config.transport}`);
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
        return new StreamableHTTPClientTransport(url, { requestInit: { headers: config.headers },
            ...(config.auth ? { fetch: mcpAuthenticatedFetch(config.auth, this.options.resolveCredential) } : {}) });
    }

    async disconnect(): Promise<void> {
        await this.connecting;
        const client = this.client;
        this.closing = true;
        try { await client?.close(); if (this.client === client) this.client = undefined; }
        finally { this.closing = false; }
    }
    isConnected(): boolean { return Boolean(this.client); }
    async listTools(): Promise<MCPToolInfo[]> {
        if (!this.client) throw new Error('MCP not connected');
        const tools: MCPToolInfo[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await this.client.listTools({ cursor }, { timeout: this.config.timeout ?? 30000 });
            tools.push(...page.tools.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema })));
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error('MCP tools/list returned a repeated cursor');
            if (cursor) seen.add(cursor);
        } while (cursor);
        return tools;
    }
    async discover(): Promise<MCPDiscovery> {
        if (!this.client) throw new Error('MCP not connected');
        const capabilities = this.client.getServerCapabilities();
        const tools = capabilities?.tools ? await this.listTools() : [];
        const resources = capabilities?.resources ? await this.listPages('resources', async cursor => {
            const page = await this.client!.listResources({ cursor }, { timeout: this.config.timeout ?? 30000 });
            return { items: page.resources, nextCursor: page.nextCursor };
        }) : [];
        const prompts = capabilities?.prompts ? await this.listPages('prompts', async cursor => {
            const page = await this.client!.listPrompts({ cursor }, { timeout: this.config.timeout ?? 30000 });
            return { items: page.prompts, nextCursor: page.nextCursor };
        }) : [];
        return { protocolVersion: this.client.getNegotiatedProtocolVersion(), tools, resources, prompts,
            metadata: this.client.getDiscoverResult()?._meta,
            capabilities: { tools: !!capabilities?.tools, resources: !!capabilities?.resources, prompts: !!capabilities?.prompts } };
    }

    private async listPages<T>(kind: string, fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
        const items: T[] = [], seen = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await fetch(cursor); items.push(...page.items); cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error(`MCP ${kind}/list returned a repeated cursor`);
            if (cursor) seen.add(cursor);
        } while (cursor);
        return items;
    }

    async readResource(uri: string, options?: { signal?: AbortSignal }) {
        if (!this.client) throw new Error('MCP not connected');
        return this.client.readResource({ uri }, { ...options, timeout: this.config.timeout ?? 30000 });
    }

    async getPrompt(name: string, args?: Record<string, string>, options?: { signal?: AbortSignal }) {
        if (!this.client) throw new Error('MCP not connected');
        return this.client.getPrompt({ name, arguments: args }, { ...options, timeout: this.config.timeout ?? 30000 });
    }

    async callTool(name: string, args: Record<string, unknown>, options?: { timeout?: number; signal?: AbortSignal; onProgress?: (progress: { progress: number; total?: number; message?: string }) => void }): Promise<unknown> {
        if (!this.client) throw new Error('MCP not connected');
        return this.client.callTool({ name, arguments: args }, { timeout: Math.min(options?.timeout ?? Infinity, this.config.timeout ?? 30000), signal: options?.signal, onprogress: options?.onProgress });
    }
}
