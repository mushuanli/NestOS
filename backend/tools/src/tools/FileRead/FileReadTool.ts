// @file: tools/src/tools/FileRead/FileReadTool.ts
// File reading tool.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { readToolFile } from '../../core/file-io';
import { FILE_READ_TOOL_NAME, DESCRIPTION } from './prompt';

const MAX_OUTPUT_LINES = 2000;

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('Absolute path to the file to read'),
    offset: z.number().int().positive().optional().describe('Line number to start reading from (1-indexed)'),
    limit: z.number().int().positive().max(MAX_OUTPUT_LINES).optional().describe('Maximum number of lines to read (up to 2000)'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    content: z.string().describe('File content with line numbers'),
    filePath: z.string().describe('Resolved file path'),
    totalLines: z.number().describe('Total number of lines in the file'),
    startLine: z.number().describe('First line number shown'),
    endLine: z.number().describe('Last line number shown'),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

// ── Tool ──

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  searchHint: 'read file contents with line numbers',
  maxResultSizeChars: Infinity,

  async description() { return DESCRIPTION; },

  userFacingName(input) {
    return input?.file_path ? `Read ${input.file_path}` : 'Read';
  },

  getToolUseSummary(input) {
    return input?.file_path ?? null;
  },

  getActivityDescription(input) {
    return input?.file_path ? `Reading ${input.file_path}` : 'Reading file';
  },

  get inputSchema(): InputSchema { return inputSchema(); },
  get outputSchema(): OutputSchema { return outputSchema(); },

  isConcurrencySafe() { return true; },
  isReadOnly() { return true; },

  isSearchOrReadCommand() {
    return 'read' as const;
  },

  async prompt() { return DESCRIPTION; },

  async call(input, context) {
    const offset = input.offset ?? 1;
    const limit = input.limit ?? MAX_OUTPUT_LINES;

    if (!context.vfs) throw new Error('FileRead requires an application-provided VFS port');
    const content = await readToolFile(context.vfs, input.file_path);

    const lines = content.split('\n');
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(lines.length, startIdx + limit);
    const selected = lines.slice(startIdx, endIdx);

    const formatted = selected
      .map((line, i) => `${String(startIdx + i + 1).padStart(6)}\t${line}`)
      .join('\n');

    const totalLines = lines.length;
    const header = `File: ${input.file_path} (lines ${startIdx + 1}-${endIdx} of ${totalLines})`;
    const result = `${header}\n${'─'.repeat(60)}\n${formatted}`;

    const output: Output = {
      content: result,
      filePath: input.file_path,
      totalLines,
      startLine: startIdx + 1,
      endLine: endIdx,
    };
    return { data: output };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.content,
    };
  },
} satisfies ToolDef<InputSchema, Output>);
