import { spawn, type ChildProcess } from 'node:child_process';
import type { NativeShellResult, NativeShellOptions } from '@itookit/tools';
import { signalProcessGroup, stopProcessGroup } from './process-stop';

interface ProcessOptions extends Omit<NativeShellOptions, 'env'> {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
}

export function runProcess(command: string, args: string[], options: ProcessOptions): Promise<NativeShellResult> {
    if (options.signal?.aborted) return Promise.resolve({ stdout: '', stderr: '', code: null });
    return new Promise(resolve => {
        const child = spawn(command, args, {
            cwd: options.cwd, env: options.env, shell: false,
            detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        });
        new ProcessCompletion(child, options, resolve);
    });
}

/** A one-shot command owns its group through exit, pipe drain and stop confirmation. */
class ProcessCompletion {
    private stdout = '';
    private stderr = '';
    private settled = false;
    private aborting = false;
    private stopping?: Promise<void>;
    private killTimer?: ReturnType<typeof setTimeout>;
    private readonly timer: ReturnType<typeof setTimeout>;

    constructor(private readonly child: ChildProcess, private readonly options: ProcessOptions,
        private readonly resolve: (result: NativeShellResult) => void) {
        for (const stream of ['stdout', 'stderr'] as const) {
            child[stream]!.setEncoding('utf8');
            child[stream]!.on('data', (chunk: string) => {
                const text = chunk.slice(0, Math.max(0, 50_000 - this[stream].length));
                this[stream] += text;
                if (text) options.onOutput?.({ stream, text });
            });
        }
        this.timer = setTimeout(this.abort, options.timeoutMs ?? 120_000);
        options.signal?.addEventListener('abort', this.abort, { once: true });
        child.on('exit', () => { this.stopping ??= stopProcessGroup(child.pid); });
        child.on('close', code => this.finish(code));
        child.on('error', error => { this.stderr = error.message; this.finish(null); });
    }

    private readonly abort = () => {
        if (this.settled || this.aborting) return;
        this.aborting = true;
        try { signalProcessGroup(this.child.pid, 'SIGTERM'); }
        catch (error) { console.error('Process termination request failed', error); }
        this.killTimer = setTimeout(() => { this.stopping ??= stopProcessGroup(this.child.pid); }, 1_000);
    };

    private finish(code: number | null): void {
        if (this.settled) return;
        this.settled = true;
        clearTimeout(this.timer);
        if (this.killTimer) clearTimeout(this.killTimer);
        this.options.signal?.removeEventListener('abort', this.abort);
        void (this.stopping ??= stopProcessGroup(this.child.pid)).then(() => {
            this.resolve({ stdout: this.stdout, stderr: this.stderr, code });
        });
    }
}
