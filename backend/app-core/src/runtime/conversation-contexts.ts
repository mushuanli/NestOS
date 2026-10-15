import { FSError } from '@itookit/vfs-core';
import { SessionCommand } from '@itookit/llm-session/contracts';
import type { ICommandBus, SessionSnapshot, SessionViewPort } from '@itookit/llm-session/contracts';

export interface ConversationClient {
    sessionManager: Pick<SessionViewPort, 'onEvent' | 'onGlobalEvent'> & { getSnapshot(): SessionSnapshot };
    commandBus: ICommandBus;
}

interface OwnedConversation extends ConversationClient { dispose(): Promise<void> }

/** Execution contexts belong to the host, never to a browser connection. */
export class ConversationContexts {
    private readonly contexts = new Map<string, Promise<OwnedConversation>>();
    private closed = false;
    private closing?: Promise<void>;
    constructor(private readonly create: () => Promise<OwnedConversation>, private readonly canCreate: (id: string) => Promise<boolean> = async () => true) {}
    open(sessionId: string): Promise<ConversationClient> {
        if (this.closed) return Promise.reject(new FSError('EIO', 'Conversation host is closed'));
        let pending = this.contexts.get(sessionId);
        if (!pending) {
            pending = this.create().then(async context => {
                try {
                    const createMissing = await this.canCreate(sessionId);
                    await context.commandBus.execute(SessionCommand.Bind, { sessionId, createMissing }); return context;
                }
                catch (error) { await context.dispose(); throw error; }
            });
            this.contexts.set(sessionId, pending);
            void pending.catch(() => { if (this.contexts.get(sessionId) === pending) this.contexts.delete(sessionId); });
        }
        return pending;
    }
    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true;
            this.closing = (async () => {
                const contexts = await Promise.allSettled(this.contexts.values());
                const disposed = await Promise.allSettled(contexts.map(result => result.status === 'fulfilled' ? result.value.dispose() : undefined));
                this.contexts.clear();
                const errors = disposed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
                if (errors.length) throw new AggregateError(errors, 'Conversation host cleanup failed');
            })();
        }
        return this.closing;
    }
}
