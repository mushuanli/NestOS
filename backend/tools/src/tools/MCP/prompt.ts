// @file: tools/src/tools/MCP/prompt.ts
// Prompt constants for MCP tools.

export const MCP_TOOL_PREFIX = 'mcp__';

export const DESCRIPTION = `MCP (Model Context Protocol) tool — provided by an external MCP server.
These tools are dynamically discovered from connected MCP servers and provide
access to external services, APIs, and data sources.`;

/** Build the normalized tool name for an MCP tool. */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}
