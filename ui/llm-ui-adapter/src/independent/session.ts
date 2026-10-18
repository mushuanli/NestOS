import {createImageChatView, type ImageChatOptions} from './image-chat-view';
import type {ImageEditingHost} from './image-editing';
import { type ConversationActions, type MessagePart,
    type OperationContext, type OperationLedger, type OperationReceipt, type SelectorView, type ComposerCommand, type CommandSubmission } from '@itookit/llm-ui';
import { createAgentSendIntent, type SessionSubmission } from '@itookit/llm-flow/contracts';
import { SessionCommand, type ExecutionNode, type ICommandBus,
    type SessionGroup, type SessionViewPort } from '@itookit/llm-session/contracts';
import { ChatProjection } from './projection';

export interface SessionChatBindingOptions {
    readonly images?: ImageEditingHost;
    readonly session: SessionViewPort;
    readonly commands: ICommandBus;
    /** Hosts query committed evidence through the backend's hasCommittedSubmission. */
    readonly hasCommittedSubmission: (submission: SessionSubmission) => Promise<boolean>;
    readonly operations: OperationLedger;
    readonly title?: string;
    readonly selectors?: () => readonly SelectorView[];
    readonly composerCommands?: {
        getSnapshot(): readonly ComposerCommand[];
        execute(input: CommandSubmission, context: OperationContext): Promise<OperationReceipt>;
        reconcile: NonNullable<ConversationActions['reconcile']>;
        subscribe?(listener: () => void): () => void;
    };
    readonly onError?: (error: unknown) => void;
}
/** Hosts own this binding; disposing it releases observation, never the Session or its tasks. */
export function createSessionChatBinding(options: SessionChatBindingOptions) {
    return new SessionChatBinding(options);
}
class SessionChatBinding {
    get images() {return this.options.images;}
    readonly source: ChatProjection;
    readonly actions: ConversationActions;
    readonly operations: OperationLedger;
    private readonly sessionId: string;
    private readonly branch?: string;
    private readonly releases: (() => void)[];
    private readonly confirmed = new Set<string>();
    private readonly checking = new Map<string, Promise<boolean>>();
    private closed = false;
    constructor(private readonly options: SessionChatBindingOptions) {
        this.sessionId = options.session.id;
        this.branch = options.session.getSnapshot?.().view?.manifest.currentBranch;
        this.operations = options.operations;
        this.source = new ChatProjection(this.sessionId, options.onError);
        this.actions = { send: (input, context) => this.send(input, context), reconcile: id => this.reconcile(id) };
        if (options.composerCommands) this.actions.command = (input, context) => this.command(input, context);
        this.releases = [options.session.onEvent(() => this.publish()), options.operations.subscribe(() => this.publish())];
        if (options.composerCommands?.subscribe) this.releases.push(options.composerCommands.subscribe(() => this.publish()));
        this.publish();
    }
    private current(): boolean {
        return !this.closed && this.options.session.id === this.sessionId
            && this.options.session.getSnapshot?.().view?.manifest.currentBranch === this.branch;
    }
    private publish(): void {
        if (!this.current()) return;
        const messages = this.options.session.getSessions().map(group => projectGroup(group, this.operations, this.confirmed, this.sessionId));
        this.source.publish({ title: this.options.title ?? this.options.session.getSnapshot?.().view?.manifest.title ?? '',
            messages, interactions: [], selectors: this.options.selectors?.(), commands: this.options.composerCommands?.getSnapshot(), loading: false,
            execution: this.options.session.isGenerating() ? 'running' : 'idle', connection: 'online', hasEarlier: false,
            allowed: ['send', ...(this.options.composerCommands ? ['command' as const] : [])] });
        for (const message of messages) if (message.submissionId && !this.confirmed.has(message.submissionId)) {
            void this.check(message.submissionId).then(accepted => { if (accepted) this.publish(); }).catch(error => this.options.onError?.(error));
        }
    }
    private submission(operationId: string): SessionSubmission {
        return { id: operationId, source: { kind: 'conversation', ownerId: this.sessionId, id: operationId } };
    }
    private check(operationId: string): Promise<boolean> {
        if (this.confirmed.has(operationId)) return Promise.resolve(true);
        const previous = this.checking.get(operationId);
        if (previous) return previous;
        const pending = Promise.resolve().then(() => this.options.hasCommittedSubmission(this.submission(operationId)))
            .then(accepted => { if (accepted) this.confirmed.add(operationId); return accepted; })
            .finally(() => this.checking.delete(operationId));
        this.checking.set(operationId, pending); return pending;
    }
    private async send(input: Parameters<NonNullable<ConversationActions['send']>>[0], context: OperationContext): Promise<OperationReceipt> {
        if (!this.current() || context.viewId !== this.source.getSnapshot().viewId)
            return rejected(context, 'STALE_VIEW', 'Observation binding expired');
        const agentId = input.selection?.agentId ?? 'default';
        await this.options.commands.execute(SessionCommand.Send, { text: input.text, agentId,
            files: input.attachments.map(file => ({ name: file.name, type: file.mimeType ?? '', path: file.id })),
            sendIntent: { ...createAgentSendIntent(agentId), submission: this.submission(context.operationId) } });
        return this.reconcile(context.operationId);
    }
    private command(input: CommandSubmission, context: OperationContext): Promise<OperationReceipt> {
        if (!this.current() || context.viewId !== this.source.getSnapshot().viewId)
            return Promise.resolve(rejected(context, 'STALE_VIEW', 'Observation binding expired'));
        const target = this.options.composerCommands?.getSnapshot().find(command => command.id === input.target.id
            && command.revision === input.target.expectedRevision && command.kind === input.kind && !command.disabled);
        return target ? this.options.composerCommands!.execute(input, context)
            : Promise.resolve(rejected(context, 'STALE_COMMAND', 'Command changed or is unavailable'));
    }
    private async reconcile(operationId: string): Promise<OperationReceipt> {
        if (this.operations.getSnapshot().some(record => record.context.operationId === operationId && record.kind === 'command') && this.options.composerCommands)
            return this.options.composerCommands.reconcile(operationId);
        if (await this.check(operationId)) {
            this.publish(); return { status: 'accepted', operationId };
        }
        return { status: 'unknown', operationId, message: 'No committed submission evidence is visible yet' };
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true; this.releases.forEach(release => release());
    }
}
export async function createSessionChatView(container: HTMLElement, binding: ReturnType<typeof createSessionChatBinding>,
    options: ImageChatOptions = {}) {
    return createImageChatView(container, {...options, source: binding.source, actions: binding.actions, operations: binding.operations}, options.images ?? binding.images);
}
function rejected(context: OperationContext, code: string, message: string): OperationReceipt {
    return { status: 'rejected', operationId: context.operationId, code, message };
}
function projectGroup(group: SessionGroup, ledger: OperationLedger, confirmed: ReadonlySet<string>, sessionId: string) {
    const operation = ledger.getSnapshot().find(record => (record.kind === 'send' || record.kind === 'command') && record.conversationId === sessionId
        && group.id === `round-${record.context.operationId}-user`);
    const parts: MessagePart[] = group.role === 'user' ? [{ id: 'body', kind: 'markdown', text: group.content ?? '' }]
        : projectNode(group.executionRoot);
    for (const [index, file] of (group.files ?? []).entries()) parts.push({ id: `attachment-${index}`, kind: 'attachment',
        file: { id: file.path ?? file.name, name: file.name, mimeType: file.type } });
    return { id: group.id, revision: 0, role: group.role, parts, timestamp: group.timestamp,
        state: group.executionRoot?.status === 'running' ? 'streaming' as const : 'complete' as const,
        submissionId: operation?.context.operationId,
        acceptance: operation && !confirmed.has(operation.context.operationId) ? 'optimistic' as const : 'confirmed' as const };
}
function projectNode(node?: ExecutionNode): MessagePart[] {
    if (!node) return [];
    const parts: MessagePart[] = [];
    if (node.executorType === 'tool') parts.push({ id: node.id, kind: 'tool', name: node.name,
        summary: node.data.toolCall?.name ?? node.name, detail: node.data.error ?? node.data.output,
        state: node.status === 'running' ? 'running' : node.status === 'failed' ? 'failed' : 'succeeded' });
    else {
        if (node.data.thought) parts.push({ id: `${node.id}-thought`, kind: 'reasoning', text: node.data.thought });
        if (node.data.output) parts.push({ id: node.id, kind: 'markdown', text: node.data.output });
    }
    return [...parts, ...(node.children ?? []).flatMap(projectNode)];
}
