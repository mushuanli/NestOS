/** Explicit host bridge entry, separate from model management and product catalogs. */
export { createMCPStdioTransportFactory } from './skills/mcp-host-transport';
export type { MCPProcessBridge, MCPProcessBatch } from './skills/mcp-host-transport';
export type { MCPConnectionOptions, MCPStdioTransportFactory } from './contracts/mcp-transport';
