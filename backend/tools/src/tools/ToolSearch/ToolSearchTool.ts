// @file: tools/src/tools/ToolSearch/ToolSearchTool.ts
// Tool search — enables deferred tool discovery.
//
// When the tool pool is large (50+ tools from MCP servers), sending every tool's
// full schema to the model is wasteful. Instead, deferred tools (shouldDefer: true)
// are sent with defer_loading, and the model calls ToolSearch to find relevant ones.
//
// Two modes:
//   select:A,B,C    → direct lookup by name (returns tool_reference blocks)
//   keyword search  → scored search across name, searchHint, and prompt

import { z } from 'zod/v4';
import {
  buildTool,
  type Tool,
  findToolByName,
  type ToolDef,
} from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { TOOL_SEARCH_TOOL_NAME, DESCRIPTION } from './prompt';

// ── Schema ──

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .describe('"select:Name1,Name2" for direct selection, or keyword search terms'),
    max_results: z.number().optional().default(5).describe('Max results for keyword search'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(z.string()).describe('Matching tool names'),
    query: z.string(),
    totalDeferredTools: z.number(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

// ── Helpers ──

/** Check if a tool is a deferred tool (shouldDefer === true). */
function isDeferredTool(tool: Tool): boolean {
  return tool.shouldDefer === true;
}

/** Split a camelCase or PascalCase name into words. */
function splitNameParts(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-]+/);
}

/**
 * Score a tool against search terms.
 * Higher score = better match.
 */
function scoreTool(tool: Tool, terms: string[], requiredTerms: string[]): number {
  const nameParts = splitNameParts(tool.name);
  const nameLower = tool.name.toLowerCase();
  let score = 0;

  // Required terms: ALL must match in name or desc
  for (const req of requiredTerms) {
    const r = req.toLowerCase();
    const inName = nameParts.some((p) => p === r) || nameLower.includes(r);
    const inSearchHint = tool.searchHint?.toLowerCase().includes(r);
    if (!inName && !inSearchHint) return -1; // Required term missing → reject
  }

  // Preferred terms: score each match
  for (const term of terms) {
    const t = term.toLowerCase();

    // Exact name part match (e.g. "git" in "GitLogTool")
    if (nameParts.some((p) => p === t)) {
      score += 10;
      continue;
    }
    // Partial name part match
    if (nameParts.some((p) => p.includes(t))) {
      score += 5;
      continue;
    }
    // Full name substring
    if (nameLower.includes(t)) {
      score += 3;
      continue;
    }
    // searchHint match
    if (tool.searchHint?.toLowerCase().includes(t)) {
      score += 4;
    }
  }

  return score;
}

// ── Factory ──

/**
 * Create a ToolSearch tool.
 *
 * @param getTools - Callback that returns the current tool registry.
 *   Called at invocation time so newly registered tools are always visible.
 *
 * @example
 *   const toolSearch = createToolSearchTool(() => toolDriver.getAllTools());
 *   toolDriver.registerToolInstance(toolSearch);
 */
export function createToolSearchTool(getTools: () => Tool[]) {
  return buildTool({
    name: TOOL_SEARCH_TOOL_NAME,
    searchHint: 'find tools by keyword or name',
    maxResultSizeChars: 10_000,

    async description() {
      return DESCRIPTION;
    },

    userFacingName(input) {
      return input?.query ? `ToolSearch "${input.query.slice(0, 50)}"` : 'ToolSearch';
    },

    getToolUseSummary(input) {
      return input?.query ? `"${input.query.slice(0, 60)}"` : null;
    },

    get inputSchema(): InputSchema {
      return inputSchema();
    },
    get outputSchema(): OutputSchema {
      return outputSchema();
    },

    isConcurrencySafe() {
      return true;
    },
    isReadOnly() {
      return true;
    },

    async prompt() {
      return DESCRIPTION;
    },

    async call(input, _context) {
      const allTools = getTools();
      const deferredTools = allTools.filter(isDeferredTool);

    // ── Direct selection: select:A,B,C ──
    if (input.query.startsWith('select:') || input.query.startsWith('SELECT:')) {
      const selectorPart = input.query.slice(input.query.indexOf(':') + 1);
      const names = selectorPart.split(',').map((n) => n.trim()).filter(Boolean);

      const matches: string[] = [];
      for (const name of names) {
        // Try deferred tools first, then all tools
        const found =
          findToolByName(deferredTools, name) ??
          findToolByName(allTools, name);
        if (found) matches.push(found.name);
      }

      return {
        data: {
          matches,
          query: input.query,
          totalDeferredTools: deferredTools.length,
        },
      };
    }

    // ── Keyword search ──
    // Parse terms: +term = required, plain term = preferred
    const rawTerms = input.query.split(/\s+/).filter(Boolean);
    const requiredTerms = rawTerms
      .filter((t) => t.startsWith('+'))
      .map((t) => t.slice(1));
    const searchTerms = rawTerms.filter((t) => !t.startsWith('+'));

    // Exact name match fast-path
    const exactMatch = findToolByName(deferredTools, input.query);
    if (exactMatch) {
      return {
        data: {
          matches: [exactMatch.name],
          query: input.query,
          totalDeferredTools: deferredTools.length,
        },
      };
    }

    // MCP prefix match: if query starts with mcp__, find all matching
    if (input.query.startsWith('mcp__')) {
      const prefix = input.query.toLowerCase();
      const matches = deferredTools
        .filter((t) => t.name.toLowerCase().startsWith(prefix))
        .map((t) => t.name)
        .slice(0, input.max_results ?? 5);
      return {
        data: { matches, query: input.query, totalDeferredTools: deferredTools.length },
      };
    }

    // Scored search
    const scored = deferredTools
      .map((tool) => ({ name: tool.name, score: scoreTool(tool, searchTerms, requiredTerms) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.max_results ?? 5);

    return {
      data: {
        matches: scored.map((e) => e.name),
        query: input.query,
        totalDeferredTools: deferredTools.length,
      },
    };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.matches.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `No matching tools found for "${output.query}" (${output.totalDeferredTools} deferred tools available).`,
      };
    }
    const lines = output.matches.map((name) => `- ${name}`);
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Tools matching "${output.query}" (${output.matches.length} of ${output.totalDeferredTools} deferred):\n${lines.join('\n')}`,
    };
  },
  } satisfies ToolDef<InputSchema, Output>);
}
