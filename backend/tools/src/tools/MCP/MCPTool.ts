// @file: tools/src/tools/MCP/MCPTool.ts
// MCP tool — proxies to MCP (Model Context Protocol) servers.
//
// Each MCP server tool is wrapped as a Tool instance and registered in the
// ToolDeviceDriver. This allows MCP tools to go through the same execution
// pipeline (permissions, concurrency, timeouts) as built-in tools.

import { z } from 'zod/v4';
import { buildTool, type Tool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { buildMcpToolName } from './prompt';

// ── Public interfaces ──

/** Metadata for a single MCP tool discovered from a server. */
export interface MCPToolDef {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema from the MCP server
}

/** Result of calling an MCP tool. */
export interface MCPCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/** Client interface that x1 hosts must implement to enable MCP tools. */
export interface IMCPClient {
  /** Discover all available tools from all connected MCP servers. */
  listTools(): Promise<MCPToolDef[]>;

  /** Invoke a specific MCP tool on a specific server. */
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallResult>;
}

// ── Passthrough schema ──
// The actual parameter schema comes from the MCP server as JSON Schema.
// Converting arbitrary JSON Schema to Zod at runtime is non-trivial, so we
// use passthrough and rely on the MCP server to validate its own inputs.
const inputSchema = lazySchema(() => z.object({}).passthrough());

// ── Helpers ──

function truncateDesc(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

// ── Output type ──

interface MCPToolOutput {
  serverName: string;
  toolName: string;
  text: string;
  imageCount: number;
  isError: boolean;
}

// ── Factory ──

/**
 * Create Tool instances for all tools discovered from an MCP client.
 *
 * Call this after connecting to MCP servers, then register each tool
 * via toolDriver.registerToolInstance(tool).
 *
 * @example
 *   const client = new MCPClient(...);
 *   await client.connectServer(config);
 *   const tools = await createMCPTools(client);
 *   for (const tool of tools) {
 *     toolDriver.registerToolInstance(tool);
 *   }
 */
export async function createMCPTools(client: IMCPClient): Promise<Tool[]> {
  const toolDefs = await client.listTools();
  return toolDefs.map((def) => createSingleMCPTool(client, def));
}

/**
 * Create a single MCP Tool instance for a specific server tool.
 */
export function createSingleMCPTool(client: IMCPClient, def: MCPToolDef): Tool {
  const name = buildMcpToolName(def.serverName, def.toolName);

  return buildTool({
    name,
    searchHint: def.description.split('.')[0].slice(0, 80),
    maxResultSizeChars: 100_000,

    // For deferred loading: MCP tools are always deferred when ToolSearch is enabled
    shouldDefer: true,

    async description() {
      return truncateDesc(def.description);
    },

    userFacingName() {
      return `${def.serverName} - ${def.toolName} (MCP)`;
    },

    getToolUseSummary(input) {
      if (!input) return null;
      const keys = Object.keys(input);
      if (keys.length === 0) return `${def.serverName}/${def.toolName}`;
      const firstVal = String(input[keys[0]]).slice(0, 60);
      return `${def.serverName}/${def.toolName}: ${firstVal}`;
    },

    getActivityDescription(input) {
      if (!input) return `Calling ${def.serverName}/${def.toolName}`;
      const keys = Object.keys(input);
      if (keys.length === 0) return `Calling ${def.serverName}/${def.toolName}`;
      const firstVal = String(input[keys[0]]).slice(0, 40);
      return `Calling ${def.serverName}/${def.toolName} with ${firstVal}`;
    },

    get inputSchema() {
      return inputSchema() as unknown as ReturnType<typeof inputSchema>;
    },

    isConcurrencySafe() {
      return false;
    },
    isReadOnly() {
      return false;
    },

    async prompt() {
      return truncateDesc(def.description);
    },

    async call(input, _context) {
      const result = await client.callTool(
        def.serverName,
        def.toolName,
        input as Record<string, unknown>,
      );

      // Convert content items to text for the model
      const textParts = result.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);

      const imageCount = result.content.filter((c) => c.type === 'image').length;

      return {
        data: {
          serverName: def.serverName,
          toolName: def.toolName,
          text: textParts.join('\n'),
          imageCount,
          isError: result.isError ?? false,
        },
      };
    },

    mapToolResultToToolResultBlockParam(output: MCPToolOutput, toolUseID) {
      const prefix = output.isError ? '[MCP Error]' : `[MCP: ${output.serverName}/${output.toolName}]`;
      let content: string = `${prefix}\n${output.text}`;
      if (output.imageCount > 0) {
        content += `\n[${output.imageCount} image(s) returned]`;
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content,
      };
    },
  } satisfies ToolDef<ReturnType<typeof inputSchema>, MCPToolOutput>);
}
