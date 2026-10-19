import { expect, it, vi } from 'vitest';
import type { ConversationControls, ConversationSnapshot } from '@itookit/ui-common';
import type { OperationLedger } from '@itookit/llm-ui';
import { createNativeChatBinding } from './native';
import { ChatProjection } from './projection';
import {NativeComposerCapabilities} from './native-composer';

vi.mock('@itookit/llm-ui', async () => ({ createChatView: vi.fn(), composeCommandCatalogs: (await vi.importActual<typeof import('@itookit/llm-ui')>('@itookit/llm-ui')).composeCommandCatalogs }));
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
    expect(host.controls.send).toHaveBeenCalledWith('Prompt', [], {modelId: 'native', reasoningEffort: 'high'});
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
    expect(host.controls.command).toHaveBeenCalledWith('compact', '', undefined, '/compact ');
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
    expect(host.controls.command).toHaveBeenCalledWith('compact', '', undefined, '/compact');
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
    expect(await binding.actions.send!({text: 'Read', attachments: [{id: 'asset', name: 'notes.txt', mimeType: 'text/plain'}]}, context)).toMatchObject({status: 'accepted'});
    expect(host.controls.send).toHaveBeenCalledWith('Read', [{kind: 'text', name: 'notes.txt', content: 'Notes'}]);
    host.emit({attachments: []});
    expect(await binding.actions.send!({text: 'Read', attachments: [{id: 'asset', name: 'notes.txt', mimeType: 'text/plain'}]}, context)).toMatchObject({status: 'rejected', code: 'INVALID_ATTACHMENT'});
    expect(host.controls.send).toHaveBeenCalledTimes(1); binding.dispose();
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
    const host = fixture(), close = vi.fn(async () => {}), dispose = vi.fn(async () => {});
    vi.mocked(createChatView).mockResolvedValueOnce({destroy: close} as never);
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
    await view.destroy(); await view.destroy(); expect(close).toHaveBeenCalledOnce(); expect(dispose).not.toHaveBeenCalled(); binding.dispose();
});
