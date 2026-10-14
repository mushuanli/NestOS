// @file: tools/src/tools/WebSearch/WebSearchTool.ts
// Web search tool — delegates to a pluggable search provider.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { WEB_SEARCH_TOOL_NAME, DESCRIPTION } from './prompt';

// ── Public interface ──

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface IWebSearchProvider {
  search(
    query: string,
    options?: {
      allowedDomains?: string[];
      blockedDomains?: string[];
    },
  ): Promise<{ query: string; results: WebSearchResult[] }>;
}

// ── Schema ──

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Only include results from these domains'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Exclude results from these domains'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The original search query'),
    results: z
      .array(
        z.object({
          title: z.string(),
          url: z.string(),
          snippet: z.string(),
        }),
      )
      .describe('Array of search results'),
    resultCount: z.number().describe('Number of results returned'),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

// ── Factory ──

let defaultProvider: IWebSearchProvider | undefined;

/** Set the global default search provider for WebSearchTool. */
export function setWebSearchProvider(provider: IWebSearchProvider): void {
  defaultProvider = provider;
}

/**
 * Create a WebSearch tool.
 * Uses the provided provider, or falls back to the global default set via setWebSearchProvider().
 */
export function createWebSearchTool(provider?: IWebSearchProvider) {
  return buildTool({
    name: WEB_SEARCH_TOOL_NAME,
    searchHint: 'search the web for current information',
    maxResultSizeChars: 50_000,

    async description() {
      return DESCRIPTION;
    },

    userFacingName(input) {
      return input?.query ? `WebSearch "${input.query.slice(0, 60)}"` : 'WebSearch';
    },

    getToolUseSummary(input) {
      return input?.query ? `"${input.query.slice(0, 80)}"` : null;
    },

    getActivityDescription(input) {
      return input?.query ? `Searching web for "${input.query.slice(0, 50)}"` : 'Searching web';
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
      const sp = provider ?? defaultProvider;
      if (!sp) {
        throw new Error(
          'WebSearchTool: no search provider configured. Call setWebSearchProvider() or pass a provider to createWebSearchTool().',
        );
      }

      const { query, results } = await sp.search(input.query, {
        allowedDomains: input.allowed_domains,
        blockedDomains: input.blocked_domains,
      });

      return {
        data: {
          query,
          results,
          resultCount: results.length,
        },
      };
    },

    mapToolResultToToolResultBlockParam(output, toolUseID) {
      if (output.results.length === 0) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `No results found for "${output.query}".`,
        };
      }
      const lines = output.results.map(
        (r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
      );
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Search results for "${output.query}" (${output.resultCount} results):\n\n${lines.join('\n\n')}`,
      };
    },
  } satisfies ToolDef<InputSchema, Output>);
}

/** Default WebSearch tool instance. Requires setWebSearchProvider() to be called first. */
export const WebSearchTool = createWebSearchTool();
