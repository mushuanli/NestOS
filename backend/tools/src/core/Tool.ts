// @file: tools/src/core/Tool.ts
// Core Tool interface and buildTool() factory (adapted from Claude Code).
//
// Design principles:
// - buildTool() fills safe defaults so individual tools only declare what they need
// - isConcurrencySafe defaults to false (assume writes)
// - isReadOnly defaults to false (assume modifications)
// - checkPermissions defaults to allow (defer to general permission system)

import type { z } from 'zod/v4';
import type {
  ValidationResult,
  PermissionResult,
  ToolUseContext,
  ToolResult,
  ToolResultBlockParam,
} from './types';

// ── AnyObject helper ──

/** Any Zod object schema (used as a type constraint). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyObject = z.ZodType<{ [key: string]: unknown }>;

// ── Tool interface ──

export interface Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
> {
  /** Unique tool name (e.g. "Bash", "Read"). */
  readonly name: string;

  /** Optional aliases for backwards compatibility when renamed. */
  aliases?: string[];

  /** One-line hint for tool search discovery. 3-10 words, no trailing period. */
  searchHint?: string;

  /** Max result size in characters before truncation. */
  maxResultSizeChars: number;

  // ── Schema ──

  /** Zod input schema (lazy-evaluated). */
  readonly inputSchema: Input;

  /** Optional Zod output schema. */
  outputSchema?: z.ZodType<unknown>;

  // ── Lifecycle ──

  /** Core execution logic. */
  call(args: z.infer<Input>, context: ToolUseContext): Promise<ToolResult<Output>>;

  /** Model-facing description (sent as part of the tool definition). */
  description(): Promise<string>;

  /** Model-facing usage prompt appended to the system message. */
  prompt(): Promise<string>;

  // ── Safety ──

  /** Can this tool run in parallel with other tools? */
  isConcurrencySafe(): boolean;

  /** Does this tool have no side effects? */
  isReadOnly(): boolean;

  /** Is this tool currently enabled? */
  isEnabled(): boolean;

  /** When true, this tool is deferred (sent with defer_loading: true) and requires
   *  ToolSearch to be used before it can be called. */
  readonly shouldDefer?: boolean;

  // ── Interruption ──

  /**
   * What should happen when the user submits a new message while this tool
   * is running.
   *
   * - `'cancel'` — stop the tool and discard its result
   * - `'block'`  — keep running; the new message waits
   *
   * Defaults to `'block'` when not implemented.
   */
  interruptBehavior?(): 'cancel' | 'block';

  // ── UI semantics ──

  /**
   * Returns the UI display category of this tool invocation for collapsing.
   * - `'search'` — grep, find, glob patterns
   * - `'read'`   — cat, head, tail, file read
   * - `'list'`   — ls, tree, du
   * - `'none'`   — not collapsible (side-effecting or unknown)
   *
   * Defaults to `'none'` when not implemented.
   */
  isSearchOrReadCommand?(input: z.infer<Input>): 'search' | 'read' | 'list' | 'none';

  // ── Validation & Permissions ──

  /** Validate input before permission checks. Runs first (cheap checks). */
  validateInput?(input: z.infer<Input>, context: ToolUseContext): Promise<ValidationResult>;

  /** Check whether the user should be prompted for permission. */
  checkPermissions?(input: z.infer<Input>, context: ToolUseContext): Promise<PermissionResult>;

  // ── Display helpers ──

  /** Human-readable name for UI display. */
  userFacingName(input: Partial<z.infer<Input>> | undefined): string;

  /** Short summary for compact views (e.g. "src/foo.ts"). */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null;

  /** Activity description for progress spinners (e.g. "Reading src/foo.ts"). */
  getActivityDescription?(input: Partial<z.infer<Input>> | undefined): string | null;

  // ── Serialization ──

  /** Convert output to the LLM-facing tool_result block. */
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string): ToolResultBlockParam;
}

// ── ToolDef: partial definition accepted by buildTool() ──

type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'interruptBehavior'
  | 'checkPermissions'
  | 'userFacingName';

export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
> = Omit<Tool<Input, Output>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output>, DefaultableToolKeys>>;

// ── Defaults ──

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  interruptBehavior: () => 'block' as const,
  checkPermissions: (): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow' }),
  userFacingName: function (this: { name: string }) {
    return this.name;
  },
};

type ToolDefaults = typeof TOOL_DEFAULTS;

// ── buildTool() ──

type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any>;

/**
 * Build a complete Tool from a partial definition, filling in safe defaults.
 *
 * Defaults (fail-closed):
 * - isEnabled       → true
 * - isConcurrencySafe → false (assume not safe)
 * - isReadOnly      → false (assume writes)
 * - checkPermissions → { behavior: 'allow' }
 * - userFacingName  → tool.name
 */
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>;
}

// ── Tool utilities ──

/** Check if a tool matches the given name (primary or alias). */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false);
}

/** Find a tool by name or alias from a tool collection. */
export function findToolByName<T extends { name: string; aliases?: string[] }>(
  tools: T[],
  name: string,
): T | undefined {
  return tools.find((t) => toolMatchesName(t, name));
}
