// @file: tools/src/tools/Grep/GrepTool.ts
// Grep content search tool.
//
// Shared discovery rules apply to both authorized VFS and standalone Node searches.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import type { ToolUseContext } from '../../core/types';
import { lazySchema } from '../../core/lazySchema';
import { GREP_TOOL_NAME, DESCRIPTION } from './prompt';
import { globToRegex } from '../../core/globToRegex';
import { discoverToolFiles, displaySearchPath, matchesSearchGlob, readSearchFile } from '../../core/file-discovery';

const inputSchema = lazySchema(() =>
  z.strictObject({
    includeIgnored: z.boolean().optional().describe('Include files excluded by .gitignore, .mindosignore and default directory filters. Does not change access permissions.'),
    pattern: z.string().describe('The regular expression pattern to search for in file contents'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "**/*.tsx")'),
    path: z.string().optional().describe('File or directory to search in. Defaults to current working directory.'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        content: z.string(),
      }),
    ).describe('Array of matched lines with file path and line number'),
    durationMs: z.number().describe('Time taken in milliseconds'),
    numMatches: z.number().describe('Total number of matches found'),
    truncated: z.boolean().describe('Whether results were truncated'),
    skippedFiles: z.number().describe('Files skipped because they exceed the search read limit'),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;
export type Match = Output['matches'][number];

// ── Tool ──

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regex patterns',
  maxResultSizeChars: 100_000,

  async description() { return DESCRIPTION; },

  userFacingName(input) {
    return input?.pattern ? `Grep "${input.pattern}"` : 'Grep';
  },

  getToolUseSummary(input) {
    return input?.pattern ? `"${input.pattern}"` : null;
  },

  getActivityDescription(input) {
    return input?.pattern ? `Searching ${input.pattern}` : 'Searching';
  },

  get inputSchema(): InputSchema { return inputSchema(); },
  get outputSchema(): OutputSchema { return outputSchema(); },

  isConcurrencySafe() { return true; },
  isReadOnly() { return true; },

  isSearchOrReadCommand() {
    return 'search' as const;
  },

  async prompt() { return DESCRIPTION; },

  async call(input, context) {
    const limit = 50;
    const { pattern, glob, path } = input;

    const contentRegex = contentPattern(pattern);
    const fileRegex = glob ? globToRegex(glob) : null;
    const searchDir = path ?? context.cwd;

    const start = Date.now();
    const matches: Match[] = [];
    const counts = { scanned: 0, skippedFiles: 0 };
    const report = grepProgress(context, pattern, searchDir, matches, counts);
    await report('', true);
    for await (const path of discoverToolFiles(context, input.path, input.includeIgnored)) {
      const file = displaySearchPath(path, searchDir, !!context.vfs, context.cwd);
      if (fileRegex && !matchesSearchGlob(fileRegex, path, searchDir, context.cwd)) continue;
      context.signal?.throwIfAborted();
      await report(file, counts.scanned === 0 && counts.skippedFiles === 0);
      const text = await readCandidate(context, path, counts);
      if (text === null) continue;
      if (text.slice(0, 512).includes('\0')) continue;
      const hadMatches = matches.length > 0;
      await collectMatches(text, file, contentRegex, matches, limit, context.signal);
      await report('', !hadMatches && matches.length > 0);
      if (matches.length >= limit) break;
    }
    await report('', true);
    return { data: { matches, durationMs: Date.now() - start, skippedFiles: counts.skippedFiles,
      numMatches: matches.length, truncated: matches.length >= limit || counts.skippedFiles > 0 } };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = output.matches.length ? output.matches.map((m) => `${m.file}:${m.line}: ${m.content}`) : ['No matches found'];
    if (output.skippedFiles) lines.push(`(Skipped ${output.skippedFiles} files over 2 MiB; search is incomplete.)`);
    if (output.matches.length >= 50) {
      lines.push('(Results truncated. Consider using a more specific search.)');
    }
    return { tool_use_id: toolUseID, type: 'tool_result', content: lines.join('\n') };
  },
} satisfies ToolDef<InputSchema, Output>);

async function collectMatches(text: string, file: string, regex: RegExp, matches: Match[], limit: number, signal?: AbortSignal): Promise<void> {
  let offset = 0, line = 1;
  while (offset <= text.length && matches.length < limit) {
    signal?.throwIfAborted();
    const end = text.indexOf('\n', offset);
    const content = text.slice(offset, end < 0 ? text.length : end);
    if (regex.test(content)) matches.push({ file, line, content });
    if (end < 0) break;
    offset = end + 1;
    // A macrotask lets the webview paint and deliver cancel/timeout events.
    if (line++ % 2048 === 0 && matches.length < limit) await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function contentPattern(pattern: string): RegExp {
  try { return new RegExp(pattern, 'i'); }
  catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

interface SearchCounts { scanned: number; skippedFiles: number }
async function readCandidate(context: ToolUseContext, path: string, counts: SearchCounts): Promise<string | null> {
  try { const text = await readSearchFile(context, path); counts.scanned++; return text; }
  catch (error) {
    if ((error as { code?: string }).code !== 'SEARCH_FILE_TOO_LARGE') throw error;
    counts.skippedFiles++; return null;
  }
}

function grepProgress(context: ToolUseContext, pattern: string, path: string, matches: Match[], counts: SearchCounts) {
  let lastProgress = 0;
  return async (file = '', force = false) => {
    if (!context.onProgress || (!force && Date.now() - lastProgress < 250)) return;
    lastProgress = Date.now();
    await context.onProgress({
      message: `Searching ${JSON.stringify(pattern)} | cwd: ${context.cwd} | path: ${path}\nScanned: ${counts.scanned}; matches: ${matches.length}; skipped (>2 MiB): ${counts.skippedFiles}${file ? `\nReading: ${file}` : ''}`,
      output: matches.map(match => `${match.file}:${match.line}: ${match.content.slice(0, 1000)}`).join('\n').slice(0, 8192),
    });
  };
}
