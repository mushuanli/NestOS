// @file: device-tty/src/session-manager.ts
// TTY session registry — tracks active sessions across tool calls.

import type { ITTYSession, ITTYSessionManager } from '@itookit/tools/contracts';

export class TTYSessionManager implements ITTYSessionManager {
    private sessions = new Map<string, ITTYSession>();

    add(session: ITTYSession): void {
        this.sessions.set(session.id, session);
        // Auto-remove when process exits
        const unsub = session.on('exit', () => {
            this.sessions.delete(session.id);
            unsub();
        });
    }

    get(id: string): ITTYSession | undefined {
        return this.sessions.get(id);
    }

    remove(id: string): void {
        const session = this.sessions.get(id);
        session?.kill();
        this.sessions.delete(id);
    }

    abortAll(): void {
        for (const s of this.sessions.values()) s.kill();
        this.sessions.clear();
    }

    list(): Array<{ id: string; command: string; pid: number | undefined; exited: boolean }> {
        return [...this.sessions.values()].map(s => ({
            id:      s.id,
            command: s.command,
            pid:     s.pid,
            exited:  s.exited,
        }));
    }
}

// ── Shared output collector ───────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_IDLE_MS  = 1_500;

/**
 * Collect output from a TTY session until either:
 *   - The process exits
 *   - No new output for `idleTimeoutMs` ms (process is waiting for input)
 *   - Output exceeds `maxBytes`
 *   - The abort signal fires
 */
export function collectOutput(
    session: ITTYSession,
    options: { idleTimeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<{ output: string; exited: boolean; exitCode: number | null; truncated: boolean }> {
    const idleMs  = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    const maxBytes = options.maxBytes     ?? MAX_OUTPUT_BYTES;

    return new Promise((resolve) => {
        const chunks: string[] = [];
        let totalBytes = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let done = false;
        const unsubs: Array<() => void> = [];

        const finish = (truncated = false) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            for (const u of unsubs) u();
            options.signal?.removeEventListener('abort', onAbort);
            resolve({
                output:   chunks.join(''),
                exited:   session.exited,
                exitCode: session.exitCode,
                truncated,
            });
        };

        const resetIdle = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => finish(), idleMs);
        };

        unsubs.push(session.on('data', (chunk) => {
            chunks.push(chunk);
            totalBytes += chunk.length;
            if (totalBytes >= maxBytes) {
                chunks.push('\n[output truncated]');
                finish(true);
            } else {
                resetIdle();
            }
        }));

        unsubs.push(session.on('exit', () => finish()));
        unsubs.push(session.on('error', (err) => {
            chunks.push(`\n[error: ${err.message}]`);
            finish();
        }));

        const onAbort = () => { session.kill(); finish(); };
        options.signal?.addEventListener('abort', onAbort, { once: true });

        // Start the idle timer
        resetIdle();
    });
}
