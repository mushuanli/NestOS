import { FSError } from '@itookit/vfs-core';
import { SessionCommand } from '@itookit/llm-session/contracts';
import type { ICommandBus, SessionSnapshot, SessionViewPort } from '@itookit/llm-session/contracts';

export interface ConversationClient {
    sessionManager: Pick<SessionViewPort, 'onEvent' | 'onGlobalEvent'> & { getSnapshot(): SessionSnapshot };
    commandBus: ICommandBus;
}

export interface ConversationLease extends ConversationClient { dispose(): Promise<void> }
interface Entry { pending: Promise<ConversationLease>; users: number; touched: number }
interface ContextOptions {
    idleMs?: number;
    maxIdle?: number;
    now?(): number;
    canRelease?(sessionId: string): Promise<boolean>;
}

/** Execution contexts belong to the host, never to a browser connection. */
export class ConversationContexts {
    private readonly contexts = new Map<string, Entry>();
    private closed = false;
    private closing?: Promise<void>;
    private sweeping = Promise.resolve();
    private timer?: ReturnType<typeof setInterval>;
    constructor(private readonly create: () => Promise<ConversationLease>, private readonly canCreate: (id: string) => Promise<boolean> = async () => true,
        private readonly options: ContextOptions = {}) {}
    async open(sessionId: string): Promise<ConversationLease> {
        if (this.closed) return Promise.reject(new FSError('EIO', 'Conversation host is closed'));
        let entry = this.contexts.get(sessionId);
        if (!entry) {
            entry = { pending: this.bind(sessionId), users: 0, touched: this.now() };
            this.contexts.set(sessionId, entry);
        }
        const owned = entry; owned.users++; owned.touched = this.now(); this.startTimer();
        try {
            const context = await owned.pending;
            if (this.closed) throw new FSError('EIO', 'Conversation host is closed');
            let released = false;
            return { sessionManager: context.sessionManager, commandBus: context.commandBus, dispose: async () => {
                if (released) return; released = true; owned.users--; owned.touched = this.now();
                if (!this.closed) void this.collect().catch(error => console.warn('Conversation cleanup deferred', error));
            } };
        } catch (error) { owned.users--; if (this.contexts.get(sessionId) === owned) this.contexts.delete(sessionId); throw error; }
    }
    private async bind(sessionId: string): Promise<ConversationLease> {
        const context = await this.create();
        try {
            const createMissing = await this.canCreate(sessionId);
            await context.commandBus.execute(SessionCommand.Bind, { sessionId, createMissing }); return context;
        } catch (error) { await context.dispose(); throw error; }
    }
    private now(): number { return this.options.now?.() ?? Date.now(); }
    private startTimer(): void {
        this.timer ??= setInterval(() => { void this.collect().catch(error => console.warn('Conversation cleanup deferred', error)); }, 60_000);
    }
    /** Reclaim only unused, idle contexts; live tasks and active browser leases stay owned. */
    collect(): Promise<void> {
        this.sweeping = this.sweeping.catch(() => {}).then(() => this.collectIdle());
        return this.sweeping;
    }
    private async collectIdle(): Promise<void> {
        const idle = [...this.contexts].filter(([, entry]) => entry.users === 0).sort((a, b) => a[1].touched - b[1].touched);
        let excess = idle.length - (this.options.maxIdle ?? 32);
        for (const [id, entry] of idle) {
            if (this.closed) return;
            if (excess <= 0 && this.now() - entry.touched < (this.options.idleMs ?? 300_000)) continue;
            const touched = entry.touched, context = await entry.pending;
            if (this.options.canRelease && !await this.options.canRelease(id)) continue;
            const snapshot = context.sessionManager.getSnapshot();
            if (entry.users || entry.touched !== touched || snapshot.isRunning || snapshot.status === 'queued' || snapshot.status === 'running') continue;
            if (!snapshot.instructionQueue?.paused && snapshot.instructionQueue?.items.length) continue;
            this.contexts.delete(id); excess--;
            await context.dispose();
        }
    }
    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true;
            if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
            const pending = [...this.contexts.values()].map(entry => entry.pending);
            this.closing = (async () => {
                await this.sweeping.catch(() => {});
                const contexts = await Promise.allSettled(pending);
                const disposed = await Promise.allSettled(contexts.map(result => result.status === 'fulfilled' ? result.value.dispose() : undefined));
                this.contexts.clear();
                const errors = disposed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
                if (errors.length) throw new AggregateError(errors, 'Conversation host cleanup failed');
            })();
        }
        return this.closing;
    }
}
