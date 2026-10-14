// @file: tools/src/tools/FileRead/prompt.ts

export const FILE_READ_TOOL_NAME = 'Read';

export const DESCRIPTION =
  '- Reads a file from the local filesystem\n' +
  '- You can access any file directly by using this tool\n' +
  '- You can optionally specify an offset and limit (especially handy for long files)\n' +
  '- Results are returned using cat -n format, with line numbers starting at 1\n' +
  '- This tool can read images (PNG, JPG, etc.) and PDFs';

export const PROMPT =
  'Read: Read the contents of a file. Returns file content with line numbers. Use offset/limit for large files.';
