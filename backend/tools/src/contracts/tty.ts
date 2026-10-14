// Platform-neutral interactive process contracts.
//
// Platform-agnostic TTY abstraction.
//
// Two-level design:
//   ITTYSession — a single live process with bidirectional I/O
//   ITTYDriver  — factory that spawns sessions; different environments inject
//                 different drivers (NodeTTYDriver, BrowserTTYDriver, etc.)
//
// Why not just use child_process directly in tools?
//   1. Platform isolation: browser / Tauri / Node need different implementations
//   2. Session lifecycle: the agent may write to a session across multiple rounds
//   3. Testability: MockTTYDriver injects pre-scripted responses in tests

/** Options passed to ITTYDriver.spawn() */
export interface ITTYSpawnOptions {
    /** Working directory (defaults to agent CWD) */
    cwd?: string;
    /** Extra environment variables merged with process.env */
    env?: Record<string, string>;
    /** Terminal width in columns (default 200) */
    cols?: number;
    /** Terminal height in rows (default 50) */
    rows?: number;
    /** Abort signal — kills the session when aborted */
    signal?: AbortSignal;
}

/** Event map for ITTYSession.on() */
export interface ITTYSessionEvents {
    /** Raw output chunk from stdout/stderr */
    data:  (chunk: string) => void;
    /** Process exited */
    exit:  (code: number | null, signal: string | null) => void;
    /** Spawn or I/O error */
    error: (err: Error) => void;
}

/**
 * A single live process with bidirectional I/O.
 *
 * Lifecycle:
 *   spawn → (data events) → write / resize → exit
 *
 * After exit, write() is a no-op and on('data') receives no more events.
 */
export interface ITTYSession {
    /** Unique session identifier (used by tty_write / tty_close tools) */
    readonly id: string;
    /** The command that was spawned (for display) */
    readonly command: string;
    /** Process ID, if available */
    readonly pid: number | undefined;
    /** True once the process has exited */
    readonly exited: boolean;
    /** Exit code (null if exited via signal) */
    readonly exitCode: number | null;

    /**
     * Write data to the process's stdin.
     * Use '\n' or '\r\n' to simulate Enter.
     */
    write(data: string): void;

    /**
     * Notify the process of a terminal resize.
     * No-op on drivers that don't support PTY.
     */
    resize(cols: number, rows: number): void;

    /** Send a signal to the process (default SIGTERM). */
    kill(signal?: string): void;

    /** Subscribe to a session event. Returns an unsubscriber. */
    on<E extends keyof ITTYSessionEvents>(event: E, handler: ITTYSessionEvents[E]): () => void;
}

/**
 * Platform-specific TTY factory.
 *
 * Implementations:
 *   NodeTTYDriver    — child_process.spawn with pipe I/O  (Node.js / Electron)
 *   NodePtyDriver    — node-pty with real PTY            (upgrade path)
 *   BrowserTTYDriver — WebSocket → remote exec server    (pure browser)
 *   MockTTYDriver    — scripted responses                (testing)
 */
export interface ITTYDriver {
    /**
     * Whether this driver connects stdin to a real pseudoterminal.
     * Programs that call isatty() behave differently if this is false.
     */
    readonly supportsPty: boolean;

    /**
     * Spawn a command and return a session for bidirectional I/O.
     * The session is ready to use immediately — subscribe to 'data' before calling write().
     */
    spawn(command: string, args: string[], options?: ITTYSpawnOptions): ITTYSession;
}

/**
 * Manages all active TTY sessions for the current agent run.
 * Injected into TTY tool handlers via closure.
 */
export interface ITTYSessionManager {
    /** Register a newly spawned session. */
    add(session: ITTYSession): void;
    /** Look up an active session by ID. */
    get(id: string): ITTYSession | undefined;
    /** Kill and remove a session. */
    remove(id: string): void;
    /** Kill all active sessions (called on agent abort). */
    abortAll(): void;
    /** List active sessions for the tty_list tool. */
    list(): Array<{ id: string; command: string; pid: number | undefined; exited: boolean }>;
}

/**
 * Result of waiting for TTY output.
 * Returned by the shell_session and tty_write tools.
 */
export interface TTYOutputResult {
    sessionId: string;
    output: string;
    exited: boolean;
    exitCode: number | null;
    /** True if output was cut short by maxBytes limit */
    truncated: boolean;
}
