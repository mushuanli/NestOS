import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {RpcPeer} from '@itookit/app-transport/application';
import {ConversationComposerStore} from '../../../backend/app-core/src/projects/conversation-composer-store';
import {HarnessConversation} from '@itookit/nestos-node-driver';
import type {HarnessClient, HarnessProfile, HarnessRecovery} from '@itookit/nestos-node-driver';
import {observeConversation} from '../../../backend/app-core/src/projects/conversation-view';

it('preserves native input rejection evidence and attachment-only queue identity across RPC', async () => {
    let server!: RpcPeer, saved: HarnessRecovery | undefined;
    const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
    const session = {id: 's', title: 'Native', cwd: null, status: 'idle', updatedAt: 1, resumable: true, owned: true};
    const profile: HarnessProfile = {id: 'native', kind: 'fixture', workspaces: [{id: 'p'}], capabilities: {
        history: true, create: true, resume: true, interrupt: true, interactions: true, attachments: ['text', 'image'],
    }};
    const harness = {read: vi.fn(async () => ({session, turns: []})), eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []})),
        create: vi.fn(), resume: vi.fn(), turn: vi.fn(async () => ({turnId: 'file-turn'})), subscribe: () => () => {}, close: vi.fn(async () => {})};
    const source = new HarnessConversation(harness as unknown as HarnessClient, profile, 'p', 's', true, {
        epoch: 'e', load: async () => saved, save: async value => {saved = structuredClone(value);},
    });
    const controls = observeConversation(source);
    try {
        await controls.read(); const peer = client.decode(await server.expose(controls)) as typeof controls;
        await expect(peer.send('Review', [{kind: 'image', name: 'bad.png', mimeType: 'image/png', content: 'data:image/png;base64,AQID'}], undefined, 'invalid-file'))
            .rejects.toMatchObject({code: 'EINVAL', remoteCode: 'HARNESS_ATTACHMENT_MIME_MISMATCH', outcome: 'not-committed'});
        expect(harness.create).not.toHaveBeenCalled(); expect(harness.resume).not.toHaveBeenCalled(); expect(harness.turn).not.toHaveBeenCalled();
        expect((await peer.read()).pending).toBe(false);
        const files = [{kind: 'text' as const, name: 'notes.txt', content: '\ufeffNotes'}];
        expect(await peer.enqueue!('', files, undefined, 'only-file')).toMatchObject({instructionQueue: {acceptedIds: ['only-file']}});
        expect(saved!.instructionQueue!.items[0]).toMatchObject({id: 'only-file', text: '', attachments: files});
        await peer.refresh(); expect(harness.turn).toHaveBeenCalledWith('native', 's', 'Attachments: notes.txt', expect.objectContaining({requestId: 'only-file', attachments: files}));
        expect(harness.turn).toHaveBeenCalledOnce(); expect(saved!.pending).toBeUndefined();
    } finally {await controls.close(); await client.close(); await server.close();}
});

it('carries composer originals, conditional updates and receipt queries through application RPC', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), error => {throw error;});
    server = new RpcPeer('server', call => client.handle(call), error => {throw error;});
    try {
        const fs = await manager.openFileSystem('/'), store = new ConversationComposerStore(fs, 'project', 'conversation', true, () => {});
        const controls = {kind: 'fixture', snapshot: () => ({title: 'Fixture', messages: [], requests: []}), respond: async () => {},
            readComposerDraft: () => store.readComposerDraft(), saveComposerDraft: store.saveComposerDraft.bind(store),
            putComposerAsset: store.putComposerAsset.bind(store), readComposerAsset: store.readComposerAsset.bind(store)};
        const peer = client.decode(await server.expose(controls)) as typeof controls;
        const bytes = new Uint8Array([4, 3, 2, 1]), id = await peer.putComposerAsset(bytes.buffer);
        expect(new Uint8Array(await peer.readComposerAsset(id))).toEqual(bytes);
        const next = await peer.saveComposerDraft('{"original":"asset","crop":"rect"}', '0', 'rpc-save');
        expect(await peer.readComposerDraft()).toEqual(next);
        await expect(peer.saveComposerDraft('stale', '0', 'stale')).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(await peer.saveComposerDraft('duplicate', '0', 'rpc-save')).toEqual(next);
    } finally {await client.close(); await server.close(); await manager.dispose();}
});

it('carries native queue acceptance, CAS text editing and exact reconciliation through real RPC', async () => {
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call));
    server = new RpcPeer('server', call => client.handle(call));
    const session = {id: 's', title: 'Native', cwd: null, status: 'active', activeTurnId: 'prior', updatedAt: 1, resumable: true, owned: true};
    const profile: HarnessProfile = {id: 'native', kind: 'fixture', projectRuntime: true, workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, slashCommands: true}};
    let dispatched: unknown;
    const harness = {read: async () => ({session, turns: []}), eventSnapshot: async () => ({epoch: 'e', cursor: 0, gap: false, events: [], requests: []}),
        commands: async () => [{name: 'session:status', description: 'State', kind: 'action', execution: 'query', id: 'state', revision: 'one'}],
        command: async (_profile: string, _session: string, _command: string, _args: string, options: unknown) => {
            dispatched = options; return {commandId: 'rpc-query', output: 'Active', status: 'completed'};
        },
        subscribe: () => () => {}, close: async () => {}} as unknown as HarnessClient;
    let saved: HarnessRecovery | undefined;
    const source = new HarnessConversation(harness, profile, 'p', 's', true, {epoch: 'e', load: async () => saved, save: async record => {saved = structuredClone(record);}});
    const controls = observeConversation(source);
    try {
        await controls.read();
        const peer = client.decode(await server.expose(controls)) as typeof controls;
        const stop = peer.subscribe(() => {}); await client.whenIdle();
        const accepted = await peer.enqueue!('Follow-up', [], undefined, 'rpc-queued');
        expect(accepted.instructionQueue).toMatchObject({acceptedIds: ['rpc-queued'], items: [{text: 'Follow-up', state: 'pending'}]});
        const revision = accepted.instructionQueue!.revision;
        const edited = await peer.editInstructionQueue!({action: 'update', id: 'rpc-queued', text: 'Revised', expectedRevision: revision});
        expect(edited.instructionQueue?.items[0].text).toBe('Revised');
        await expect(peer.editInstructionQueue!({action: 'remove', id: 'rpc-queued', expectedRevision: revision})).rejects.toMatchObject({code: 'ECONFLICT'});
        expect((await peer.reconcile('rpc-queued')).instructionQueue?.acceptedIds).toContain('rpc-queued');
        expect(saved?.instructionQueue?.items).toHaveLength(1);
        const query = await peer.command!('session:status', '', undefined, '/session:status', 'rpc-query',
            {id: 'state', revision: 'one', execution: 'query', kind: 'action'});
        expect(dispatched).toMatchObject({requestId: 'rpc-query', expectedCommand: {id: 'state', revision: 'one'}});
        expect(query.instructionQueue?.items).toMatchObject([{text: 'Revised', state: 'pending'}]);
        expect(query.observation?.activeTurnId).toBe('prior');
        stop(); await client.whenIdle();
    } finally {await controls.close(); await client.close(); await server.close();}
});

it('roundtrips exact-target control recovery through RPC without reusing input receipts', async () => {
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
    let session = {id: 's', title: 'Native', cwd: null, status: 'active', activeTurnId: 't' as string | null, updatedAt: 1, resumable: true, owned: true};
    const profile: HarnessProfile = {id: 'native', kind: 'fixture', workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
    let dispatched: unknown, calls = 0, outcome: 'unknown' | 'committed' = 'unknown', saved: HarnessRecovery | undefined;
    const harness = {read: async () => ({session, turns: []}), eventSnapshot: async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []}),
        interrupt: async (_profile: string, sessionId: string, turnId: string, options: unknown) => {
            dispatched = {sessionId, turnId, options}; ++calls; throw Object.assign(new Error('Lost reply'), {outcome: 'unknown'});
        },
        operation: async (_profile: string, requestId: string) => ({requestId, outcome, result: {}}), subscribe: () => () => {}, close: async () => {}} as unknown as HarnessClient;
    const source = new HarnessConversation(harness, profile, 'p', 's', true, {epoch: 'epoch', load: async () => saved, save: async value => {saved = structuredClone(value);}});
    const controls = observeConversation(source);
    try {
        await controls.read(); const peer = client.decode(await server.expose(controls)) as typeof controls;
        await expect(peer.interrupt({sessionId: 's', turnId: 't', operationId: 'rpc-stop'})).rejects.toThrow();
        expect(dispatched).toMatchObject({sessionId: 's', turnId: 't', options: {requestId: 'rpc-stop', epoch: 'epoch'}});
        expect((await peer.read()).controls).toMatchObject([{operationId: 'rpc-stop', receipt: 'unknown'}]);
        outcome = 'committed';
        expect((await peer.reconcileControl!('rpc-stop')).controls).toMatchObject([{receipt: 'accepted', effect: 'unconfirmed'}]);
        session = {...session, status: 'idle', activeTurnId: null, lastTurnId: 't', lastTurnResult: 'completed'} as typeof session;
        const terminal = await peer.read();
        expect(terminal.controls).toMatchObject([{receipt: 'accepted', effect: 'completed'}]);
        expect(saved?.controls?.[0]).toMatchObject({requestId: 'rpc-stop', terminal: 'completed'});
        expect(saved?.pending).toBeUndefined(); expect(saved?.submission).toBeUndefined(); expect(calls).toBe(1);
    } finally {await controls.close(); await client.close(); await server.close();}
});

it('continues native queue editing and exact cancellation through RPC while the claimed send reply hangs', async () => {
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call)); server = new RpcPeer('server', call => client.handle(call));
    let notifications = Promise.resolve();
    server.onInvalidated(() => {notifications = notifications.then(async () => {client.applyUpdates(await server.refresh());});});
    const session = {id: 's', title: 'Native', cwd: null, status: 'idle', updatedAt: 1, resumable: true, owned: true};
    const profile: HarnessProfile = {id: 'native', kind: 'fixture', workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, slashCommands: true, commandQueries: true}};
    let finish!: (value: {turnId: string}) => void, paid = 0, saved: HarnessRecovery | undefined;
    const listeners = new Set<() => void>(), stopped: unknown[] = [];
    let frames: Array<{seq: number; message: {method: string; params: Record<string, unknown>}}> = [];
    const descriptor = {name: 'session:status', description: 'State', kind: 'action', execution: 'query', revision: 'state-v1'};
    const queried: unknown[] = [];
    const harness = {commands: async () => [descriptor], queryCommand: async (_profile: string, sessionId: string, name: string, _args: string, options: {requestId: string}) => {
            queried.push({sessionId, name, options}); return {commandId: options.requestId, output: 'Observed active state', status: 'completed'};
        }, read: async () => ({session, turns: []}), turn: async () => {++paid; return new Promise(resolve => {finish = resolve;});},
        eventSnapshot: async () => ({epoch: 'events', cursor: frames.at(-1)?.seq ?? 0, gap: false, events: frames, requests: []}),
        interrupt: async (_profile: string, sessionId: string, turnId: string, options: unknown) => {
            expect(saved?.instructionQueue?.paused).toBe(true); expect(saved?.pending?.requestId).toBe('first-rpc');
            stopped.push({sessionId, turnId, options});
        },
        subscribe: (_profile: string, listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}, close: async () => {}} as unknown as HarnessClient;
    const source = new HarnessConversation(harness, profile, 'p', 's', true, {epoch: 'epoch', load: async () => saved, save: async value => {saved = structuredClone(value);}});
    const controls = observeConversation(source); let off: (() => void) | undefined;
    try {
        await controls.read(); const peer = client.decode(await server.expose(controls)) as typeof controls;
        off = peer.subscribe(() => {}); await client.whenIdle(); await peer.commands!();
        await peer.enqueue!('First', [], undefined, 'first-rpc');
        await vi.waitFor(() => expect(paid).toBe(1));
        await peer.enqueue!('Second', [], undefined, 'second-rpc');
        const query = await peer.queryCommand!('session:status', '', 'read-rpc', {kind: 'action', execution: 'query', revision: 'state-v1'});
        expect(query.queryReceipts).toEqual([{id: 'read-rpc', status: 'accepted'}]);
        expect(query.pending).toBe(true); expect(saved?.pending?.requestId).toBe('first-rpc');
        expect(queried).toMatchObject([{sessionId: 's', name: 'session:status', options: {requestId: 'read-rpc'}}]);
        expect(query.messages).toContainEqual(expect.objectContaining({id: 'command:read-rpc', role: 'system', text: 'Observed active state'}));
        frames = [{seq: 1, message: {method: 'turn/started', params: {threadId: 's', turn: {id: 'actual-turn'}}}}];
        for (const listener of listeners) listener();
        await vi.waitFor(() => expect(peer.snapshot().canInterrupt).toBe(true));
        await peer.editInstructionQueue!({action: 'pause', expectedRevision: peer.snapshot().instructionQueue!.revision});
        const cancelled = await peer.interrupt({sessionId: 's', turnId: 'actual-turn', operationId: 'stop-rpc'});
        expect(stopped).toMatchObject([{sessionId: 's', turnId: 'actual-turn', options: {requestId: 'stop-rpc'}}]);
        await peer.editInstructionQueue!({action: 'update', id: 'second-rpc', text: 'Revised second', expectedRevision: cancelled.instructionQueue!.revision});
        finish({turnId: 'actual-turn'});
        await client.whenIdle();
        expect(saved?.instructionQueue?.items[1]).toMatchObject({id: 'second-rpc', text: 'Revised second'});
        expect(saved?.controls?.[0]).toMatchObject({requestId: 'stop-rpc', receipt: 'accepted'}); expect(paid).toBe(1);
    } finally {finish?.({turnId: 'actual-turn'}); off?.(); await notifications; await controls.close(); await client.close(); await server.close();}
});
