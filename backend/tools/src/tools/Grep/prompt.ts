// @file: tools/src/tools/Grep/prompt.ts

export const GREP_TOOL_NAME = 'Grep';

export const DESCRIPTION =
  '- Content search in the authorized workspace\n' +
  '- Search for a regex pattern in file contents\n' +
  '- Returns matches in "path:line:content" format\n' +
  '- Supports file glob filtering, case-insensitive search\n' +
  '- Skips binary files and files over 2 MiB (reported as an incomplete search). Streams bounded progress and match previews.\n' +
  '- Respects .gitignore and .mindosignore by default. Set includeIgnored to search ignored files; read size limits still apply.';

export const PROMPT =
  'Grep: Search file contents with regular expressions. Use this instead of terminal grep/rg. Supports glob filtering, case-insensitive matching.';
