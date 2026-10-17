import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatView, createOperationLedger } from '../src';
import type { ChatOptions, ChatView, ConversationSnapshot, OperationReceipt, OperationRecord } from '../src';

const destroyed = vi.hoisted(() => vi.fn());
vi.mock('@itookit/mdxeditor', () => ({
    AssetResolverPlugin: class {},
    MDxRenderer: class {
        markedExtensions: unknown[] = [];
        usePlugin() { return this; }
        async render(node: HTMLElement, text: string) { node.textContent = text; }
        async renderStreaming(node: HTMLElement, text: string) { node.textContent = text; }
        destroy() { destroyed(); }
    },
    DefaultPrintService: class { async printFromHtml() {} destroy() {} },
}));
const views: ChatView[] = [];
afterEach(async () => { for (const view of views.splice(0)) await view.destroy().catch(() => {}); document.body.replaceChildren(); vi.clearAllMocks(); });
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture(extra: Partial<ChatOptions> = {}) {
    let snapshot: ConversationSnapshot = { conversationId: 'conversation', viewId: 'binding-1', revision: 0, title: 'Chat',
        messages: [], interactions: [], loading: false, execution: 'idle', connection: 'online', hasEarlier: false,
        allowed: ['send', 'edit', 'retry', 'respond', 'cancel'] };
    const listeners = new Set<() => void>();
    const source = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const operations = extra.operations ?? createOperationLedger();
    const host = document.createElement('div'); document.body.append(host);
    const options: ChatOptions = { source, operations, actions: {
        send: async (_input, context) => ({ status: 'accepted', operationId: context.operationId }),
        reconcile: async operationId => ({ status: 'unknown', operationId, message: 'not visible yet' }),
    }, ...extra };
    const open = async (overrides: Partial<ChatOptions> = {}) => { const view = await createChatView(host, { ...options, ...overrides }); views.push(view); return view; };
    const publish = (update: Partial<ConversationSnapshot>) => { snapshot = { ...snapshot, ...update, revision: snapshot.revision + 1 }; listeners.forEach(listener => listener()); };
    return { host, open, publish, options, operations, listeners };
}
function user(submissionId: string, acceptance: 'confirmed' | 'optimistic' = 'confirmed') {
    return { id: 'user-1', revision: 0, role: 'user' as const, state: 'complete' as const, submissionId, acceptance,
        parts: [{ id: 'body', kind: 'markdown' as const, text: 'A' }] };
}

describe('submission acceptance and recovery', () => {
    it('does not revive an observed temporary bubble when its formal message leaves the loaded page', async () => {
        const host = fixture(), first = await host.open(); first.setText('A'); await first.submit();
        const id = host.operations.getSnapshot()[0].context.operationId;
        host.publish({ messages: [user(id)] });
        await vi.waitFor(() => expect(host.operations.getSnapshot()[0].observedUserMessageId).toBe('user-1'));
        await first.destroy(); host.publish({ viewId: 'binding-2', messages: [] });
        await host.open(); expect(host.host.querySelectorAll('[data-role="user"]')).toHaveLength(0);
    });
    it('keeps a temporary bubble after acceptance and replaces only its user message', async () => {
        const host = fixture(), view = await host.open(); view.setText('A'); await view.submit();
        expect(view.getDraft().text).toBe('');
        expect(host.host.querySelectorAll('[data-role="user"]')).toHaveLength(1);
        const id = host.operations.getSnapshot()[0].context.operationId;
        host.publish({ messages: [user(id), { id: 'reply-1', revision: 0, role: 'assistant', state: 'complete', submissionId: id, parts: [] },
            { id: 'reply-2', revision: 0, role: 'assistant', state: 'complete', submissionId: id, parts: [] }] });
        expect(host.host.querySelectorAll('[data-role="user"]')).toHaveLength(1);
        expect(host.host.querySelectorAll('[data-role="assistant"]')).toHaveLength(2);
    });
    it('does not treat an optimistic source message as acceptance', async () => {
        const reply = deferred<OperationReceipt>();
        const host = fixture({ actions: { send: (_input, context) => { host.publish({ messages: [user(context.operationId, 'optimistic')] }); return reply.promise; },
            reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) } });
        const view = await host.open(); view.setText('A'); const sending = view.submit();
        await vi.waitFor(() => expect(host.operations.getSnapshot()).toHaveLength(1));
        const id = host.operations.getSnapshot()[0].context.operationId;
        reply.resolve({ status: 'rejected', operationId: id, code: 'DENIED', message: 'Denied' });
        await expect(sending).rejects.toThrow('Denied'); expect(view.getDraft().text).toBe('A');
    });
    it('does not downgrade authoritative acceptance after a late transport failure', async () => {
        const reply = deferred<OperationReceipt>();
        const host = fixture({ actions: { send: (_input, context) => { host.publish({ messages: [user(context.operationId)] }); return reply.promise; },
            reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) } });
        const view = await host.open(); view.setText('A'); const sending = view.submit();
        await vi.waitFor(() => expect(host.operations.getSnapshot()[0]?.status).toBe('accepted'));
        reply.reject(new Error('Network disconnected')); await sending;
        expect(view.getDraft().text).toBe(''); expect(host.operations.getSnapshot()[0].status).toBe('accepted');
    });
    it('retains unknown operation content across destruction and reconciles without the expired viewId', async () => {
        const send = vi.fn(async (_input, context) => ({ status: 'unknown' as const, operationId: context.operationId, message: '?' }));
        const reconcile = vi.fn(async operationId => ({ status: 'accepted' as const, operationId }));
        const host = fixture({ actions: { send, reconcile } });
        const first = await host.open(); first.setText('A'); await expect(first.submit()).rejects.toThrow();
        const draft = first.getDraft(), id = host.operations.getSnapshot()[0].context.operationId;
        await first.destroy(); host.publish({ viewId: 'binding-2' });
        const second = await host.open({ initialDraft: draft });
        await second.submit(); expect(send).toHaveBeenCalledTimes(1);
        await second.reconcile(id); expect(reconcile).toHaveBeenCalledWith(id); expect(second.getDraft().text).toBe('');
    });
    it('records a send before dispatch and continues settlement after the view is destroyed', async () => {
        const reply = deferred<OperationReceipt>(), send = vi.fn((_input, _context) => reply.promise);
        const host = fixture({ actions: { send, reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) } });
        const view = await host.open(); view.setText('A'); const sending = view.submit();
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        const id = host.operations.getSnapshot()[0].context.operationId;
        await view.destroy(); reply.resolve({ status: 'accepted', operationId: id }); await sending;
        expect(host.operations.getSnapshot()[0].status).toBe('accepted'); expect(host.host.children).toHaveLength(0);
    });
    it('isolates observer exceptions and does not publish an unsaved registration', async () => {
        const saved = deferred<void>(), save = vi.fn(() => saved.promise), operations = createOperationLedger({ save });
        operations.subscribe(() => { throw new Error('observer failed'); });
        const host = fixture({ operations }), view = await host.open(); view.setText('A'); const sending = view.submit();
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce()); expect(operations.getSnapshot()).toHaveLength(0);
        saved.resolve(); await sending; expect(operations.getSnapshot()[0].status).toBe('accepted');
    });
});

describe('draft, attachment and lifecycle races', () => {
    it('clears submitted text when only attachments changed during acceptance', async () => {
        const reply = deferred<OperationReceipt>();
        const host = fixture({ upload: async file => ({ id: file.name, name: file.name }), actions: {
            send: (_input, _context) => reply.promise, reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) } });
        const view = await host.open(); view.setText('A'); await view.addFiles([new File(['x'], 'X')]);
        const sending = view.submit(); await vi.waitFor(() => expect(host.operations.getSnapshot()).toHaveLength(1));
        await view.addFiles([new File(['y'], 'Y')]);
        reply.resolve({ status: 'accepted', operationId: host.operations.getSnapshot()[0].context.operationId }); await sending;
        expect(view.getDraft().text).toBe(''); expect(view.getDraft().attachments.map(item => item.file.name)).toEqual(['Y']);
    });
    it('preserves new text while hidden and applies acceptance before reactivation', async () => {
        const reply = deferred<OperationReceipt>();
        const host = fixture({ actions: { send: (_input, _context) => reply.promise,
            reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) } });
        const view = await host.open(); view.setText('A'); const sending = view.submit();
        await vi.waitFor(() => expect(host.operations.getSnapshot()).toHaveLength(1)); view.setActive(false); view.setText('B');
        reply.resolve({ status: 'accepted', operationId: host.operations.getSnapshot()[0].context.operationId }); await sending;
        expect(view.getDraft().text).toBe('B'); view.setActive(true); expect(view.getDraft().text).toBe('B');
    });
    it('does not restore an upload removed before completion', async () => {
        const result = deferred<{ id: string; name: string }>(), host = fixture({ upload: () => result.promise });
        const view = await host.open(), uploading = view.addFiles([new File(['x'], 'X')]);
        host.host.querySelector<HTMLButtonElement>('[data-upload-id] button')!.click(); result.resolve({ id: 'X', name: 'X' }); await uploading;
        expect(view.getDraft().attachments).toEqual([]);
    });
    it('flushes the latest debounced draft and retries a failed save', async () => {
        const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
        const host = fixture({ saveDraft: save }), view = await host.open(); view.setText('latest');
        await expect(view.flushDraft()).rejects.toThrow('disk full'); await view.flushDraft();
        expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'latest' }));
    });
    it('releases all resources when an extension and a toolbar throw during destruction', async () => {
        const slot = vi.fn(() => { throw new Error('toolbar cleanup'); }), extension = vi.fn(() => { throw new Error('extension cleanup'); });
        const host = fixture({ renderers: { custom: () => ({ destroy: extension }) }, mountToolbar: () => ({ destroy: slot }) });
        const view = await host.open(); host.publish({ messages: [{ id: 'm', role: 'assistant', revision: 0, state: 'complete',
            parts: [{ id: 'md', kind: 'markdown', text: 'content' }, { id: 'ext', kind: 'extension', type: 'custom', data: null }] }] });
        await vi.waitFor(() => expect(host.host.textContent).toContain('content'));
        const disposal = view.destroy(); expect(view.destroy()).toBe(disposal); await expect(disposal).rejects.toBeInstanceOf(AggregateError);
        expect(slot).toHaveBeenCalledOnce(); expect(extension).toHaveBeenCalledOnce(); expect(destroyed).toHaveBeenCalled();
        expect(host.listeners.size).toBe(0); expect(host.host.children).toHaveLength(0);
    });
});

it('uses the revision captured when editing started, even if another window changes the message', async () => {
    const edit = vi.fn(async (_target, _text, context) => ({ status: 'rejected' as const, operationId: context.operationId, code: 'CONFLICT', message: 'Version conflict' }));
    const host = fixture({ actions: { edit, reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) } });
    await host.open(); const message = { ...user('s'), allowed: ['edit' as const], revision: 7 };
    host.publish({ messages: [message] });
    [...host.host.querySelectorAll('button')].find(node => node.textContent === '编辑')!.click();
    host.publish({ messages: [{ ...message, revision: 8 }] });
    const form = host.host.querySelector<HTMLFormElement>('.llm-chat__edit')!;
    form.querySelector('textarea')!.value = 'changed'; form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(edit).toHaveBeenCalled()); expect(edit.mock.calls[0][0]).toEqual({ messageId: 'user-1', expectedRevision: 7 });
    expect(host.host.querySelector('.llm-chat__edit')).not.toBeNull();
});

it('keeps the published ledger version when saving a receipt fails', async () => {
    const initial: OperationRecord = { context: { operationId: 'op', viewId: 'old' }, conversationId: 'c', kind: 'send', input: 'A', status: 'unknown' };
    const ledger = createOperationLedger({ initial: [initial], save: async () => { throw new Error('disk full'); } });
    await expect(ledger.settle({ status: 'accepted', operationId: 'op' })).rejects.toThrow('disk full');
    expect(ledger.getSnapshot()[0].status).toBe('unknown');
});
