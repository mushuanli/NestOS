import type { MCPServerConfig } from './types';
import type { Transport } from '@modelcontextprotocol/client';

export function createStdioTransport(_config: MCPServerConfig): Transport {
    throw new Error('MCP stdio requires a Node host');
}
