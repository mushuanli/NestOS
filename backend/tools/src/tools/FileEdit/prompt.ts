// @file: tools/src/tools/FileEdit/prompt.ts

export const FILE_EDIT_TOOL_NAME = 'Edit';

export const DESCRIPTION =
  '- Performs exact string replacements in files\n' +
  '- You must use your Read tool at least once in the conversation before editing\n' +
  '- The edit will FAIL if old_string is not unique in the file\n' +
  '- Use replace_all to replace every instance of old_string\n' +
  '- ALWAYS prefer editing existing files in the codebase';

export const PROMPT =
  'Edit: Perform exact string replacements in existing files. Use for targeted changes without rewriting the entire file.';
