import { expect, it, vi } from 'vitest';
import type { ConversationControls, ConversationSnapshot } from '@itookit/ui-common';
import {createOperationLedger, type OperationLedger} from '@itookit/llm-ui';
import { createNativeChatBinding } from './native';
import { ChatProjection } from './projection';
import {NativeComposerCapabilities} from './native-composer';

vi.mock('@itookit/llm-ui', async () => ({ ...(await vi.importActual<typeof import('@itookit/llm-ui')>('@itookit/llm-ui')), createChatView: vi.fn() }));
it('reconciles query reports through the read-only owner without consulting native mutation receipts', async () => {
    const host = fixture(), operations = createOperationLedger();
    await operations.register({context: {operationId: 'query', viewId: 'old'}, conversationId: 'native', kind: 'command',
        input: {execution: 'query', kind: 'action'}, status: 'unknown'});
    host.controls.reconcileQuery = vi.fn(async () => host.state());
    const binding = await createNativeChatBinding({...host.options, operations});
    expect(await binding.actions.reconcile!('query')).toMatchObject({status: 'unknown', operationId: 'query'});
    host.emit({queryReceipts: [{id: 'query', status: 'accepted'}]});
    expect(await binding.actions.reconcile!('query')).toMatchObject({status: 'accepted', operationId: 'query'});
    expect(host.reconcile).not.toHaveBeenCalled(); expect(host.controls.reconcileQuery).toHaveBeenCalledTimes(2); binding.dispose();
});
it('queries a pending native submission through the independent port and projects only its durable query receipt', async () => {
    const host = fixture(), operations = createOperationLedger();
    const descriptor = {name: 'session:status', description: 'State', kind: 'action' as const, execution: 'query' as const, revision: 'native-v1'};
    host.controls.commands = vi.fn(async () => [descriptor]); host.controls.command = vi.fn();
    host.emit({supportsSlashCommands: true, slashCommands: [descriptor], canSend: false, canCommand: false, canQueryCommand: true,
        pending: true, submission: {id: 'original', status: 'pending'}});
    host.controls.queryCommand = vi.fn(async (_name, _args, operationId) => {
        host.emit({queryReceipts: [{id: operationId!, status: 'accepted'}], messages: [{id: `command:${operationId}`, role: 'system', text: 'Observed state'}]});
        return host.state();
    });
    const binding = await createNativeChatBinding({...host.options, operations});
    const command = binding.source.getSnapshot().commands![0];
    vi.mocked(host.controls.commands!).mockRejectedValue(new Error('Native directory is blocked'));
    expect(command.disabled).toBe(false);
    const context = {operationId: 'read-state', viewId: binding.source.getSnapshot().viewId};
    const input = {target: {id: command.id, expectedRevision: command.revision}, kind: 'action' as const, text: '/session:status', arguments: ''};
    await operations.register({context, conversationId: 'native', kind: 'command', input, status: 'submitting'});
    expect(await binding.actions.command!(input, context)).toMatchObject({status: 'accepted', operationId: 'read-state'});
    expect(host.controls.queryCommand).toHaveBeenCalledWith(descriptor.name, '', 'read-state', descriptor);
    expect(host.controls.command).not.toHaveBeenCalled(); expect(host.state().submission).toEqual({id: 'original', status: 'pending'});
    expect(binding.source.getSnapshot().operationReceipts).toContainEqual(expect.objectContaining({status: 'accepted', operationId: 'read-state'}));
    expect(binding.source.getSnapshot().messages[0].role).toBe('system'); binding.dispose();
});
it('keeps input available while showing that only read-only native commands were discovered', async () => {
    const host = fixture(); host.emit({commandCatalogObservation: {complete: false, code: 'DSH_SESSION_NOT_ATTACHED'}});
    const binding = await createNativeChatBinding(host.options);
    expect(binding.source.getSnapshot().allowed).toContain('send');
    expect(binding.source.getSnapshot().error).toMatchObject({code: 'DSH_SESSION_NOT_ATTACHED'});
    host.emit({commandCatalogObservation: {complete: true}});
    expect(binding.source.getSnapshot().error).toBeUndefined(); binding.dispose();
});

it('refreshes the native command directory after explicit ownership changes', async () => {
    const observation: NonNullable<ConversationSnapshot['observation']> = {execution: 'idle', scope: 'external', source: 'history',
        observedAt: Date.now(), connection: 'online', stale: false, receiptUnknown: false};
    const host = fixture(); host.emit({supportsSlashCommands: true, observation});
    host.controls.commands = vi.fn(async () => [{name: 'session:status', description: 'State', kind: 'action' as const}]);
    const capabilities = new NativeComposerCapabilities(host.controls);
    await capabilities.load(host.state()); await capabilities.load(host.state());
    expect(host.controls.commands).toHaveBeenCalledOnce();
    host.emit({observation: {...observation, scope: 'controlled'}});
    await capabilities.load(host.state()); expect(host.controls.commands).toHaveBeenCalledTimes(2); capabilities.dispose();
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
it('rejects structured arguments when the native target has no declared mapping', async () => {
    const host = fixture(); host.controls.enqueue = vi.fn();
    const binding = await createNativeChatBinding(host.options);
    expect(await binding.actions.send!({text: 'Original', attachments: [], input: {targetId: 'native',
        signature: {id: 'flow', revision: 1, digest: 'one'}, values: {count: 0}}},
        {operationId: 'unsupported', viewId: binding.source.getSnapshot().viewId}))
        .toMatchObject({status: 'rejected', code: 'UNSUPPORTED_INPUT'});
    expect(host.controls.enqueue).not.toHaveBeenCalled(); binding.dispose();
});
it('does not associate another conversation or an action command with the current user turn', async () => {
    const host = fixture(), operations = createOperationLedger();
    for (const [operationId, conversationId, kind, input] of [
        ['other', 'another-conversation', 'send', {}], ['compact', 'native', 'command', {kind: 'action'}],
    ] as const) {
        await operations.register({context: {operationId, viewId: 'old'}, conversationId, kind, input, status: 'submitting'});
        await operations.settle({status: 'accepted', operationId, submissionRef: 'same-turn'});
    }
    host.emit({messages: [{id: 'user', role: 'user', text: 'Original input', turnId: 'same-turn'}]});
    const binding = await createNativeChatBinding({...host.options, operations});
    expect(binding.source.getSnapshot().messages[0].submissionId).toBeUndefined(); binding.dispose();
});
it('accepts native queued input during an active turn and preserves its history association after draining', async () => {
    const host = fixture(), operations = createOperationLedger();
    host.emit({canQueue: true, canSend: false, active: true});
    host.controls.enqueue = vi.fn(async (_text, _files, _selection, id) => {
        host.emit({instructionQueue: {revision: 1, paused: false, acceptedIds: [id!], submissions: [{id: id!}], items: []}});
        return {...host.state(), submission: {id: id!, status: 'accepted' as const}};
    });
    const binding = await createNativeChatBinding({...host.options, operations});
    const context = {operationId: 'queued-input', viewId: binding.source.getSnapshot().viewId};
    await operations.register({context, conversationId: 'native', kind: 'send', input: {}, status: 'submitting'});
    expect(binding.source.getSnapshot().allowed).toContain('send');
    const result = await binding.actions.send!({text: 'Next', attachments: []}, context);
    expect(result).toMatchObject({status: 'accepted', operationId: 'queued-input'});
    expect(host.controls.enqueue).toHaveBeenCalledWith('Next', [], undefined, 'queued-input');
    expect(binding.source.getSnapshot().messages).toEqual([]);
    expect(binding.source.getSnapshot().operationReceipts).toContainEqual(expect.objectContaining({status: 'accepted', operationId: 'queued-input'}));
    await operations.settle(result);
    host.emit({instructionQueue: {revision: 4, paused: false, acceptedIds: ['queued-input'],
        submissions: [{id: 'queued-input', turnId: 'native-turn'}], items: []},
        messages: [{id: 'native-user', role: 'user', text: 'Next', turnId: 'native-turn'}]});
    expect(binding.source.getSnapshot().messages[0]).toMatchObject({id: 'native-user', submissionId: 'queued-input'});
    expect(binding.source.getSnapshot().operationReceipts).toContainEqual(expect.objectContaining({observedUserMessageId: 'native-user'}));
    binding.dispose();
});

it('routes declared state queries immediately and serial commands into the native queue', async () => {
    const host = fixture(); host.emit({supportsSlashCommands: true, canQueue: true, canCommand: true, canSend: false});
    host.controls.commands = vi.fn(async () => [
        {name: 'compact', description: 'Compact', kind: 'action' as const, execution: 'serial' as const, id: 'compact-definition', revision: 'one'},
        {name: 'session:status', description: 'State', kind: 'action' as const, execution: 'query' as const, id: 'status-definition', revision: 'one'},
    ]);
    host.controls.enqueue = vi.fn(async (_text, _files, _selection, id) => ({...host.state(), submission: {id: id!, status: 'accepted' as const}}));
    host.controls.command = vi.fn(async () => ({...host.state(), submission: {id: 'query', status: 'accepted' as const}}));
    const binding = await createNativeChatBinding(host.options);
    for (const [name, operationId] of [['compact', 'serial'], ['session:status', 'query']]) {
        const target = binding.source.getSnapshot().commands!.find(command => command.commandId === name)!;
        expect(target.disabled).toBe(false);
        expect(await binding.actions.command!({target: {id: target.id, expectedRevision: target.revision},
            kind: 'action', text: `/${name}`, arguments: ''}, {operationId, viewId: binding.source.getSnapshot().viewId})).toMatchObject({status: 'accepted'});
    }
    expect(host.controls.enqueue).toHaveBeenCalledOnce(); expect(host.controls.enqueue).toHaveBeenCalledWith('/compact', [], undefined, 'serial');
    expect(host.controls.command).toHaveBeenCalledWith('session:status', '', undefined, '/session:status', 'query',
        {id: 'status-definition', revision: 'one', kind: 'action', execution: 'query'});
    binding.dispose();
});
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

it('projects model capabilities and forwards validated selections without using a local connection', async () => {
    const host = fixture(); host.emit({supportsModels: true});
    host.controls.models = vi.fn(async () => ({models: [{id: 'native', label: 'Native model', reasoningEfforts: [{id: 'high', label: 'High'}]}]}));
    host.controls.send = vi.fn(async () => ({...host.state(), submittedTurnId: 'turn'}));
    const binding = await createNativeChatBinding(host.options);
    const selectors = binding.source.getSnapshot().selectors!;
    expect(selectors[0].choices).toContainEqual({id: 'native', label: 'Native model'});
    expect(selectors[1].variants!.values.native.choices).toContainEqual({id: 'high', label: 'High'});
    const context = {operationId: 'send', viewId: binding.source.getSnapshot().viewId};
    expect(await binding.actions.send!({text: 'Prompt', attachments: [], selection: {modelId: 'native', reasoningEffort: 'high'}}, context)).toMatchObject({status: 'accepted'});
    expect(host.controls.send).toHaveBeenCalledWith('Prompt', [], {modelId: 'native', reasoningEffort: 'high'}, 'send');
    const invalid = await binding.actions.send!({text: 'Prompt', attachments: [], selection: {modelId: 'native', reasoningEffort: 'invalid'}}, context);
    expect(invalid).toMatchObject({status: 'rejected', code: 'INVALID_SELECTION'}); expect(host.controls.send).toHaveBeenCalledOnce(); binding.dispose();
});

it('retries failed metadata with bounded backoff while keeping repeated snapshots quiet', async () => {
    vi.useFakeTimers();
    const host = fixture(); host.emit({supportsSlashCommands: true});
    host.controls.commands = vi.fn().mockRejectedValueOnce(new Error('Temporary')).mockResolvedValue([{name: 'compact', description: 'Compact', kind: 'action'}]);
    const capabilities = new NativeComposerCapabilities(host.controls);
    try {
        await capabilities.load(host.state()); await capabilities.load(host.state());
        expect(host.controls.commands).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1000); await capabilities.load(host.state());
        expect(host.controls.commands).toHaveBeenCalledTimes(2);
        expect(capabilities.catalog(host.state()).commands).toHaveLength(1);
        await capabilities.load(host.state()); expect(host.controls.commands).toHaveBeenCalledTimes(2);
    } finally {capabilities.dispose(); vi.useRealTimers();}
});

it('revalidates native commands without rereading history or unrelated model metadata', async () => {
    const host = fixture(); host.emit({supportsModels: true, supportsSlashCommands: true});
    host.controls.models = vi.fn(async () => ({models: []}));
    host.controls.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action' as const}]);
    host.controls.command = vi.fn(async () => host.state());
    const binding = await createNativeChatBinding(host.options), target = binding.source.getSnapshot().commands![0];
    host.read.mockClear(); vi.mocked(host.controls.models!).mockClear();
    const input = {target: {id: target.id, expectedRevision: target.revision}, kind: target.kind, text: '/compact ', arguments: ''};
    const context = {operationId: 'compact', viewId: binding.source.getSnapshot().viewId};
    expect(await binding.actions.command!(input, context)).toMatchObject({status: 'accepted'});
    expect(host.read).not.toHaveBeenCalled(); expect(host.controls.models).not.toHaveBeenCalled();
    expect(host.controls.command).toHaveBeenCalledWith('compact', '', undefined, '/compact ', 'compact');
    vi.mocked(host.controls.commands!).mockRejectedValueOnce(new Error('Directory unavailable'));
    expect(await binding.actions.command!(input, context)).toMatchObject({status: 'rejected', code: 'DIRECTORY_UNAVAILABLE'});
    expect(host.controls.command).toHaveBeenCalledOnce(); binding.dispose();
});

it('keeps definite native rejection distinct from an unknown submission', async () => {
    const host = fixture(); host.emit({supportsSlashCommands: true});
    host.controls.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action' as const}]);
    host.controls.command = vi.fn(async () => {throw Object.assign(new Error('Rejected'), {outcome: 'not-committed'});});
    const binding = await createNativeChatBinding(host.options), command = binding.source.getSnapshot().commands![0];
    const receipt = await binding.actions.command!({target: {id: command.id, expectedRevision: command.revision}, kind: command.kind,
        arguments: '', text: '/compact'}, {operationId: 'rejected', viewId: binding.source.getSnapshot().viewId});
    expect(receipt).toMatchObject({status: 'rejected', code: 'NATIVE_REJECTED'}); binding.dispose();
});

it('refreshes a changed command contribution without dropping the last usable model catalog', async () => {
    const host = fixture(); host.emit({supportsModels: true, supportsSlashCommands: true});
    host.controls.models = vi.fn(async () => ({models: [{id: 'native', label: 'Native', reasoningEfforts: []}]}));
    host.controls.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action' as const}]);
    host.controls.command = vi.fn();
    const binding = await createNativeChatBinding(host.options);
    const next = [{name: 'verify', description: 'Verify', kind: 'prompt' as const}];
    vi.mocked(host.controls.commands).mockResolvedValue(next);
    vi.mocked(host.controls.models).mockRejectedValueOnce(new Error('temporary metadata failure'));
    host.emit({slashCommands: next});
    await vi.waitFor(() => expect(binding.source.getSnapshot().commands?.[0].name).toBe('verify'));
    expect(binding.source.getSnapshot().selectors?.[0].choices).toContainEqual({id: 'native', label: 'Native'});
    binding.dispose();
});

it('aggregates host and harness commands with distinct routes and keeps UI commands usable offline', async () => {
    const host = fixture(); host.emit({supportsSlashCommands: true});
    host.controls.commands = vi.fn(async () => [{name: 'compact', description: 'Native compact', kind: 'action' as const}]);
    host.controls.command = vi.fn(async () => host.state());
    const execute = vi.fn(async (_input, context) => ({status: 'accepted' as const, operationId: context.operationId}));
    const binding = await createNativeChatBinding({...host.options, commandProviders: [{source: {id: 'ui', label: 'UI'},
        commands: () => [{id: 'compact', revision: 0, name: 'compact', description: 'View compact', kind: 'action'}], execute}]});
    const catalog = binding.source.getSnapshot().commands!;
    expect(catalog).toHaveLength(2); expect(new Set(catalog.map(command => command.id)).size).toBe(2);
    const context = {operationId: 'command', viewId: binding.source.getSnapshot().viewId};
    const run = (command: typeof catalog[number]) => binding.actions.command!({target: {id: command.id, expectedRevision: command.revision}, kind: command.kind,
        text: '/compact', arguments: ''}, context);
    await run(catalog.find(command => command.source.id === 'harness')!);
    expect(host.controls.command).toHaveBeenCalledWith('compact', '', undefined, '/compact', 'command');
    host.emit({canSend: false, disconnected: true}); host.read.mockRejectedValue(new Error('offline'));
    expect(await run(catalog.find(command => command.source.id === 'ui')!)).toMatchObject({status: 'accepted'});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({target: {id: 'compact', expectedRevision: 0}}), context);
    expect(host.controls.command).toHaveBeenCalledOnce(); binding.dispose();
});

it('rejects a harness command removed after completion rather than falling through to a model', async () => {
    const host = fixture(); host.emit({supportsSlashCommands: true});
    host.controls.commands = vi.fn(async () => [{name: 'compact', description: 'Native compact', kind: 'action' as const}]);
    host.controls.command = vi.fn(async () => host.state()); host.controls.send = vi.fn();
    const binding = await createNativeChatBinding(host.options), command = binding.source.getSnapshot().commands![0];
    vi.mocked(host.controls.commands!).mockResolvedValue([]);
    const receipt = await binding.actions.command!({target: {id: command.id, expectedRevision: command.revision}, kind: 'action', text: '/compact', arguments: ''},
        {operationId: 'cmd', viewId: binding.source.getSnapshot().viewId});
    expect(receipt).toMatchObject({status: 'rejected', code: 'STALE_COMMAND'});
    expect(host.controls.command).not.toHaveBeenCalled(); expect(host.controls.send).not.toHaveBeenCalled(); binding.dispose();
});

it('releases every provider even if one command contribution throws during cleanup', async () => {
    const host = fixture(), first = vi.fn(() => {throw new Error('cleanup');}), second = vi.fn();
    const binding = await createNativeChatBinding({...host.options, commandProviders: [
        {source: {id: 'one', label: 'One'}, commands: () => [], execute: vi.fn(), subscribe: () => first},
        {source: {id: 'two', label: 'Two'}, commands: () => [], execute: vi.fn(), subscribe: () => second},
    ]});
    expect(() => binding.dispose()).toThrow('cleanup'); expect(second).toHaveBeenCalledOnce(); expect(host.listeners.size).toBe(0);
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

it('keeps newer streamed content when an older send response arrives', async () => {
    const host = fixture(), pending = deferred<ConversationSnapshot>();
    host.controls.send = async () => pending.promise;
    const binding = await createNativeChatBinding(host.options);
    const sending = binding.actions.send!({ text: 'hello', attachments: [] }, { operationId: 'send', viewId: binding.source.getSnapshot().viewId });
    const old = { ...host.state(), submittedTurnId: 'turn', messages: [{ id: 'reply', role: 'assistant' as const, text: 'old' }] };
    host.emit({ messages: [{ id: 'reply', role: 'assistant', text: 'new streamed output' }] });
    pending.resolve(old);
    expect(await sending).toMatchObject({ status: 'accepted', submissionRef: 'turn' });
    expect(binding.source.getSnapshot().messages[0].parts[0]).toMatchObject({ text: 'new streamed output' }); binding.dispose();
});

it('keeps a resolved request when an older approval response arrives', async () => {
    const host = fixture(), pending = deferred<ConversationSnapshot>();
    host.emit({ requests: [{ id: 'approval', kind: 'approval', detail: 'Approve?' }] });
    const respond = vi.fn(async () => pending.promise); host.controls.respond = respond;
    const binding = await createNativeChatBinding(host.options), request = binding.source.getSnapshot().interactions[0];
    const responding = binding.actions.respond!({ id: request.id, revision: request.revision,
        response: { kind: 'approval', decisionId: 'accept' } }, { operationId: 'response', viewId: binding.source.getSnapshot().viewId });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    const old = { ...host.state() }; host.emit({ requests: [], messages: [{ id: 'reply', role: 'assistant', text: 'continued' }] });
    pending.resolve(old); expect(await responding).toMatchObject({ status: 'accepted' });
    expect(binding.source.getSnapshot().interactions).toEqual([]);
    expect(binding.source.getSnapshot().messages[0].parts[0]).toMatchObject({ text: 'continued' }); binding.dispose();
});

it('answers an observed early approval without waiting for another history read', async () => {
    const host = fixture(); host.emit({pending: true, canSend: false, requests: [{id: 'early', kind: 'approval', detail: 'Approve?'}]});
    host.controls.respond = vi.fn(async () => ({...host.state(), requests: []}));
    const binding = await createNativeChatBinding(host.options), request = binding.source.getSnapshot().interactions[0];
    host.read.mockRejectedValue(new Error('History is blocked behind turn startup'));
    try {
        expect(await binding.actions.respond!({id: request.id, revision: request.revision, response: {kind: 'approval', decisionId: 'accept'}},
            {operationId: 'early-answer', viewId: binding.source.getSnapshot().viewId})).toMatchObject({status: 'accepted'});
        expect(host.read).toHaveBeenCalledOnce(); expect(host.controls.respond).toHaveBeenCalledWith('early', {decision: 'accept'});
    } finally {binding.dispose();}
});

it('maps immutable native attachments through the host and enforces negotiated kinds', async () => {
    const host = fixture(); host.emit({attachments: ['text']});
    host.controls.send = vi.fn(async () => ({...host.state(), submittedTurnId: 'turn'}));
    const images = {read: vi.fn(async () => new Blob(['Notes'], {type: 'text/plain'}))} as never;
    const binding = await createNativeChatBinding({...host.options, images});
    const context = {operationId: 'with-file', viewId: binding.source.getSnapshot().viewId};
    expect(await binding.actions.send!({text: '', attachments: [{id: 'asset', name: 'notes.txt', mimeType: 'text/plain'}]}, context)).toMatchObject({status: 'accepted'});
    expect(host.controls.send).toHaveBeenCalledWith('', [{kind: 'text', name: 'notes.txt', content: 'Notes'}], undefined, 'with-file');
    host.emit({attachments: []});
    expect(await binding.actions.send!({text: 'Read', attachments: [{id: 'asset', name: 'notes.txt', mimeType: 'text/plain'}]}, context)).toMatchObject({status: 'rejected', code: 'INVALID_ATTACHMENT'});
    expect(host.controls.send).toHaveBeenCalledTimes(1); binding.dispose();
});

it('projects a known native input rejection without turning it into an unknown submission', async () => {
    const host = fixture();
    host.emit({canQueue: true});
    host.controls.enqueue = vi.fn(async () => {throw Object.assign(new Error('Native prompt exceeds 128 KiB'), {
        code: 'EINVAL', remoteCode: 'HARNESS_PROMPT_LIMIT', outcome: 'not-committed',
    });});
    const binding = await createNativeChatBinding(host.options);
    try {
        expect(await binding.actions.send!({text: 'Large input', attachments: []}, {
            operationId: 'oversize-input', viewId: binding.source.getSnapshot().viewId,
        })).toMatchObject({status: 'rejected', operationId: 'oversize-input', code: 'HARNESS_PROMPT_LIMIT', message: expect.stringContaining('128 KiB')});
    } finally {binding.dispose();}
});

it('rejects a native attachment read finishing after binding disposal', async () => {
    const host = fixture(), pending = deferred<Blob>(); host.emit({attachments: ['text']});
    host.controls.send = vi.fn();
    const binding = await createNativeChatBinding({...host.options, images: {read: () => pending.promise} as never});
    const send = binding.actions.send!({text: 'Read', attachments: [{id: 'asset', name: 'notes.txt', mimeType: 'text/plain'}]},
        {operationId: 'late', viewId: binding.source.getSnapshot().viewId});
    binding.dispose(); pending.resolve(new Blob(['Late']));
    expect(await send).toMatchObject({status: 'rejected'}); expect(host.controls.send).not.toHaveBeenCalled();
});

it('assembles image preprocessing and metadata persistence when creating a native ChatView', async () => {
    const {createChatView} = await import('@itookit/llm-ui'), {createNativeChatView} = await import('./native');
    const host = fixture(), close = vi.fn(async () => {}), dispose = vi.fn(async () => {}), setActive = vi.fn();
    vi.mocked(createChatView).mockResolvedValueOnce({destroy: close, setActive, replaceBinding: vi.fn()} as never);
    let uploadId = 0;
    const upload = vi.fn(async (file: File) => ({id: file.name + ++uploadId, name: file.name, mimeType: file.type}));
    const saveMetadata = vi.fn(async () => {});
    const images = {upload, saveMetadata, read: async () => new Blob(), loadMetadata: async () => undefined,
        getResize: () => ({mode: 'max-edge' as const, maxEdge: 1024}), processor: {dispose,
            process: async () => ({blob: new Blob(['derived'], {type: 'image/png'}), mimeType: 'image/png', changed: true, purpose: 'export'})} as never};
    const binding = await createNativeChatBinding({...host.options, images}), view = await createNativeChatView({} as HTMLElement, binding);
    const options = vi.mocked(createChatView).mock.calls.at(-1)![1], signal = new AbortController().signal;
    const original = new File(['original'], 'image.png', {type: 'image/png'}), prepared = await options.imageEditing!.prepare!(original, {signal});
    const ref = await options.upload!(prepared, {signal}); await options.imageEditing!.uploaded!(prepared, ref, {signal});
    expect(upload).toHaveBeenCalledTimes(2); expect(saveMetadata).toHaveBeenCalledWith(ref, expect.objectContaining({original: expect.objectContaining({id: 'image.png2'})}));
    expect(view.setActive).toBe(setActive); expect(view.destroy).toBe(close);
    expect(options.release).toBeTypeOf('function'); options.setActive?.(false); await options.release?.(); await view.destroy();
    expect(close).toHaveBeenCalledOnce(); expect(dispose).not.toHaveBeenCalled(); binding.dispose();
});

it('routes cancellation through its own frozen native operation while input acceptance is unknown', async () => {
    const host = fixture(), operations = createOperationLedger();
    const observation = {execution: 'running' as const, activeTurnId: 'turn', source: 'events' as const, observedAt: Date.now(), connection: 'online' as const, stale: false, receiptUnknown: true};
    host.emit({sessionId: 's', canInterrupt: true, pending: true, observation});
    host.controls.reconcileControl = vi.fn(async () => host.state());
    host.controls.interrupt = vi.fn(async request => ({...host.state(), controls: [{operationId: request!.operationId!, sessionId: 's', turnId: 'turn', receipt: 'accepted' as const, effect: 'unconfirmed' as const}]}));
    const binding = await createNativeChatBinding({...host.options, operations});
    const context = {viewId: binding.source.getSnapshot().viewId, operationId: 'independent-stop'};
    await operations.register({context, conversationId: 'native', kind: 'cancel', input: 'turn', status: 'submitting'});
    expect(binding.source.getSnapshot()).toMatchObject({executionRef: 'turn', allowed: expect.arrayContaining(['cancel'])});
    expect(await binding.actions.cancel!('turn', context)).toMatchObject({status: 'accepted', operationId: 'independent-stop'});
    expect(host.controls.interrupt).toHaveBeenCalledWith({sessionId: 's', turnId: 'turn', operationId: 'independent-stop'});
    expect(binding.source.getSnapshot().operationReceipts).toContainEqual({status: 'accepted', operationId: 'independent-stop', submissionRef: 'turn'});
    expect(binding.source.getSnapshot().messages).toEqual([]); binding.dispose();
});
it('rejects a changed cancel target and reconciles only the dedicated control channel', async () => {
    const host = fixture(), operations = createOperationLedger();
    const observation = {execution: 'running' as const, activeTurnId: 'old', source: 'events' as const, observedAt: Date.now(), connection: 'online' as const, stale: false, receiptUnknown: true};
    host.emit({sessionId: 's', pending: true, canInterrupt: true, observation});
    host.controls.interrupt = vi.fn();
    host.controls.reconcileControl = vi.fn(async id => ({...host.state(), controls: [{operationId: id!, sessionId: 's', turnId: 'old', receipt: 'accepted' as const, effect: 'completed' as const}]}));
    const binding = await createNativeChatBinding({...host.options, operations});
    const context = {viewId: binding.source.getSnapshot().viewId, operationId: 'recover-stop'};
    await operations.register({context, conversationId: 'native', kind: 'cancel', input: 'old', status: 'unknown'});
    host.emit({observation: {...observation, activeTurnId: 'new'}});
    expect(await binding.actions.cancel!('old', context)).toMatchObject({status: 'rejected', code: 'STALE_EXECUTION'});
    expect(host.controls.interrupt).not.toHaveBeenCalled();
    expect(await binding.actions.reconcile!('recover-stop')).toMatchObject({status: 'accepted', operationId: 'recover-stop'});
    expect(host.controls.reconcileControl).toHaveBeenCalledWith('recover-stop'); expect(host.reconcile).not.toHaveBeenCalled(); binding.dispose();
});

it('uses direct native admission for the first turn until queuing is explicitly available', async () => {
    const host = fixture();
    host.controls.send = vi.fn(async () => ({...host.state(), submittedTurnId: 'first-turn'}));
    host.controls.enqueue = vi.fn(async (_text, _files, _selection, id) => ({...host.state(), submission: {id: id!, status: 'accepted' as const}}));
    const binding = await createNativeChatBinding(host.options);
    try {
        const context = {operationId: 'first', viewId: binding.source.getSnapshot().viewId};
        expect(await binding.actions.send!({text: 'First', attachments: []}, context)).toMatchObject({status: 'accepted'});
        expect(host.controls.send).toHaveBeenCalledWith('First', [], undefined, 'first');
        expect(host.controls.enqueue).not.toHaveBeenCalled();
        host.emit({canQueue: true, canSend: false});
        expect(await binding.actions.send!({text: 'Second', attachments: []}, {...context, operationId: 'second'})).toMatchObject({status: 'accepted'});
        expect(host.controls.enqueue).toHaveBeenCalledWith('Second', [], undefined, 'second');
        expect(host.controls.send).toHaveBeenCalledOnce();
    } finally {binding.dispose();}
});
