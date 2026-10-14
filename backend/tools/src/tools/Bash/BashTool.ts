// @file: tools/src/tools/Bash/BashTool.ts
// Shell command execution tool.
//
// Platform applications inject INativeShell; this package never spawns processes.

import { createToolProgressReporter } from '../../core/progress';
import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { BASH_TOOL_NAME, DESCRIPTION } from './prompt';
import type { INativeShell } from '../../core/types';

const MAX_OUTPUT_CHARS = 50_000;

// Patterns that are unconditionally blocked regardless of execution backend
const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+[/~]/,
  /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&\s*\}/,
  /mkfs\./,
  /dd\s+if=.*of=\/dev\//,
  />(\/dev\/sd|\/dev\/nvme)/,
  /shutdown|halt|reboot|poweroff/,
  /chmod\s+-R\s+777\s+\//,
];

// Search commands for collapsible display (grep, find, etc.)
const BASH_SEARCH_COMMANDS = new Set([
  'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis',
]);

// Read/view commands for collapsible display (cat, head, etc.)
// Data-processing commands (jq, awk, sort, etc.) are intentionally excluded —
// they transform data rather than passively reading, so pipelines containing
// them should not be collapsed as "read" operations.
const BASH_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'wc', 'stat', 'file', 'strings',
]);

// Directory-listing commands for collapsible display (ls, tree, du)
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du']);

// Commands that are semantic-neutral in any position
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set([
  'echo', 'printf', 'true', 'false', ':',
]);

/** Extract the base command name from a pipeline segment. */
function getBaseCommand(segment: string): string {
  const match = segment.trim().match(/^(\S+)/);
  return match ? match[1] : '';
}

/** Check if a bash command is a search or read operation for UI collapsing. */
function isSearchOrReadBashCommand(command: string): 'search' | 'read' | 'list' | 'none' {
  // split() with a capturing group includes the separators as array elements
  const parts = command.split(/\s*(&&|\|\||[|;])\s*/);
  let hasSearch = false;
  let hasRead = false;
  let hasList = false;

  for (const part of parts) {
    if (part === '&&' || part === '||' || part === '|' || part === ';') continue;
    const cmd = getBaseCommand(part);
    if (!cmd || BASH_SEMANTIC_NEUTRAL_COMMANDS.has(cmd)) continue;
    if (BASH_SEARCH_COMMANDS.has(cmd)) { hasSearch = true; continue; }
    if (BASH_READ_COMMANDS.has(cmd)) { hasRead = true; continue; }
    if (BASH_LIST_COMMANDS.has(cmd)) { hasList = true; continue; }
    return 'none'; // non-collapsible command found
  }

  if (hasSearch) return 'search';
  if (hasList) return 'list';
  if (hasRead) return 'read';
  return 'none';
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().describe('The shell command to execute'),
    timeout_ms: z.number().int().positive().max(2_147_483_647).optional().describe('Requested execution time in milliseconds, capped by the host timeout'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    stdout: z.string().describe('Command output (combined stdout and stderr)'),
    exitCode: z.number().nullable().describe('Process exit code'),
    truncated: z.boolean().describe('Whether output was truncated'),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

function isDangerous(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return pattern.source;
  }
  return null;
}

// ── Factory ──

/**
 * Create a Bash tool.
 *
 * @param shell - Optional application-provided native shell. Its exec() receives
 *   ('sh', ['-c', command]) just like the Node.js path.
 *
 * @example (Tauri)
 *   const tauriShell = await TauriNativeShell.create();
 *   const BashTool = createBashTool(tauriShell);
 *   toolDriver.registerToolInstance(BashTool);
 */
export function createBashTool(shell?: INativeShell) {
  return buildTool({
    name: BASH_TOOL_NAME,
    searchHint: 'execute shell commands',
    maxResultSizeChars: MAX_OUTPUT_CHARS,

    async description() { return DESCRIPTION; },

    userFacingName(input) {
      return input?.command ? `$ ${input.command.slice(0, 60)}` : 'Bash';
    },

    getToolUseSummary(input) {
      if (!input?.command) return null;
      const cmd = input.command.trim().split('\n')[0];
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    },

    getActivityDescription(input) {
      return input?.command ? `Running ${input.command.slice(0, 50)}` : 'Running command';
    },

    get inputSchema(): InputSchema { return inputSchema(); },
    get outputSchema(): OutputSchema { return outputSchema(); },

    isConcurrencySafe() { return false; },
    isReadOnly() { return false; },

    isSearchOrReadCommand(input) {
      return isSearchOrReadBashCommand(input.command);
    },

    isEnabled() {
      return Boolean(shell);
    },

    async prompt() { return DESCRIPTION; },

    async validateInput(input) {
      const danger = isDangerous(input.command);
      if (danger) {
        return { result: false, message: `Command blocked by safety filter (pattern: ${danger})`, errorCode: 1 };
      }
      return { result: true };
    },

    async call(input, context) {
      const timeoutMs = Math.min(input.timeout_ms ?? context.timeoutMs, context.timeoutMs);
      const sh = context.shell ?? shell;
      if (!sh) throw new Error('BashTool requires an application-provided native shell');
      const progress = createToolProgressReporter(context.onProgress);
      const message = `$ ${input.command}\ncwd: ${context.cwd}`;
      let preview = '';
      progress.update({ message });
      const result = await sh.exec('sh', ['-c', input.command], {
        cwd: context.cwd, timeoutMs, signal: context.signal,
        onOutput: chunk => {
          preview = (preview + (chunk.stream === 'stderr' ? '[stderr] ' : '') + chunk.text).slice(-8192);
          progress.update({ message, output: preview });
        },
      }).finally(() => progress.finish());
      const combined = result.stdout + (result.stderr ? '\n[stderr]\n' + result.stderr : '');
      const truncated = combined.length > MAX_OUTPUT_CHARS;
      return { data: {
        stdout: truncated ? combined.slice(0, MAX_OUTPUT_CHARS) : combined,
        exitCode: result.code, truncated,
      } };
    },

    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const prefix = output.exitCode === null ? '[timeout]' : `[exit ${output.exitCode}]`;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `${prefix}\n${output.stdout}${output.truncated ? '\n[output truncated]' : ''}`,
      };
    },
  } satisfies ToolDef<InputSchema, Output>);
}

/** Default disabled instance; applications enable Bash by injecting INativeShell. */
export const BashTool = createBashTool();
