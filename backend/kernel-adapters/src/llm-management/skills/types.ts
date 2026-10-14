import type { MCPAuthentication } from '@itookit/tools/mcp-contracts';

// ─── MCP Types (local definition, host integration contracts) ──────────────────

/** MCP 服务器连接配置 */
export interface MCPServerConfig {
    /** 服务器名称（唯一） */
    name: string;
    /** 传输类型 */
    transport: 'stdio' | 'http';
    headers?: Record<string, string>;
    auth?: MCPAuthentication;
    cwd?: string;
    timeout?: number;
    /** 启动命令（stdio 模式） */
    command?: string;
    /** 命令参数（stdio 模式） */
    args?: string[];
    /** Streamable HTTP endpoint URL. */
    url?: string;
    /** 额外环境变量（stdio 模式） */
    env?: Record<string, string>;
}

/** MCP 客户端配置 */
export interface MCPConfig {
    /** MCP 服务器列表 */
    servers: MCPServerConfig[];
    /** 工具调用默认超时 ms */
    timeout?: number;
}

