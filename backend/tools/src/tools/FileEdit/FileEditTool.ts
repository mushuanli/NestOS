// @file: tools/src/tools/FileEdit/FileEditTool.ts
// String replacement file editing tool (adapted from Claude Code).

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { ToolInputError } from '../../core/tool-error';
import { readToolFile } from '../../core/file-io';
import { FILE_EDIT_TOOL_NAME, DESCRIPTION } from './prompt';

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('Absolute path to the file to modify'),
    old_string: z.string().min(1).describe('The non-empty text to replace'),
    new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
    replace_all: z.boolean().optional().describe('Replace all occurrences of old_string (default false)'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string(),
    replacements: z.number().describe('Number of replacements made'),
    replaceAll: z.boolean(),
    oldString: z.string(),
    newString: z.string(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  searchHint: 'make targeted text replacements in files',
  maxResultSizeChars: 100_000,

  async description() { return DESCRIPTION; },

  userFacingName(input) {
    return input?.file_path ? `Edit ${input.file_path}` : 'Edit';
  },

  getToolUseSummary(input) {
    if (!input?.file_path || !input?.old_string) return null;
    const snippet = input.old_string.slice(0, 40);
    return `${input.file_path}: "${snippet}${input.old_string.length > 40 ? '...' : ''}"`;
  },

  getActivityDescription(input) {
    return input?.file_path ? `Editing ${input.file_path}` : 'Editing file';
  },

  get inputSchema(): InputSchema { return inputSchema(); },
  get outputSchema(): OutputSchema { return outputSchema(); },

  isConcurrencySafe() { return false; },
  isReadOnly() { return false; },

  async prompt() { return DESCRIPTION; },

  async validateInput(input) {
    if (input.old_string === input.new_string) {
      return {
        result: false,
        message: 'old_string and new_string must be different',
        errorCode: 1,
      };
    }
    return { result: true };
  },

  async call(input, context) {
    if (!context.vfs) throw new Error('FileEdit requires an application-provided VFS port');
    const content = await readToolFile(context.vfs, input.file_path);

    const count = content.split(input.old_string).length - 1;
    if (count === 0) {
      throw new ToolInputError('EDIT_NOT_FOUND', `old_string not found in file: ${input.file_path}. Read the file before editing again.`);
    }
    if (!input.replace_all && count > 1) {
      throw new ToolInputError('EDIT_AMBIGUOUS',
        `old_string matches ${count} locations (must be unique). Set replace_all=true to replace all.`,
      );
    }

    const newContent = input.replace_all
      ? content.replaceAll(input.old_string, () => input.new_string)
      : content.replace(input.old_string, () => input.new_string);

    context.signal?.throwIfAborted();
    await context.vfs.writeFile(input.file_path, newContent);

    const replacements = input.replace_all ? count : 1;
    return {
      data: { filePath: input.file_path, replacements, replaceAll: !!input.replace_all,
        oldString: input.old_string, newString: input.new_string },
    };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const plural = output.replacements !== 1 ? 's' : '';
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Made ${output.replacements} replacement${plural} in ${output.filePath}`,
    };
  },
} satisfies ToolDef<InputSchema, Output>);
