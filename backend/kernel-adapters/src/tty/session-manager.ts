import type { ITTYSession, ITTYSessionManager } from '@itookit/tools/contracts';

export class TTYSessionManager implements ITTYSessionManager {
    private readonly sessions = new Map<string, ITTYSession>();

    add(session: ITTYSession): void {
        this.sessions.set(session.id, session);
        const unsubscribe = session.on('exit', () => {
            this.sessions.delete(session.id);
            unsubscribe();
        });
    }

    get(id: string): ITTYSession | undefined {
        return this.sessions.get(id);
    }

    remove(id: string): void {
        this.sessions.get(id)?.kill();
        this.sessions.delete(id);
    }

    abortAll(): void {
        for (const session of this.sessions.values()) session.kill();
        this.sessions.clear();
    }

    list(): ReturnType<ITTYSessionManager['list']> {
        return [...this.sessions.values()].map(session => ({
            id: session.id,
            command: session.command,
            pid: session.pid,
            exited: session.exited,
        }));
    }
}

export interface CollectOutputOptions {
    idleTimeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
}

export interface CollectedOutput {
    output: string;
    exited: boolean;
    exitCode: number | null;
    truncated: boolean;
}

export function collectOutput(
    session: ITTYSession,
    options: CollectOutputOptions = {},
): Promise<CollectedOutput> {
    return new Promise(resolve => collectSessionOutput(session, options, resolve));
}

function collectSessionOutput(
    session: ITTYSession,
    options: CollectOutputOptions,
    resolve: (result: CollectedOutput) => void,
): void {
    const chunks: string[] = [];
    const unsubs: Array<() => void> = [];
    const maxBytes = options.maxBytes ?? 50_000;
    let totalBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (truncated = false): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        unsubs.forEach(unsubscribe => unsubscribe());
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ output: chunks.join(''), exited: session.exited, exitCode: session.exitCode, truncated });
    };
    const resetIdle = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(), options.idleTimeoutMs ?? 1_500);
    };
    const onAbort = (): void => { session.kill(); finish(); };
    unsubs.push(session.on('data', chunk => {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes >= maxBytes) finish(true);
        else resetIdle();
    }));
    unsubs.push(session.on('exit', () => finish()));
    unsubs.push(session.on('error', error => { chunks.push(`\n[error: ${error.message}]`); finish(); }));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else resetIdle();
}
