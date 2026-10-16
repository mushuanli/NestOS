// @file: tools/src/core/types.ts
// Shared types for the tools package.

import type { ToolVFSContext } from '../contracts';

import type { INativeShell } from '../contracts/native-shell';
export type { INativeShell, NativeShellOptions, NativeShellResult } from '../contracts/native-shell';

/**
 * Validation result returned by Tool.validateInput().
 * - result: true → validation passed
 * - result: false → validation failed, message explains why
 */
export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number };

/**
 * Permission decision returned by Tool.checkPermissions().
 */
export interface PermissionResult {
  behavior: 'allow' | 'deny';
  /** Optional reason for denial (shown to the model). */
  reason?: string;
  /** Updated input (e.g. with paths expanded). */
  updatedInput?: Record<string, unknown>;
}

/**
 * Tool execution context passed to Tool.call().
 */
export interface ToolUseContext {
  operationId?: string;
  executionIdentity?: import('../contracts').ToolExecutionIdentity;
  onProgress?: (progress: import('../contracts').ToolProgress) => Promise<void>;
  /** Working directory (real path for Node.js, module path for VFS). */
  cwd: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Maximum execution time in milliseconds. */
  timeoutMs: number;
  /** Virtual filesystem access (browser environments). */
  vfs?: ToolVFSContext;
  /**
   * Native shell for command execution supplied by the owning application.
   * When present, search tools (Grep, Glob) prefer rg/fd over manual FS walking.
   * BashTool uses this to execute commands in Tauri where node:child_process is unavailable.
   *
   * Inject via ToolDeviceDriver.setNativeShell().
   */
  shell?: INativeShell;
  /** Abort controller for programmatic cancellation. */
  abortController?: AbortController;
  /** Optional app state for stateful tools (Task, PlanMode, etc.). */
  appState?: Record<string, unknown>;
  /** Callback to update app state. */
  setAppState?: (key: string, value: unknown) => void;
}

/**
 * Result returned by Tool.call().
 */
export interface ToolResult<T = unknown> {
  data: T;
  /** Optional extra messages injected into the conversation. */
  extraMessages?: Array<{ role: string; content: string }>;
}

/**
 * Block parameter format for tool results (LLM-facing).
 */
export interface ToolResultBlockParam {
  tool_use_id: string;
  type: 'tool_result';
  content: string | Array<{ type: string; text?: string; source?: unknown }>;
}

/**
 * Block parameter format for tool use (LLM-facing).
 */
export interface ToolUseBlockParam {
  id: string;
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}
