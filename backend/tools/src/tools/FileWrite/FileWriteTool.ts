// @file: tools/src/tools/FileWrite/FileWriteTool.ts
// File write tool (create / overwrite).

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { toolFileExists } from '../../core/file-io';
import { FILE_WRITE_TOOL_NAME, DESCRIPTION } from './prompt';

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('Absolute path to the file to write'),
    content: z.string().describe('Content to write to the file'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('Resolved file path'),
    linesWritten: z.number().describe('Number of lines written'),
    fileType: z.enum(['create', 'update']).describe('Whether file was created or updated'),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

// ── Tool ──

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite a file',
  maxResultSizeChars: 100_000,

  async description() { return DESCRIPTION; },

  userFacingName(input) {
    return input?.file_path ? `Write ${input.file_path}` : 'Write';
  },

  getToolUseSummary(input) {
    return input?.file_path ?? null;
  },

  getActivityDescription(input) {
    return input?.file_path ? `Writing ${input.file_path}` : 'Writing file';
  },

  get inputSchema(): InputSchema { return inputSchema(); },
  get outputSchema(): OutputSchema { return outputSchema(); },

  isConcurrencySafe() { return false; },
  isReadOnly() { return false; },

  async prompt() { return DESCRIPTION; },

  async call(input, context) {
    if (!context.vfs) throw new Error('FileWrite requires an application-provided VFS port');
    const exists = await toolFileExists(context.vfs, input.file_path);
    context.signal?.throwIfAborted();
    await context.vfs.writeFile(input.file_path, input.content);
    const output: Output = {
      filePath: input.file_path,
      linesWritten: input.content.split('\n').length,
      fileType: exists ? 'update' : 'create',
    };
    return { data: output };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${output.fileType === 'create' ? 'Created' : 'Updated'} ${output.filePath} (${output.linesWritten} lines)`,
    };
  },
} satisfies ToolDef<InputSchema, Output>);
