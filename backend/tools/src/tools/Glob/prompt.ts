// @file: tools/src/tools/Glob/prompt.ts

export const GLOB_TOOL_NAME = 'Glob';

export const DESCRIPTION =
  '- File pattern matching in the authorized workspace\n' +
  '- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n' +
  '- Returns matching file paths; respects .gitignore and .mindosignore by default. Set includeIgnored to search ignored files.\n' +
  '- Use this tool when you need to find files by name patterns\n' +
  '- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead';

export const PROMPT =
  'Glob: Find files matching a glob pattern. Respects .gitignore and .mindosignore unless includeIgnored is true.';
