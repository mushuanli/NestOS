import { randomUUID } from '../src/random';
import { createChatView, createOperationLedger, composeCommandCatalogs, type ChatOptions, type ConversationSnapshot,
    type OperationReceipt } from '../src';

/** A host owns conversation state and the ledger independently of any mounted view. */
export function createMemoryHost() {
    let snapshot: ConversationSnapshot = { conversationId: 'memory-chat', viewId: randomUUID(), revision: 0,
        title: 'Memory chat', loading: false, messages: [], interactions: [], execution: 'idle',
        connection: 'online', hasEarlier: false, allowed: ['send', 'command'],
        commands: composeCommandCatalogs([
            {source: {id: 'view', label: 'View'}, commands: [{id: 'count', revision: 0, name: 'count', description: 'Count messages', kind: 'action'}]},
            {source: {id: 'agent', label: 'Echo'}, commands: [{id: 'echo', revision: 0, name: 'echo', description: 'Echo a prompt', kind: 'prompt', argumentHint: '<text>'}]},
        ]),
        selectors: [{ id: 'assistant', label: 'Assistant', value: 'echo', choices: [{ id: 'echo', label: 'Echo' }] }] };
    const listeners = new Set<() => void>(), receipts = new Map<string, OperationReceipt>();
    const operations = createOperationLedger();
    const publish = (update: Partial<ConversationSnapshot>) => {
        snapshot = { ...snapshot, ...update, revision: snapshot.revision + 1 };
        listeners.forEach(listener => listener());
    };
    const options: ChatOptions = {
        source: { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
        operations,
        actions: {
            async send(input, context) {
                const existing = receipts.get(context.operationId); if (existing) return existing;
                if (context.viewId !== snapshot.viewId) return { status: 'rejected', operationId: context.operationId, code: 'STALE_VIEW', message: 'Binding expired' };
                const receipt = { status: 'accepted' as const, operationId: context.operationId }; receipts.set(context.operationId, receipt);
                publish({ messages: [...snapshot.messages, { id: context.operationId, revision: 0, role: 'user', state: 'complete',
                    submissionId: context.operationId, acceptance: 'confirmed', parts: [{ id: 'body', kind: 'markdown', text: input.text }] },
                    { id: `reply:${context.operationId}`, revision: 0, role: 'assistant', state: 'complete',
                        parts: [{ id: 'body', kind: 'markdown', text: `Echo: ${input.text}` }] }] });
                return receipt;
            },
            async command(input, context) {
                const existing = receipts.get(context.operationId); if (existing) return existing;
                const target = snapshot.commands?.find(command => command.id === input.target.id
                    && command.revision === input.target.expectedRevision && command.kind === input.kind && !command.disabled);
                if (context.viewId !== snapshot.viewId || !target) return {status: 'rejected', operationId: context.operationId, code: 'STALE_COMMAND', message: 'Command unavailable'};
                if (target.source.id === 'agent') return options.actions.send!({text: input.arguments, attachments: [], selection: input.selection}, context);
                const receipt = {status: 'accepted' as const, operationId: context.operationId}; receipts.set(context.operationId, receipt);
                publish({messages: [...snapshot.messages, {id: context.operationId, revision: 0, role: 'system', state: 'complete',
                    parts: [{id: 'body', kind: 'markdown', text: `${snapshot.messages.length} messages`}]}]});
                return receipt;
            },
            async reconcile(operationId) { return receipts.get(operationId) ?? { status: 'unknown', operationId, message: 'No receipt is visible' }; },
        },
        searchResources: async query => [{ id: 'example', label: `Example ${query}`, insertText: '[Example](example.md)' }],
        mountToolbar(container, context) {
            const note = document.createElement('span'); container.append(note);
            const update = ({ snapshot: state }: typeof context) => { note.textContent = `${state.messages.length} messages`; };
            update(context); return { update, destroy() { note.remove(); } };
        },
    };
    return { options, mount: (container: HTMLElement) => createChatView(container, options),
        rebind() { publish({ viewId: randomUUID() }); } };
}
