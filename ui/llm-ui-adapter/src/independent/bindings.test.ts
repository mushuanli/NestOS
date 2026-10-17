import { expect, it, vi } from 'vitest';
import type { ConversationControls, ConversationSnapshot } from '@itookit/ui-common';
import type { OperationLedger } from '@itookit/llm-ui';
import { createNativeChatBinding } from './native';
import { ChatProjection } from './projection';

vi.mock('@itookit/llm-ui', () => ({ createChatView: vi.fn() }));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function fixture() {
    let state: ConversationSnapshot = { title: 'Native', messages: [], requests: [], canSend: true,
        canInterrupt: false, canRespond: true, pending: false, disconnected: false, gap: false };
    const listeners = new Set<() => void>();
    const read = vi.fn(async () => state), earlier = vi.fn(async () => state);
    const controls = { read, loadEarlier: earlier, snapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as ConversationControls;
    const operations: OperationLedger = { getSnapshot: () => [], subscribe: () => () => {},
        register: async () => {}, settle: async () => {} };
    const reconcile = vi.fn(async (operationId: string) => ({ status: 'unknown' as const, operationId, message: 'Pending journal lookup' }));
    return { read, earlier, controls, listeners, reconcile,
        options: { conversationId: 'native', controls, operations, reconcile },
        state: () => state,
        emit(update: Partial<ConversationSnapshot>) { state = { ...state, ...update }; listeners.forEach(listener => listener()); },
    };
}
it('discards an older refresh result after a newer native update', async () => {
    const host = fixture(), binding = await createNativeChatBinding(host.options), pending = deferred<ConversationSnapshot>();
    host.read.mockReturnValueOnce(pending.promise); const refreshing = binding.source.refresh();
    host.emit({ messages: [{ id: 'm', role: 'assistant', text: 'new output' }] });
    pending.resolve({ ...host.state(), messages: [{ id: 'm', role: 'assistant', text: 'old output' }] }); await refreshing;
    expect(binding.source.getSnapshot().messages[0].parts[0]).toMatchObject({ text: 'new output' }); binding.dispose();
});
it('merges an earlier page into the latest streaming state', async () => {
    const host = fixture(); host.emit({ messages: [{ id: 'm', role: 'assistant', text: 'old' }], hasEarlier: true });
    const binding = await createNativeChatBinding(host.options), pending = deferred<ConversationSnapshot>();
    host.earlier.mockReturnValueOnce(pending.promise);
    const loading = binding.actions.loadEarlier!({ signal: new AbortController().signal });
    host.emit({ messages: [{ id: 'm', role: 'assistant', text: 'new' }, { id: 'next', role: 'user', text: 'next' }] });
    pending.resolve({ ...host.state(), hasEarlier: false, messages: [{ id: 'before', role: 'user', text: 'before' }, { id: 'm', role: 'assistant', text: 'old' }] });
    await loading; const messages = binding.source.getSnapshot().messages;
    expect(messages.map(message => message.id)).toEqual(['before', 'm', 'next']);
    expect(messages[1].parts[0]).toMatchObject({ text: 'new' }); binding.dispose();
});
it('queries the exact host journal operation rather than inferring from the latest turn', async () => {
    const host = fixture(); host.emit({ submittedTurnId: 'unrelated-turn' });
    const binding = await createNativeChatBinding(host.options);
    expect(await binding.actions.reconcile!('original-operation')).toMatchObject({ status: 'unknown' });
    expect(host.reconcile).toHaveBeenCalledWith('original-operation'); binding.dispose();
});
it('rejects an approval removed by another window before submitting its response', async () => {
    const host = fixture(); host.emit({ requests: [{ id: 'approval', kind: 'approval', detail: 'Approve?' }] });
    const binding = await createNativeChatBinding(host.options), request = binding.source.getSnapshot().interactions[0];
    host.emit({ requests: [] });
    const receipt = await binding.actions.respond!({ id: request.id, revision: request.revision,
        response: { kind: 'approval', decisionId: 'accept' } }, { operationId: 'op', viewId: binding.source.getSnapshot().viewId });
    expect(receipt).toMatchObject({ status: 'rejected', code: 'STALE_REQUEST' }); binding.dispose(); expect(host.listeners.size).toBe(0);
});
it('preserves unchanged message identity and advances only changed message revisions', () => {
    const source = new ChatProjection('c'), message = { id: 'm', revision: 0, role: 'assistant' as const,
        state: 'streaming' as const, parts: [{ id: 'text', kind: 'markdown' as const, text: 'first' }] };
    const state = { title: '', messages: [message], interactions: [], loading: false, execution: 'running' as const,
        connection: 'online' as const, hasEarlier: false, allowed: [] };
    source.publish(state); const first = source.getSnapshot().messages[0]; source.publish(state);
    expect(source.getSnapshot().messages[0]).toBe(first);
    source.publish({ ...state, messages: [{ ...message, parts: [{ id: 'text', kind: 'markdown', text: 'second' }] }] });
    expect(first.parts[0]).toMatchObject({ text: 'first' }); expect(source.getSnapshot().messages[0].revision).toBe(first.revision + 1);
});
