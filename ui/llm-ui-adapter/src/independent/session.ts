import { createChatView, type ChatOptions, type ConversationActions, type MessagePart,
    type OperationContext, type OperationLedger, type OperationReceipt, type SelectorView } from '@itookit/llm-ui';
import { createAgentSendIntent } from '@itookit/llm-flow/contracts';
import { SessionCommand, type ExecutionNode, type ICommandBus, type ISessionRepository,
    type SessionGroup, type SessionViewPort, type Round } from '@itookit/llm-session/contracts';
import { ChatProjection } from './projection';

export interface SessionChatBindingOptions {
    readonly session: SessionViewPort;
    readonly commands: ICommandBus;
    readonly repository: ISessionRepository;
    readonly operations: OperationLedger;
    readonly title?: string;
    readonly selectors?: () => readonly SelectorView[];
    readonly onError?: (error: unknown) => void;
}
/** Hosts own this binding; disposing it releases observation, never the Session or its tasks. */
export function createSessionChatBinding(options: SessionChatBindingOptions) {
    const sessionId = options.session.id, source = new ChatProjection(sessionId, options.onError);
    const branch = options.session.getSnapshot?.().view?.manifest.currentBranch;
    let closed = false;
    const current = () => !closed && options.session.id === sessionId
        && options.session.getSnapshot?.().view?.manifest.currentBranch === branch;
    const publish = () => {
        if (!current()) return;
        source.publish({ title: options.title ?? options.session.getSnapshot?.().view?.manifest.title ?? '',
            messages: options.session.getSessions().map(group => projectGroup(group, options.operations)), interactions: [],
            selectors: options.selectors?.(), loading: false, execution: options.session.isGenerating() ? 'running' : 'idle',
            connection: 'online', hasEarlier: false, allowed: ['send'] });
    };
    const releases = [options.session.onEvent(publish), options.operations.subscribe(publish)]; publish();
    const valid = (context: OperationContext) => current() && context.viewId === source.getSnapshot().viewId;
    const actions: ConversationActions = {
        async send(input, context) {
            if (!valid(context)) return rejected(context, 'STALE_VIEW', 'Observation binding expired');
            const submission = { id: context.operationId, source: { kind: 'conversation', ownerId: sessionId, id: context.operationId } };
            const agentId = input.selection?.agentId ?? 'default';
            await options.commands.execute(SessionCommand.Send, { text: input.text, agentId,
                files: input.attachments.map(file => ({ name: file.name, type: file.mimeType ?? '', path: file.id })),
                sendIntent: { ...createAgentSendIntent(agentId), submission } });
            return { status: 'accepted', operationId: context.operationId };
        },
        async reconcile(operationId) {
            const raw = await options.repository.readDocument(sessionId, `round-${operationId}.json`);
            if (raw) {
                const round = JSON.parse(raw) as Round, manifest = await options.repository.getManifest(sessionId);
                const indexed = manifest.rootRoundId === operationId || Object.values(manifest.branches).includes(operationId)
                    || Object.values(manifest.children).some(ids => ids.includes(operationId));
                if (round.sessionId === sessionId && round.submission?.id === operationId && round.executions.length && indexed)
                    return { status: 'accepted', operationId };
            }
            return { status: 'unknown', operationId, message: 'No committed submission evidence is visible yet' };
        },
    };
    return { source, actions, operations: options.operations, dispose() { if (closed) return; closed = true; releases.forEach(release => release()); } };
}
export async function createSessionChatView(container: HTMLElement, binding: ReturnType<typeof createSessionChatBinding>,
    options: Omit<ChatOptions, 'source' | 'actions' | 'operations'> = {}) {
    return createChatView(container, { ...options, source: binding.source, actions: binding.actions, operations: binding.operations });
}
function rejected(context: OperationContext, code: string, message: string): OperationReceipt {
    return { status: 'rejected', operationId: context.operationId, code, message };
}
function projectGroup(group: SessionGroup, ledger: OperationLedger) {
    const operation = ledger.getSnapshot().find(record => record.kind === 'send' && group.id === `round-${record.context.operationId}-user`);
    const parts: MessagePart[] = group.role === 'user' ? [{ id: 'body', kind: 'markdown', text: group.content ?? '' }]
        : projectNode(group.executionRoot);
    for (const [index, file] of (group.files ?? []).entries()) parts.push({ id: `attachment-${index}`, kind: 'attachment',
        file: { id: file.path ?? file.name, name: file.name, mimeType: file.type } });
    return { id: group.id, revision: 0, role: group.role, parts, timestamp: group.timestamp,
        state: group.executionRoot?.status === 'running' ? 'streaming' as const : 'complete' as const,
        submissionId: operation?.context.operationId,
        acceptance: operation && operation.status !== 'accepted' ? 'optimistic' as const : 'confirmed' as const };
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
