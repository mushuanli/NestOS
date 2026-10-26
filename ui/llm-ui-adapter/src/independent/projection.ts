import { createModuleLogger, randomUUID } from '@itookit/common';
import type { ChatMessage, ConversationSnapshot, ConversationSource } from '@itookit/llm-ui';

/** Preserve unchanged message identities while converting mutable domain projections. */
export class ChatProjection implements ConversationSource {
    private readonly listeners = new Set<() => void>();
    private readonly messages = new Map<string, { encoded: string; message: ChatMessage }>();
    private snapshot: ConversationSnapshot;
    constructor(readonly conversationId: string, private readonly report: (error: unknown) => void = () => {}, readonly refresh?: () => Promise<void>) {
        this.snapshot = { conversationId, viewId: randomUUID(), revision: 0, title: '', messages: [], interactions: [],
            loading: true, execution: 'unknown', connection: 'online', hasEarlier: false, allowed: [] };
    }
    getSnapshot(): ConversationSnapshot { return this.snapshot; }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    publish(update: Omit<ConversationSnapshot, 'revision' | 'viewId' | 'conversationId'>): void {
        const messages = update.messages.map(message => this.message(message));
        const ids = new Set(messages.map(message => message.id));
        for (const id of this.messages.keys()) if (!ids.has(id)) this.messages.delete(id);
        this.snapshot = { ...structuredClone({ ...update, messages: [] }), messages,
            conversationId: this.conversationId, viewId: this.snapshot.viewId, revision: this.snapshot.revision + 1 };
        for (const listener of this.listeners) { try { listener(); } catch (error) { this.report(error); } }
    }
    private reportOutcome(message: ChatMessage): void {
        const started = Date.now();
        try {const detail = {operationId: randomUUID(), conversationId: this.conversationId,
            viewId: this.snapshot.viewId, messageId: message.id, stage: 'terminal',
            outcome: message.state, partCount: message.parts.length, durationMs: Date.now() - started};
            const log = createModuleLogger('chat-projection');
            if (message.state === 'failed') log.warn('chat.message.project', detail); else log.info('chat.message.project', detail);}
        catch { /* Diagnostics cannot interrupt authoritative message projection. */ }
    }
    private message(message: ChatMessage): ChatMessage {
        const encoded = JSON.stringify({ ...message, revision: 0 }), previous = this.messages.get(message.id);
        if (previous?.encoded === encoded) return previous.message;
        const next = structuredClone({ ...message, revision: (previous?.message.revision ?? -1) + 1 });
        this.messages.set(message.id, { encoded, message: next });
        if (previous?.message.state !== next.state && ['failed', 'cancelled'].includes(next.state)) this.reportOutcome(next);
        return next;
    }
}
