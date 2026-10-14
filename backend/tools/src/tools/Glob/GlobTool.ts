// @file: tools/src/tools/Glob/GlobTool.ts
// Glob file pattern matching tool.
//
// Shared discovery rules apply to both authorized VFS and standalone Node searches.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { GLOB_TOOL_NAME, DESCRIPTION } from './prompt';
import { globToRegex } from '../../core/globToRegex';
import { discoverToolFiles, displaySearchPath, matchesSearchGlob } from '../../core/file-discovery';

const inputSchema = lazySchema(() =>
  z.strictObject({
    includeIgnored: z.boolean().optional().describe('Include files excluded by .gitignore, .mindosignore and default directory filters. Does not change access permissions.'),
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe(
        'The directory to search in. If not specified, the current working directory will be used.',
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    filenames: z.array(z.string()).describe('Array of file paths matching the pattern'),
    durationMs: z.number().describe('Time taken to execute the search in milliseconds'),
    numFiles: z.number().describe('Total number of files found'),
    truncated: z.boolean().describe('Whether results were truncated'),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

// ── Tool ──

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  searchHint: 'find files by name pattern or wildcard',
  maxResultSizeChars: 100_000,

  async description() { return DESCRIPTION; },

  userFacingName(input) {
    return input?.pattern ? `Glob "${input.pattern}"` : 'Glob';
  },

  getToolUseSummary(input) {
    return input?.pattern ? `"${input.pattern}"` : null;
  },

  getActivityDescription(input) {
    const p = input?.pattern;
    return p ? `Finding ${p}` : 'Finding files';
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
    const start = Date.now();
    const regex = globToRegex(input.pattern);
    const filenames: string[] = [];
    for await (const path of discoverToolFiles(context, input.path, input.includeIgnored)) {
      const root = input.path ?? context.cwd;
      const display = displaySearchPath(path, root, !!context.vfs, context.cwd);
      if (matchesSearchGlob(regex, path, root, context.cwd)) filenames.push(display);
      if (filenames.length >= 100) break;
    }
    return { data: { filenames, durationMs: Date.now() - start,
      numFiles: filenames.length, truncated: filenames.length >= 100 } };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.filenames.length === 0) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: 'No files found' };
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        ...output.filenames,
        ...(output.truncated
          ? ['(Results are truncated. Consider using a more specific path or pattern.)']
          : []),
      ].join('\n'),
    };
  },
} satisfies ToolDef<InputSchema, Output>);
