import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatView, createOperationLedger, composeCommandCatalogs } from '../src';
import type { ChatOptions, ChatView, ConversationSnapshot, OperationReceipt, OperationRecord } from '../src';

const destroyed = vi.hoisted(() => vi.fn());
vi.mock('@itookit/mdxeditor', async importOriginal => ({
    ...await importOriginal<typeof import('@itookit/mdxeditor')>(),
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

describe('composer command capabilities', () => {
    const catalogs = () => composeCommandCatalogs(['ui', 'harness'].map(id => ({source: {id, label: id}, commands: [
        {id: 'compact', revision: 1, name: 'compact', description: id + ' compact', kind: 'action' as const},
    ]})));
    it('preserves both sources, requires disambiguation and never executes completion', async () => {
        const command = vi.fn(async (_input, context) => ({status: 'accepted' as const, operationId: context.operationId}));
        const send = vi.fn();
        const host = fixture({actions: {send, command, reconcile: async operationId => ({status: 'unknown', operationId, message: 'unknown'})}});
        host.publish({commands: catalogs(), allowed: ['send', 'command']}); const view = await host.open();
        view.setText('/compact');
        expect(host.host.querySelectorAll('.llm-chat__commands button')).toHaveLength(2);
        await expect(view.submit()).rejects.toThrow('同名');
        expect(command).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
        const choice = [...host.host.querySelectorAll<HTMLButtonElement>('.llm-chat__commands button')].find(row => row.textContent?.includes('harness'))!;
        choice.click(); expect(command).not.toHaveBeenCalled(); expect(view.getDraft().text).toBe('/compact ');
        await view.submit();
        expect(command.mock.calls[0][0]).toMatchObject({target: {id: JSON.stringify(['harness', 'compact']), expectedRevision: 1}, kind: 'action'});
        expect(view.getDraft().text).toBe(''); expect(host.host.querySelectorAll('[data-message-id]')).toHaveLength(0);
        view.setText('/missing'); await expect(view.submit()).rejects.toThrow('不可用'); expect(send).not.toHaveBeenCalled();
    });
    it('rejects a selected command whose revision changed before submission', async () => {
        const command = vi.fn(), host = fixture({actions: {command, reconcile: vi.fn()}});
        host.publish({commands: catalogs().slice(0, 1), allowed: ['command']}); const view = await host.open();
        view.setText('/com'); host.host.querySelector<HTMLButtonElement>('.llm-chat__commands button')!.click();
        host.publish({commands: [{...catalogs()[0], revision: 2}]});
        await expect(view.submit()).rejects.toThrow('不可用'); expect(command).not.toHaveBeenCalled();
        expect(view.getDraft().text).toBe('/compact ');
    });
    it('uses Enter to complete a command without executing it and closes the menu when hidden', async () => {
        const command = vi.fn(), host = fixture({actions: {command, reconcile: vi.fn()}});
        host.publish({commands: catalogs().slice(0, 1), allowed: ['command']}); const view = await host.open();
        view.setText('/com'); host.host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
        expect(command).not.toHaveBeenCalled(); expect(view.getDraft().text).toBe('/compact ');
        view.setText('/com'); view.setActive(false);
        expect(host.host.querySelector<HTMLElement>('.llm-chat__commands')!.hidden).toBe(true);
    });
    it('retains an unknown command and never falls through to a model send or automatic replay', async () => {
        const command = vi.fn(async (_input, context) => ({status: 'unknown' as const, operationId: context.operationId, message: 'unknown'})), send = vi.fn();
        const host = fixture({actions: {command, send, reconcile: vi.fn()}});
        host.publish({commands: catalogs().slice(0, 1), allowed: ['send', 'command']}); const view = await host.open();
        view.setText('/compact'); await expect(view.submit()).rejects.toThrow('unknown');
        view.setText('/compact '); await expect(view.submit()).rejects.toThrow('awaiting reconciliation');
        expect(command).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled(); expect(view.getDraft().text).toBe('/compact ');
    });
});

it('scopes dependent reasoning choices to the selected model and removes obsolete selector values', async () => {
    const send = vi.fn(async (_input, context) => ({status: 'accepted' as const, operationId: context.operationId}));
    const host = fixture({actions: {send, reconcile: vi.fn()}});
    host.publish({selectors: [
        {id: 'modelId', label: 'Model', value: 'thinking', choices: [{id: 'thinking', label: 'Thinking'}, {id: 'plain', label: 'Plain'}]},
        {id: 'effort', label: 'Effort', value: '', choices: [{id: '', label: 'Default'}], variants: {selectorId: 'modelId', values: {
            thinking: {value: 'high', choices: [{id: 'high', label: 'High'}]}, plain: {value: '', choices: [{id: '', label: 'Default'}]},
        }}},
    ]});
    const view = await host.open();
    const parent = host.host.querySelector<HTMLSelectElement>('[data-selector-id="modelId"]')!;
    host.publish({execution: 'running'});
    expect(host.host.querySelector('[data-selector-id="modelId"]')).toBe(parent);
    parent.value = 'plain'; parent.dispatchEvent(new Event('change'));
    expect(host.host.querySelector<HTMLSelectElement>('[data-selector-id="effort"]')!.value).toBe('');
    host.publish({selectors: host.options.source.getSnapshot().selectors!.slice(0, 1)});
    view.setText('Prompt'); await view.submit();
    expect(send.mock.calls[0][0].selection).toEqual({modelId: 'plain'});
});

describe('conversation content search integration', () => {
    it('offers a header button and refreshes matches after streaming and earlier history load', async () => {
        const host = fixture(), view = await host.open();
        const message = { ...user('s'), state: 'streaming' as const, parts: [{ id: 'body', kind: 'markdown' as const, text: 'needle' }] };
        host.publish({ messages: [message] });
        await vi.waitFor(() => expect(host.host.querySelector('.llm-chat__body')!.textContent).toBe('needle'));
        [...host.host.querySelectorAll('.llm-chat__header button')].find(button => button.textContent === '搜索内容')!.click();
        const input = host.host.querySelector<HTMLInputElement>('.llm-chat__search-input')!;
        input.value = 'needle'; input.dispatchEvent(new Event('input', { bubbles: true }));
        const status = () => host.host.querySelector('.llm-chat__search-status')!.textContent;
        expect(status()).toBe('1 / 1');
        const row = host.host.querySelector('[data-message-id="user-1"]');
        host.publish({ messages: [{ ...message, revision: 1, parts: [{ ...message.parts[0], text: 'needle needle' }] }] });
        await vi.waitFor(() => expect(status()).toBe('1 / 2'));
        expect(host.host.querySelector('[data-message-id="user-1"]')).toBe(row);
        const latest = host.options.source.getSnapshot().messages[0];
        host.publish({ messages: [{ ...message, id: 'earlier' }, latest] });
        await vi.waitFor(() => expect(status()).toBe('2 / 3'));
        view.setActive(false); host.publish({ messages: [] }); expect(status()).toBe('2 / 3');
        view.setActive(true); await vi.waitFor(() => expect(status()).toBe('无匹配结果'));
    });
    it('leaves custom renderer content and composer drafts outside search', async () => {
        const host = fixture({ renderers: { custom: container => { container.textContent = 'private needle'; return { destroy() {} }; } } });
        const view = await host.open(); view.setText('draft needle');
        host.publish({ messages: [{ ...user('s'), parts: [{ id: 'ext', kind: 'extension', type: 'custom', data: null }] }] });
        await vi.waitFor(() => expect(host.host.querySelector('[data-search-exclude]')?.textContent).toBe('private needle'));
        [...host.host.querySelectorAll('button')].find(button => button.textContent === '搜索内容')!.click();
        const input = host.host.querySelector<HTMLInputElement>('.llm-chat__search-input')!;
        input.value = 'needle'; input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(host.host.querySelector('.llm-chat__search-status')!.textContent).toBe('无匹配结果');
        expect(host.host.querySelector('mark.llm-chat__search-match')).toBeNull(); expect(view.getDraft().text).toBe('draft needle');
    });
});

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

it('blocks another regeneration until an unknown operation is reconciled, including after reopening', async () => {
    const retry = vi.fn(async (_target, context) => ({ status: 'unknown' as const, operationId: context.operationId, message: 'Receipt lost' }));
    const host = fixture({ actions: { retry, reconcile: async operationId => ({ status: 'rejected', operationId, code: 'NOT_STARTED', message: 'Not started' }) } });
    const first = await host.open(); host.publish({ messages: [{ ...user('s'), allowed: ['retry'] }] });
    const click = () => [...host.host.querySelectorAll('button')].find(button => button.textContent === '重新生成')!.click();
    click(); await vi.waitFor(() => expect(host.operations.getSnapshot()[0]?.status).toBe('unknown'));
    await first.destroy(); host.publish({ viewId: 'binding-2' }); const second = await host.open(); click();
    await vi.waitFor(() => expect(host.host.textContent).toContain('awaiting reconciliation'));
    expect(retry).toHaveBeenCalledOnce();
    await second.reconcile(host.operations.getSnapshot()[0].context.operationId); click();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
});

it.each(['accepted', 'unknown'] as const)('keeps an approval locked after its response is %s', async status => {
    const respond = vi.fn(async (_request, context) => status === 'accepted'
        ? { status, operationId: context.operationId } : { status, operationId: context.operationId, message: 'Receipt lost' });
    const host = fixture({ actions: { respond, reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) } });
    await host.open(); host.publish({ interactions: [{ id: 'approval', revision: 0, kind: 'approval', title: 'Approve?',
        state: 'pending', decisions: [{ id: 'yes', label: 'YES' }] }] });
    const control = host.host.querySelector<HTMLButtonElement>('[data-request-id="approval"] button')!;
    control.click(); await vi.waitFor(() => expect(host.operations.getSnapshot()[0]?.status).toBe(status));
    await vi.waitFor(() => expect(control.disabled).toBe(true)); control.click();
    expect(respond).toHaveBeenCalledOnce();
    host.publish({ interactions: [{ ...host.options.source.getSnapshot().interactions[0], revision: 1 }] });
    const updated = host.host.querySelector<HTMLButtonElement>('[data-request-id="approval"] button')!;
    expect(updated.disabled).toBe(false); updated.click();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
});

it.each(['missing', 'throws'])('uploads and submits without native UUID (%s)', async mode => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: original.getRandomValues.bind(original),
        ...(mode === 'throws' ? {randomUUID: () => {throw new Error('Unavailable native UUID');}} : {})});
    try {
        const host = fixture({upload: async file => ({id: file.name, name: file.name, mimeType: file.type})}), view = await host.open();
        view.setText('Compatible draft'); await view.addFiles([new File(['x'], 'X.txt')]); await view.submit();
        expect(host.operations.getSnapshot()[0]).toMatchObject({status: 'accepted'});
        expect(host.operations.getSnapshot()[0].context.operationId).toMatch(/^[\da-f]{8}-[\da-f-]{27}$/i);
    } finally {vi.unstubAllGlobals();}
});
