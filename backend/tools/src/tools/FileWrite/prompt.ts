// @file: tools/src/tools/FileWrite/prompt.ts

export const FILE_WRITE_TOOL_NAME = 'Write';

export const DESCRIPTION =
  '- Writes a file to the local filesystem\n' +
  '- This tool will overwrite the existing file if there is one at the provided path\n' +
  '- If this is an existing file, you MUST use the Read tool first to read the file contents\n' +
  '- ALWAYS prefer editing existing files using the Edit tool in the codebase';

export const PROMPT =
  'Write: Create or overwrite a file. Use Edit for targeted string replacements in existing files.';
