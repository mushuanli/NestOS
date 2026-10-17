import { createChatView, type ChatOptions, type ChatMessage, type ConversationActions,
    type InteractionView, type OperationLedger } from '@itookit/llm-ui';
import type { ConversationControls, ConversationSnapshot as NativeSnapshot } from '@itookit/ui-common';
import { t } from '@itookit/common';
import { ChatProjection } from './projection';

export interface NativeChatBindingOptions {
    readonly conversationId: string;
    readonly controls: ConversationControls;
    readonly operations: OperationLedger;
    /** The host maps this stable ID to its durable native request journal. */
    readonly reconcile: NonNullable<ConversationActions['reconcile']>;
    readonly onError?: (error: unknown) => void;
}
/** Native transport/recovery stays in controls; this adapter only projects presentation. */
export async function createNativeChatBinding(options: NativeChatBindingOptions) {
    const source = new ChatProjection(options.conversationId, options.onError);
    let closed = false, generation = 0, native: NativeSnapshot | undefined;
    const requests = new Map<string, { encoded: string; revision: number }>();
    const publish = (state: NativeSnapshot) => {
        if (closed) return;
        native = state;
        source.publish({ title: state.title, messages: state.messages.map(message => nativeMessage(message, options.operations)),
            interactions: state.requests.filter(request => request.kind !== 'unsupported').map(request => interaction(request, requests)),
            loading: false, execution: state.observation?.execution === 'waiting-approval' ? 'waiting-input' : state.observation?.execution ?? 'unknown',
            connection: state.disconnected ? 'offline' : 'online', hasEarlier: state.hasEarlier ?? false,
            allowed: [...(state.canSend && !state.pending ? ['send' as const] : []), ...(state.canRespond ? ['respond' as const] : [])] });
    };
    const refresh = async () => {
        const captured = ++generation, state = await options.controls.read();
        if (captured === generation) publish(state);
    };
    const off = options.controls.subscribe?.(() => {
        ++generation;
        const state = options.controls.snapshot?.();
        if (state) publish(state); else void refresh().catch(error => options.onError?.(error));
    });
    const offLedger = options.operations.subscribe(() => { if (native) publish(native); });
    try { await refresh(); } catch (error) { off?.(); offLedger(); throw error; }
    const valid = (viewId: string) => !closed && viewId === source.getSnapshot().viewId;
    const actions: ConversationActions = {
        async send(input, context) {
            if (!valid(context.viewId)) return { status: 'rejected', operationId: context.operationId, code: 'STALE_VIEW', message: 'Observation binding expired' };
            if (input.attachments.length) return { status: 'rejected', operationId: context.operationId, code: 'ATTACHMENT_MAPPING_REQUIRED', message: 'Native attachments require host conversion' };
            const state = await options.controls.send(input.text); ++generation; publish(state);
            return state.submittedTurnId && !state.pending ? { status: 'accepted', operationId: context.operationId, submissionRef: state.submittedTurnId }
                : { status: 'unknown', operationId: context.operationId, message: 'Awaiting native receipt' };
        },
        async respond(request, context) {
            if (!valid(context.viewId)) return { status: 'rejected', operationId: context.operationId, code: 'STALE_VIEW', message: 'Observation binding expired' };
            await refresh();
            const target = source.getSnapshot().interactions.find(item => item.id === request.id && item.revision === request.revision && item.state === 'pending');
            if (!target) return { status: 'rejected', operationId: context.operationId, code: 'STALE_REQUEST', message: 'Interaction changed or expired' };
            const response = request.response.kind === 'approval' ? { decision: request.response.decisionId }
                : { answers: Object.fromEntries(Object.entries(request.response.values).map(([id, value]) => [id, { answers: Array.isArray(value) ? value : [value] }])) };
            const original = native!.requests.find(item => String(item.id) === request.id)!;
            const state = await options.controls.respond(original.id, response); ++generation; publish(state);
            return { status: 'accepted', operationId: context.operationId };
        },
        async reconcile(operationId) {
            const receipt = await options.reconcile(operationId);
            await refresh(); return receipt;
        },
        loadEarlier: options.controls.loadEarlier ? async ({ signal }) => {
            const state = await options.controls.loadEarlier!();
            if (!signal.aborted && !closed) {
                const latest = options.controls.snapshot?.() ?? native ?? state;
                const ids = new Set(latest.messages.map(message => message.id));
                ++generation; publish({ ...latest, hasEarlier: state.hasEarlier,
                    messages: [...state.messages.filter(message => !ids.has(message.id)), ...latest.messages] });
            }
        } : undefined,
    };
    return { source: Object.assign(source, { refresh }), actions, operations: options.operations,
        dispose() { if (closed) return; closed = true; ++generation; off?.(); offLedger(); } };
}
export function createNativeChatView(container: HTMLElement, binding: Awaited<ReturnType<typeof createNativeChatBinding>>,
    options: Omit<ChatOptions, 'source' | 'actions' | 'operations'> = {}) {
    return createChatView(container, { ...options, source: binding.source, actions: binding.actions, operations: binding.operations });
}
function nativeMessage(message: NativeSnapshot['messages'][number], operations: OperationLedger): ChatMessage {
    const record = operations.getSnapshot().find(item => item.kind === 'send' && item.submissionRef && item.submissionRef === message.turnId);
    return { id: message.id, revision: 0, role: message.role, state: message.status === 'streaming' ? 'streaming' : 'complete',
        submissionId: record?.context.operationId, acceptance: message.id.startsWith('submitted:') ? 'optimistic' : 'confirmed',
        parts: message.role === 'tool' ? [{ id: message.id, kind: 'tool', name: message.name ?? '',
            summary: message.commandPreview ?? message.operation ?? '', state: 'succeeded' }]
            : (message.contentParts ?? [message.text]).map((text, index) => ({ id: `${message.id}-${index}`, kind: 'markdown', text })) };
}
function interaction(request: NativeSnapshot['requests'][number], versions: Map<string, { encoded: string; revision: number }>): InteractionView {
    const id = String(request.id), encoded = JSON.stringify(request), previous = versions.get(id);
    const revision = previous?.encoded === encoded ? previous.revision : (previous?.revision ?? -1) + 1;
    versions.set(id, { encoded, revision });
    const base = { id, revision, title: request.detail, state: 'pending' as const };
    return request.kind === 'approval' ? { ...base, kind: 'approval', decisions: [{ id: 'accept', label: t('harness.approve') }, { id: 'decline', label: t('harness.decline') }] }
        : { ...base, kind: 'input', fields: (request.questions ?? []).map(question => ({ id: question.id, label: question.question, kind: 'text', required: true })) };
}
