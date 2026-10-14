// @file: tools/src/tools/WebFetch/WebFetchTool.ts
// Web fetch tool — retrieves and processes web content.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { WEB_FETCH_NAME, DESCRIPTION } from './prompt';

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('The URL to fetch content from'),
    prompt: z.string().describe('What information you want to extract from the page'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    url: z.string(),
    content: z.string(),
    contentType: z.string(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

function htmlToMarkdown(html: string): string {
  // Simple HTML-to-text conversion (strips tags, decodes entities)
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const WebFetchTool = buildTool({
  name: WEB_FETCH_NAME,
  searchHint: 'fetch and extract web page content',
  maxResultSizeChars: 100_000,

  async description() { return DESCRIPTION; },

  userFacingName(input) {
    return input?.url ? `Fetch ${input.url}` : 'WebFetch';
  },

  getToolUseSummary(input) {
    return input?.url ?? null;
  },

  getActivityDescription(input) {
    return input?.url ? `Fetching ${input.url}` : 'Fetching web page';
  },

  get inputSchema(): InputSchema { return inputSchema(); },
  get outputSchema(): OutputSchema { return outputSchema(); },

  isConcurrencySafe() { return true; },
  isReadOnly() { return true; },

  async prompt() { return DESCRIPTION; },

  async call(input, context) {
    const url = input.url.startsWith('http:') ? input.url.replace('http:', 'https:') : input.url;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), context.timeoutMs);
      // Chain external abort signal so the fetch is cancelled when the agent stops.
      context.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; itookit-tools/1.0)',
          'Accept': 'text/html, text/plain, */*',
        },
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? 'text/plain';
      const text = await response.text();

      const content = contentType.includes('text/html')
        ? htmlToMarkdown(text).slice(0, 50_000)
        : text.slice(0, 50_000);

      return {
        data: { url, content, contentType },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        data: { url, content: `Error fetching ${url}: ${msg}`, contentType: 'error' },
      };
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Content from ${output.url} (${output.contentType}):\n\n${output.content}`,
    };
  },
} satisfies ToolDef<InputSchema, Output>);
