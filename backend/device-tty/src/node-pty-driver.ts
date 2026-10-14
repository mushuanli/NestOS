// @file: device-tty/src/node-pty-driver.ts
//
// Real PTY driver backed by node-pty. Unlike NodeTTYDriver (pipe I/O), this
// connects the child to a pseudoterminal, so isatty() returns true and
// interactive programs (REPLs, vim) behave correctly.
//
// Browser safety: node-pty is pre-loaded via a module-level async IIFE so
// bundlers do not statically resolve the native module. In browser environments
// the import fails and spawn() throws a clear "not available" error.

import { randomUUID } from 'node:crypto';
import type { ITTYDriver, ITTYSession, ITTYSpawnOptions, ITTYSessionEvents } from '@itookit/tools/contracts';
import { safeEnvironment } from './node-tty-driver';

// Pre-load node-pty asynchronously so the synchronous spawn() method can use it.
// undefined = still loading, null = unavailable (browser), function = ready.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _spawnFn: ((...a: any[]) => any) | null | undefined = undefined;
// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async () => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pty = await import('node-pty' as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _spawnFn = (pty as any).spawn ?? (pty as any).default?.spawn;
    } catch {
        _spawnFn = null;
    }
})();

const SIGNAL_NAMES: Record<number, string> = {
    1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL', 15: 'SIGTERM',
};

export class NodePtySession implements ITTYSession {
    readonly id: string;
    readonly command: string;
    readonly pid: number | undefined;

    private _exited = false;
    private _exitCode: number | null = null;
    private carry = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly handlers: Map<string, Set<(...args: any[]) => void>> = new Map();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(private readonly pty: any, command: string, args: string[]) {
        this.id = `tty_${randomUUID()}`;
        this.command = [command, ...args].join(' ');
        this.pid = pty.pid;

        pty.onData((chunk: string) => this.handleData(chunk));
        pty.onExit((exit: { exitCode: number; signal?: number }) => {
            this._exited = true;
            this._exitCode = typeof exit.exitCode === 'number' ? exit.exitCode : null;
            this.emit('exit', this._exitCode, exit.signal ? signalName(exit.signal) : null);
        });
    }

    get exited(): boolean { return this._exited; }
    get exitCode(): number | null { return this._exitCode; }

    write(data: string): void {
        if (this._exited) return;
        this.pty.write(data);
    }

    resize(cols: number, rows: number): void {
        if (this._exited) return;
        this.pty.resize(cols, rows);
    }

    kill(signal = 'SIGTERM'): void {
        if (!this._exited) this.pty.kill(signal);
    }

    on<E extends keyof ITTYSessionEvents>(event: E, handler: ITTYSessionEvents[E]): () => void {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event)!.add(handler);
        return () => this.handlers.get(event)?.delete(handler);
    }

    private handleData(chunk: string): void {
        const normalized = normalizePtyChunk(this.carry, chunk);
        this.carry = normalized.carry;
        this.emit('data', normalized.text);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private emit(event: string, ...args: any[]): void {
        for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
}

export class NodePtyDriver implements ITTYDriver {
    readonly supportsPty = true;

    spawn(command: string, args: string[] = [], options: ITTYSpawnOptions = {}): ITTYSession {
        if (_spawnFn === undefined) {
            throw new Error('NodePtyDriver: node-pty is still loading — call spawn() after a short delay');
        }
        if (_spawnFn === null) {
            throw new Error('NodePtyDriver: node-pty is not available in this environment');
        }
        const pty = _spawnFn(command, args, {
            name: 'xterm-256color',
            cols: options.cols ?? 200,
            rows: options.rows ?? 50,
            cwd: options.cwd ?? process.cwd(),
            env: { ...safeEnvironment(), ...options.env },
        });
        const session = new NodePtySession(pty, command, args);
        if (options.signal) {
            const onAbort = () => session.kill('SIGTERM');
            options.signal.addEventListener('abort', onAbort, { once: true });
            session.on('exit', () => options.signal!.removeEventListener('abort', onAbort));
        }
        return session;
    }
}

function signalName(code: number): string {
    return SIGNAL_NAMES[code] ?? `SIGNAL_${code}`;
}

/**
 * Normalize PTY output (which turns \n into \r\n via ONLCR) back to plain \n,
 * carrying a trailing \r across chunk boundaries so a split \r\n is not
 * emitted as two newlines.
 */
export function normalizePtyChunk(carry: string, chunk: string): { text: string; carry: string } {
    const text = carry + chunk;
    const endsWithCR = text.endsWith('\r');
    const ready = endsWithCR ? text.slice(0, -1) : text;
    return {
        carry: endsWithCR ? '\r' : '',
        text: ready.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    };
}
