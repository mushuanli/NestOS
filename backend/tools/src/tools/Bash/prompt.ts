// @file: tools/src/tools/Bash/prompt.ts

export const BASH_TOOL_NAME = 'Bash';

export const DESCRIPTION =
  '- Executes a given bash command and returns its output\n' +
  '- The working directory persists between commands, but shell state does not\n' +
  '- Avoid using this tool to run find, grep, cat, head, tail, sed, or awk commands\n' +
  '- Instead, use the dedicated tools: Glob, Grep, Read, Edit, Write\n' +
  '- Commands touching files outside the working directory need user approval';

export const PROMPT =
  'Bash: Execute shell commands. Use dedicated tools (Read, Write, Edit, Glob, Grep) instead of shell commands for file operations whenever possible.';
