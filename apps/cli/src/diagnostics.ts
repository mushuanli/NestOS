import { appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { errorDetails } from '@itookit/common';

const MAX_BYTES = 4 * 1024 * 1024;
let active: RuntimeDiagnostics | undefined;

/** Small synchronous writes also survive fatal exceptions and process.exit(). */
export class RuntimeDiagnostics {
    readonly file: string;
    private bytes = 0;
    private failed = false;

    constructor(directory: string, mode = 'cli-local') {
        this.file = path.join(directory, `${mode}-${Date.now()}-${process.pid}.jsonl`);
        try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
        catch (error) { this.fail(error); }
    }

    record(event: string, value?: unknown): void {
        if (this.failed) return;
        try {
            const message = value instanceof Error ? `${errorDetails(value)}\n${value.stack ?? ''}` : errorDetails(value ?? '');
            const line = JSON.stringify({ timeMs: Date.now(), pid: process.pid, event: event.slice(0, 80),
                detail: { message: message.slice(0, 4000) } }) + '\n';
            if (this.bytes + Buffer.byteLength(line) > MAX_BYTES) {
                renameSync(this.file, this.file.replace(/\.jsonl$/, '.previous.jsonl'));
                this.bytes = 0;
            }
            appendFileSync(this.file, line, { mode: 0o600 });
            this.bytes += Buffer.byteLength(line);
        } catch (error) { this.fail(error); }
    }

    private fail(error: unknown): void {
        this.failed = true;
        process.stderr.write(`[Diagnostics] 无法写入 ${this.file}: ${String(error)}\n`);
    }
}

export function recordRuntimeDiagnostic(event: string, value?: unknown): void {
    active?.record(event, value);
}

export function runtimeDiagnosticPath(): string | undefined { return active?.file; }

export function installRuntimeDiagnostics(mode: 'cli-local' | 'cli-remote' | 'httpd-cli' = 'cli-local'): { file: string; dispose(): void } {
    const base = process.env.MINDOS_DIAGNOSTICS_DIR ?? path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'mindos', 'logs', 'cli');
    const log = new RuntimeDiagnostics(base, mode); active = log;
    const fatal = (error: Error, origin: string) => {
        log.record(`process.${origin}`, error);
        process.stderr.write(`[Diagnostics] ${log.file}\n`);
    };
    const warning = (error: Error) => log.record('process.warning', error);
    const exit = (code: number) => log.record('process.exit', { code });
    process.on('uncaughtExceptionMonitor', fatal);
    process.on('warning', warning);
    process.on('exit', exit);
    log.record('process.start', { cwd: process.cwd(), node: process.version });
    return { file: log.file, dispose() {
        process.off('uncaughtExceptionMonitor', fatal); process.off('warning', warning); process.off('exit', exit);
        if (active === log) active = undefined;
    } };
}

export async function traceRuntimeStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    recordRuntimeDiagnostic(`${stage}.start`);
    try {
        const result = await operation();
        recordRuntimeDiagnostic(`${stage}.ready`, { durationMs: Math.round(performance.now() - started) });
        return result;
    } catch (error) {
        recordRuntimeDiagnostic(`${stage}.failed`, error);
        throw error;
    }
}
