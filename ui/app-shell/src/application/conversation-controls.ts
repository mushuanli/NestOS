import { SessionCommand, type ExecutionNode } from '@itookit/llm-session/contracts';
import type { ConversationControls, ConversationSnapshot, ConversationMessage, ConversationAttachment } from '@itookit/ui-common';
import type { ApplicationPort, ApplicationQueries, ApplicationEvent } from '@itookit/app-contracts/application';
import type { JsonValue } from '@itookit/durable-kernel/contracts';

type View = ApplicationQueries['conversation']['output'];
export interface ApplicationDraft { text: string; pendingRequest?: string }
export interface ApplicationDraftStore { read(id: string): ApplicationDraft | undefined; write(id: string, draft: ApplicationDraft): void }

/** Presentation caches observations; the application port owns execution and persistence. */
export class ApplicationConversationControls implements ConversationControls {
    private view?: View;
    private loading?: Promise<ConversationSnapshot>;
    private dirty = true;
    private closed = false;
    private visible = true;
    private disconnected = false;
    private draft: string;
    private pendingRequest?: string;
    private readonly queued: ApplicationEvent[] = [];
    private readonly listeners = new Set<() => void>();
    private readonly release: () => void;
    constructor(private readonly application: ApplicationPort, private readonly sessionId: string, private readonly drafts?: ApplicationDraftStore) {
        const draft = drafts?.read(sessionId); this.draft = draft?.text ?? ''; this.pendingRequest = draft?.pendingRequest;
        this.release = application.subscribe(event => this.changed(event));
    }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private changed(event: ApplicationEvent): void {
        if (event.kind === 'session' && event.sessionId !== this.sessionId) return;
        if (event.kind === 'invalidate' && (event.scope === 'files' || event.scope === 'configuration')) return;
        if (this.loading) this.queued.push(event); else this.apply(event);
        if (this.visible) for (const listener of this.listeners) listener();
    }
    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible && this.dirty) for (const listener of this.listeners) listener();
    }
    private apply(event: ApplicationEvent): void {
        if (!this.view || event.kind !== 'session') { this.dirty = true; return; }
        if (event.revision <= this.view.revision) return;
        const message = event.event;
        if (message.type === 'message:updated' && !message.payload.metaInfo) {
            const node = this.find(message.payload.messageId);
            if (node) {
                const field = message.payload.field ?? 'output';
                node.data[field] = message.payload.content ?? (node.data[field] ?? '') + (message.payload.delta ?? '');
                this.view.revision = event.revision; return;
            }
        }
        this.dirty = true;
    }
    private find(id: string): ExecutionNode | undefined {
        const search = (node: ExecutionNode): ExecutionNode | undefined => node.id === id ? node : node.children?.map(search).find(Boolean);
        for (const group of this.view?.snapshot.sessions ?? []) if (group.executionRoot) { const node = search(group.executionRoot); if (node) return node; }
        return undefined;
    }
    snapshot(): ConversationSnapshot {
        const view = this.view, requests = view?.interactions.map(({ taskId, request }) => ({ id: `${taskId}:${request.id}`,
            kind: request.kind, detail: request.prompt, questions: questions(request.payload) })) ?? [];
        const active = Boolean(view?.snapshot.isRunning || requests.length);
        return { sessionId: this.sessionId, title: view?.manifest.title ?? '', messages: view ? messages(view.snapshot.sessions) : [],
            createdAt: view?.manifest.createdAt, updatedAt: view?.manifest.updatedAt, draft: this.draft, attachments: [], requests,
            active, canSend: Boolean(!this.disconnected && view?.writable && !active && !this.pendingRequest), canInterrupt: Boolean(!this.disconnected && view?.writable && active),
            canRespond: Boolean(!this.disconnected && view?.writable && requests.length), hasEarlier: Boolean(view?.hasEarlier),
            pending: Boolean(this.pendingRequest), disconnected: this.disconnected, gap: false };
    }
    async read(): Promise<ConversationSnapshot> { if (this.pendingRequest) await this.checkReceipt(); this.dirty = true; return this.poll(); }
    poll(): Promise<ConversationSnapshot> {
        if (this.closed || !this.visible) return Promise.resolve(this.snapshot());
        if (!this.dirty) return Promise.resolve(this.snapshot());
        return this.loading ??= this.application.query('conversation', { sessionId: this.sessionId }).then(view => {
            this.view = view; this.dirty = false; this.disconnected = false;
            for (const event of this.queued.splice(0)) this.apply(event);
            return this.snapshot();
        }).catch(error => { this.disconnected = true; throw error; }).finally(() => { this.loading = undefined; });
    }
    async loadEarlier(): Promise<ConversationSnapshot> {
        if (!this.view?.hasEarlier) return this.snapshot();
        const older = await this.application.query('conversation', { sessionId: this.sessionId, before: this.view.snapshot.sessions[0]?.id });
        this.view.snapshot.sessions.unshift(...older.snapshot.sessions); this.view.hasEarlier = older.hasEarlier; return this.snapshot();
    }
    async send(text: string, attachments: ConversationAttachment[] = []): Promise<ConversationSnapshot> {
        if (attachments.length) throw new Error('Attachments are unavailable');
        if (!this.snapshot().canSend) throw new Error('Conversation is unavailable');
        this.pendingRequest = globalThis.crypto.randomUUID(); this.draft = text; this.persistDraft();
        await this.application.command('conversation', { sessionId: this.sessionId, name: SessionCommand.Send,
            args: { text, agentId: 'default' } }, undefined, this.pendingRequest);
        this.pendingRequest = undefined; this.draft = ''; this.persistDraft(); return this.read();
    }
    async interrupt(): Promise<ConversationSnapshot> {
        await this.application.command('conversation', { sessionId: this.sessionId, name: SessionCommand.Abort });
        for (const taskId of new Set(this.view?.interactions.map(item => item.taskId)))
            await this.application.command('cancelTask', { sessionId: this.sessionId, taskId });
        return this.read();
    }
    async respond(id: string | number, response: Record<string, unknown>): Promise<ConversationSnapshot> {
        const selected = this.view?.interactions.find(item => `${item.taskId}:${item.request.id}` === id);
        if (!selected) throw new Error('Interaction is unavailable');
        const value = selected.request.kind === 'approval' ? { approved: response.decision === 'accept' } : response;
        await this.application.command('respond', { sessionId: this.sessionId, taskId: selected.taskId,
            interactionId: selected.request.id, value: JSON.parse(JSON.stringify(value)) as JsonValue }); return this.read();
    }
    async reconcile(): Promise<ConversationSnapshot> {
        await this.checkReceipt(); this.dirty = true; return this.poll();
    }
    private async checkReceipt(): Promise<void> {
        if (!this.pendingRequest) return;
        const receipt = await this.application.query('receipt', { requestId: this.pendingRequest });
        if (!receipt || receipt.state === 'pending') return;
        this.pendingRequest = undefined;
        if (receipt.state === 'completed') this.draft = '';
        this.persistDraft();
        if (receipt.state === 'failed') throw new Error(receipt.error?.message ?? 'Command failed');
    }
    private persistDraft(): void { this.drafts?.write(this.sessionId, { text: this.draft, pendingRequest: this.pendingRequest }); }
    async saveDraft(text: string): Promise<void> { this.draft = text; this.persistDraft(); }
    async close(): Promise<void> { this.closed = true; this.release(); this.listeners.clear(); }
}
function messages(groups: View['snapshot']['sessions']): ConversationMessage[] {
    const output: ConversationMessage[] = [];
    const visit = (node: ExecutionNode, turnId: string) => {
        const text = node.data.output || node.data.error || (node.data.toolCall?.result === undefined ? '' : JSON.stringify(node.data.toolCall.result));
        if (text) output.push({ id: node.id, turnId, role: node.data.toolCall || node.executorType === 'tool' ? 'tool' : node.messageRole ?? 'assistant',
            text, status: node.status, timestamp: node.startTime, name: node.data.toolCall?.name ?? node.name,
            ...(node.data.toolCall ? { input: JSON.stringify(node.data.toolCall.args), inputLanguage: 'json' as const } : {}) });
        node.children?.forEach(child => visit(child, turnId));
    };
    for (const group of groups) {
        if (group.role === 'user') output.push({ id: group.id, role: 'user', text: group.content ?? '', timestamp: group.timestamp, turnId: group.roundId });
        else if (group.executionRoot) visit(group.executionRoot, group.roundId ?? group.id);
    }
    return output;
}
function questions(value: unknown): Array<{ id: string; question: string; options?: Array<{ label: string }> }> {
    const raw = (value as { questions?: unknown[] } | undefined)?.questions;
    if (!Array.isArray(raw)) return [];
    return raw.map((item, index) => {
        const question = item as { id?: string; question?: string; text?: string; options?: Array<{ label: string }> };
        return { id: question.id ?? String(index), question: question.question ?? question.text ?? '', options: question.options };
    });
}
