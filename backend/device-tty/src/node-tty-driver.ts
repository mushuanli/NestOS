// @file: device-tty/src/node-tty-driver.ts
//
// NodeTTYDriver — spawns child processes with pipe-based bidirectional I/O.
//
// Browser safety: node:child_process is pre-loaded via a module-level async
// IIFE so Vite does not statically bundle it. In browser environments the
// load fails and spawn() throws a clear "not available" error.
//
// Limitations (Phase 1):
//   supportsPty = false → programs that call isatty() may behave differently
//   (e.g., disable color output, use unbuffered mode, etc.)
//
// Upgrade path: replace NodeTTYSession internals with node-pty for a real PTY.
// The ITTYDriver/ITTYSession interface remains unchanged.

import { randomUUID } from 'node:crypto';
import type { ITTYDriver, ITTYSession, ITTYSpawnOptions, ITTYSessionEvents } from '@itookit/tools/contracts';

// Pre-load spawn asynchronously so the synchronous spawn() method can use it.
// undefined = still loading, null = unavailable (browser), function = ready.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _spawnFn: ((...a: any[]) => any) | null | undefined = undefined;
// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async () => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cp = await import('node:child_process' as any);
        _spawnFn = cp.spawn;
    } catch {
        _spawnFn = null;
    }
})();

// ── NodeTTYSession ────────────────────────────────────────────────────────────

export class NodeTTYSession implements ITTYSession {
    readonly id: string;
    readonly command: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly pid: number | undefined;

    private _exited = false;
    private _exitCode: number | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handlers: Map<string, Set<(...args: any[]) => void>> = new Map();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(private readonly proc: any, command: string, args: string[]) {
        this.id      = `tty_${randomUUID()}`;
        this.command = [command, ...args].join(' ');
        this.pid     = proc.pid;

        proc.stdout?.on('data', (chunk: Buffer) => this.emit('data', chunk.toString()));
        proc.stderr?.on('data', (chunk: Buffer) => this.emit('data', chunk.toString()));

        proc.on('close', (code: number | null, signal: string | null) => {
            this._exited   = true;
            this._exitCode = code;
            this.emit('exit', code, signal);
        });

        proc.on('error', (err: Error) => {
            this._exited = true;
            this.emit('error', err);
        });
    }

    get exited():   boolean       { return this._exited; }
    get exitCode(): number | null { return this._exitCode; }

    write(data: string): void {
        if (this._exited || !this.proc.stdin) return;
        this.proc.stdin.write(data);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    resize(_cols: number, _rows: number): void {
        // No-op for pipe-based sessions; node-pty would call ptyProcess.resize()
    }

    kill(signal = 'SIGTERM'): void {
        if (!this._exited) this.proc.kill(signal);
    }

    on<E extends keyof ITTYSessionEvents>(event: E, handler: ITTYSessionEvents[E]): () => void {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event)!.add(handler);
        return () => this.handlers.get(event)?.delete(handler);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private emit(event: string, ...args: any[]): void {
        for (const h of this.handlers.get(event) ?? []) h(...args);
    }
}

// ── NodeTTYDriver ─────────────────────────────────────────────────────────────

/**
 * Node.js TTY driver using child_process.spawn with pipe I/O.
 *
 * Phase 1: stdin/stdout/stderr connected via pipes.
 * Phase 2: replace with node-pty for real PTY emulation.
 */
export class NodeTTYDriver implements ITTYDriver {
    readonly supportsPty = false;

    spawn(command: string, args: string[] = [], options: ITTYSpawnOptions = {}): ITTYSession {
        if (_spawnFn === undefined) {
            throw new Error('NodeTTYDriver: child_process is still loading — call spawn() after a short delay');
        }
        if (_spawnFn === null) {
            throw new Error('NodeTTYDriver: not available in browser environments');
        }

        const proc = _spawnFn(command, args, {
            cwd:   options.cwd ?? process.cwd(),
            env:   { ...safeEnvironment(), ...options.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const session = new NodeTTYSession(proc, command, args);

        if (options.signal) {
            const onAbort = () => session.kill('SIGTERM');
            options.signal.addEventListener('abort', onAbort, { once: true });
            session.on('exit', () => options.signal!.removeEventListener('abort', onAbort));
        }

        return session;
    }
}

/**
 * Drop secret-bearing variables from the inherited process env before handing
 * it to a child shell. TTY sessions run an arbitrary interactive command, so
 * they must never receive the host's API keys/tokens/passwords by default.
 */
export function safeEnvironment(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY)/i.test(key)));
}
