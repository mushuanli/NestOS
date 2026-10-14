// ── Native shell abstraction ──

/**
 * Result of a native command invocation.
 */
export interface NativeShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Abstraction over native command execution (Node.js spawn or Tauri IPC).
 * Injected into ToolUseContext so tools can use rg/fd/sh without knowing
 * the execution environment.
 *
 * Platform applications provide implementations and inject them at assembly time.
 */
export interface NativeShellOptions {
  cwd?: string; timeoutMs?: number; signal?: AbortSignal;
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export interface INativeShell {
  /**
   * Execute a native command and return its output.
   * Implementations are responsible for respecting timeoutMs and signal.
   */
  exec(
    command: string,
    args: string[],
    opts?: NativeShellOptions,
  ): Promise<NativeShellResult>;

  /**
   * Pre-declared capabilities — probed once at construction time.
   * Tools read these to choose their execution path without per-call binary probing.
   */
  capabilities: {
    /** ripgrep (rg) is available */
    ripgrep: boolean;
    /** fd (fd-find) is available */
    fd: boolean;
  };
}
