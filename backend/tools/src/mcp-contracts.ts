export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;

export interface MCPAuthentication {
    type: 'basic' | 'bearer';
    credentialRef: string;
    username?: string;
}
export interface MCPConnectionState {
    status: 'idle' | 'connecting' | 'connected' | 'error';
    checkedAt?: number;
    issues: Array<{ stage: 'connect' | 'discover'; reason: 'authentication' | 'timeout' | 'network' | 'closed' | 'unknown' }>;
}
export interface MCPServer {
    id: string;
    name: string;
    transport: 'stdio' | 'http';
    command?: string;
    endpoint?: string;
    status?: MCPConnectionState['status'];
    /** Runtime observation only; never persisted with credentials or configuration. */
    connectionState?: MCPConnectionState;
    args?: string;
    cwd?: string;
    apiKey?: string;
    auth?: MCPAuthentication;
    extensions?: Record<string, unknown>;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    autoConnect?: boolean;
    /** Milliseconds; timeoutUnit marks new writes, legacy UI values <= 300 were seconds. */
    timeout?: number;
    timeoutUnit?: 'ms';
    tools?: unknown[];
    resources?: unknown[];
    prompts?: unknown[];
    icon?: string;
    description?: string;
}

export interface MCPDiscovery {
    protocolVersion?: string;
    capabilities?: { tools: boolean; resources: boolean; prompts: boolean };
    /** Namespaced server/discover metadata; business extensions remain host-owned. */
    metadata?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
    tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
    prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
}

/** Saved and exported configuration must not carry runtime observations. */
export function mcpConfiguration(server: MCPServer): MCPServer {
    const {status: _status, connectionState: _connectionState, ...configuration} = server;
    return configuration;
}

/** Normalize old UI seconds and existing millisecond configurations. */
export function mcpTimeoutMs(server: Pick<MCPServer, 'timeout' | 'timeoutUnit'>): number {
    const timeout = server.timeout ?? 30000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('MCP timeout must be positive');
    return server.timeoutUnit === 'ms' || timeout > 300 ? timeout : timeout * 1000;
}
