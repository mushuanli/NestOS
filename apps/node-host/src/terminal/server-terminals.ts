import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {createModuleLogger} from '@itookit/common';
import {FSError} from '@itookit/vfs-core';
import type {ServerTerminal, ServerTerminals} from '@itookit/app-contracts/services';
import type {IPty} from 'node-pty';

const logger = createModuleLogger('server-terminal');
const BUFFER_LIMIT = 256 * 1024;

/** No command, output, environment value or native error text enters diagnostics. */
export class NodeServerTerminals implements ServerTerminals {
    private readonly sessions = new Set<LiveTerminal>();
    private opening = 0;
    private closed = false;
    async openTerminal(): Promise<ServerTerminal> {
        if (this.closed) throw new FSError('EIO', 'Terminal view is closed');
        if (this.sessions.size + this.opening >= 2) throw new FSError('EBUSY', 'Close an existing server terminal first');
        const id = randomUUID(), started = Date.now(); let stage = 'driver'; this.opening++;
        try {
            if (process.platform === 'win32') throw new FSError('ECAPABILITY', 'Server Bash requires a Unix host');
            const {spawn} = await import('node-pty');
            if (this.closed) throw new FSError('EIO', 'Terminal view is closed');
            stage = 'spawn';
            const pty = spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
                name: 'xterm-256color', cols: 80, rows: 24, cwd: homedir(), env: {...process.env, TERM: 'xterm-256color'},
            });
            const terminal = new LiveTerminal(id, pty, () => this.sessions.delete(terminal));
            this.sessions.add(terminal);
            logger.info('Server terminal opened', {operation: 'open', operationId: id, stage: 'spawn', result: 'success', durationMs: Date.now() - started});
            return terminal;
        } catch (error) {
            const code = error instanceof FSError ? error.code : stage === 'driver' ? 'TERMINAL_DRIVER_UNAVAILABLE' : 'TERMINAL_SPAWN_FAILED';
            logger.error('Server terminal could not open', {operation: 'open', operationId: id, stage, result: 'failure', code, durationMs: Date.now() - started});
            if (error instanceof FSError) throw error;
            throw new FSError('ECAPABILITY', stage === 'driver'
                ? 'Server terminal driver is unavailable; check the node-pty native module'
                : 'Server Bash could not start; check /bin/bash and the service account home directory');
        } finally { this.opening--; }
    }
    async dispose(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.sessions].map(session => session.dispose()));
    }
}

class LiveTerminal implements ServerTerminal {
    private buffer = '';
    private offset = 0;
    private exited = false;
    private exitCode: number | null = null;
    private disposed = false;
    private readonly subscriptions: Array<{dispose(): void}>;
    private readonly started = Date.now();
    private stopped!: () => void;
    private readonly stoppedPromise = new Promise<void>(resolve => { this.stopped = resolve; });
    private closing?: Promise<void>;
    constructor(readonly id: string, private readonly pty: IPty, private readonly release: () => void) {
        this.subscriptions = [pty.onData(data => this.append(data)), pty.onExit(event => {
            this.exited = true; this.exitCode = event.exitCode; this.stopped();
            logger.info('Server terminal exited', {operation: 'exit', operationId: id, stage: 'process', result: event.exitCode === 0 ? 'success' : 'failure', exitCode: event.exitCode, durationMs: Date.now() - this.started});
        })];
    }
    private append(data: string): void {
        this.buffer += data;
        if (this.buffer.length <= BUFFER_LIMIT) return;
        const removed = this.buffer.length - BUFFER_LIMIT;
        this.buffer = this.buffer.slice(removed); this.offset += removed;
    }
    async readOutput(cursor: number) {
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.offset + this.buffer.length)
            throw new FSError('EINVAL', 'Invalid terminal output cursor');
        const start = Math.max(cursor, this.offset), output = this.buffer.slice(start - this.offset, start - this.offset + 32768);
        return {output, cursor: start + output.length, truncated: cursor < this.offset,
            exited: this.exited && start + output.length === this.offset + this.buffer.length, exitCode: this.exitCode};
    }
    async sendInput(data: string): Promise<void> {
        this.requireLive();
        if (typeof data !== 'string' || Buffer.byteLength(data) > 16384) throw new FSError('EINVAL', 'Terminal input exceeds 16 KiB');
        this.perform('write', () => this.pty.write(data));
    }
    async resizeTerminal(cols: number, rows: number): Promise<void> {
        this.requireLive();
        if (![cols, rows].every(value => Number.isInteger(value) && value >= 2 && value <= 500))
            throw new FSError('EINVAL', 'Terminal dimensions must be between 2 and 500');
        this.perform('resize', () => this.pty.resize(cols, rows));
    }
    private perform(operation: string, action: () => void): void {
        const started = Date.now();
        try { action(); }
        catch {
            logger.error('Server terminal operation failed', {operation, operationId: this.id, stage: 'process', result: 'failure', code: 'TERMINAL_IO_FAILED', durationMs: Date.now() - started});
            throw new FSError('EIO', `Server terminal ${operation} failed; close and reopen the terminal`);
        }
    }
    private requireLive(): void {
        if (this.disposed || this.exited) throw new FSError('EIO', 'Server terminal has exited; open a new terminal');
    }
    dispose(): Promise<void> { return this.closing ??= this.close(); }
    private async close(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        let result = 'failure';
        try {
            if (!this.exited) {
                this.perform('close', () => this.pty.kill('SIGHUP'));
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([this.stoppedPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
                clearTimeout(timer);
                if (!this.exited) this.perform('kill', () => this.pty.kill('SIGKILL'));
            }
            result = 'success';
        }
        finally {
            this.subscriptions.forEach(subscription => subscription.dispose()); this.release();
            logger.info('Server terminal closed', {operation: 'close', operationId: this.id, stage: 'cleanup', result, durationMs: Date.now() - this.started});
        }
    }
}
