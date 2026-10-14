import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { MCPServerConfig } from './types';

export function createStdioTransport(config: MCPServerConfig): StdioClientTransport {
    if (!config.command) throw new Error('MCP stdio requires command');
    return new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, stderr: 'ignore' });
}
