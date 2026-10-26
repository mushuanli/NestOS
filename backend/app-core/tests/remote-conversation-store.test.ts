import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {RemoteConversationStore} from '../src/projects/remote-conversation-store';
import {interceptConversationTransactions} from './remote-conversation-faults';
it('persists inline native draft attachments with CAS and rejects malformed or excessive recovery data', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), first = new RemoteConversationStore(fs, 'key');
        const record = {draft: 'Review', draftAttachments: [{kind: 'text' as const, name: 'notes.md', content: '中文\nquoted "text"'}]};
        await first.load(); await first.save(record);
        const second = new RemoteConversationStore(fs, 'key'); expect(await second.load()).toEqual(record);
        await first.save({...record, draft: 'Updated'});
        await expect(second.save(record)).rejects.toMatchObject({code: 'ECONFLICT'});
        await expect(first.save({...record, draftAttachments: [{...record.draftAttachments[0], content: 'x'.repeat(65537)}]})).rejects.toMatchObject({code: 'EINVAL'});
        await fs.meta.seq!.setEntry('/etc/fs/harness-conversations.seq', 'key', JSON.stringify({...record, draftAttachments: [{kind: 'image', name: 'private', mimeType: 'image/png', content: 'http://localhost/private'}]}));
        await expect(new RemoteConversationStore(fs, 'key').load()).rejects.toMatchObject({code: 'EINVAL'});
    } finally {await manager.dispose();}
});

it.each([false, true])('recovers the original CAS after an uncertain storage commit (committed: %s)', async committed => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fault = interceptConversationTransactions(await manager.openFileSystem('/'));
        const {fs} = fault, store = new RemoteConversationStore(fs, 'lost-ack');
        await store.save({draft: 'Before'});
        fault.transaction.mockImplementationOnce(async (...args) => {
            if (committed) await fault.commit(...args);
            throw new Error('Lost storage acknowledgement');
        });
        await expect(store.save({draft: 'After'})).rejects.toThrow('Lost storage acknowledgement');
        await store.save({draft: 'Newer draft'});
        expect(await new RemoteConversationStore(fs, 'lost-ack').load()).toEqual({draft: 'Newer draft'});
    } finally {vi.restoreAllMocks(); await manager.dispose();}
});

it('refuses to overwrite another writer after a lost storage acknowledgement, including after load', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fault = interceptConversationTransactions(await manager.openFileSystem('/'));
        const {fs} = fault, store = new RemoteConversationStore(fs, 'conflict');
        await store.save({draft: 'Before'});
        fault.transaction.mockImplementationOnce(async (...args) => {
            await fault.commit(...args); throw new Error('Lost storage acknowledgement');
        });
        await expect(store.save({draft: 'After'})).rejects.toThrow();
        const winner = new RemoteConversationStore(fs, 'conflict'); await winner.load(); await winner.save({draft: 'Winner'});
        await store.load();
        await expect(store.save({draft: 'Stale overwrite'})).rejects.toMatchObject({code: 'ECONFLICT'});
        await store.load();
        await expect(store.save({draft: 'Retry overwrite'})).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(await winner.load()).toEqual({draft: 'Winner'});
    } finally {vi.restoreAllMocks(); await manager.dispose();}
});

it('preserves reconciled control facts when the draft adapter later records native admission', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fault = interceptConversationTransactions(await manager.openFileSystem('/'));
        const store = new RemoteConversationStore(fault.fs, 'merge-admission'); await store.save({draft: 'Before'});
        const controls = [{requestId: 'stop', epoch: 'e', sessionId: 's', turnId: 't', receipt: 'accepted' as const}];
        fault.transaction.mockImplementationOnce(async (...args) => {await fault.commit(...args); throw new Error('Lost acknowledgement');});
        await expect(store.save({draft: 'New draft', controls})).rejects.toThrow();
        await store.submitted('accepted-turn');
        expect(await new RemoteConversationStore(fault.fs, 'merge-admission').load()).toEqual({draft: 'New draft', controls, submittedTurnId: 'accepted-turn'});
    } finally {await manager.dispose();}
});

it('bounds and validates persisted command results and draft revisions', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new RemoteConversationStore(fs, 'receipts');
        const record = {draft: '/compact ', draftRevision: 3, commandResults: [{commandId: 'command', output: 'Done', failed: true}]};
        await store.save(record); expect(await new RemoteConversationStore(fs, 'receipts').load()).toEqual(record);
        await expect(store.save({...record, draftRevision: -1})).rejects.toMatchObject({code: 'EINVAL'});
        await expect(store.save({...record, commandResults: Array(65).fill(record.commandResults[0])})).rejects.toMatchObject({code: 'EINVAL'});
        await expect(store.save({...record, commandResults: [{commandId: '', output: 'Invalid'}]})).rejects.toMatchObject({code: 'EINVAL'});
    } finally {await manager.dispose();}
});

it('preserves reconciled draft metadata when recording native admission', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fault = interceptConversationTransactions(await manager.openFileSystem('/'));
        const store = new RemoteConversationStore(fault.fs, 'draft-admission'); await store.save({draft: 'Before'});
        fault.transaction.mockImplementationOnce(async (...args) => {await fault.commit(...args); throw new Error('Lost acknowledgement');});
        await expect(store.save({draft: 'After', draftRevision: 2})).rejects.toThrow();
        await store.submitted('accepted-turn');
        expect(await new RemoteConversationStore(fault.fs, 'draft-admission').load())
            .toEqual({draft: 'After', draftRevision: 2, submittedTurnId: 'accepted-turn'});
    } finally {await manager.dispose();}
});

it('serializes saves and freezes the caller record before waiting for earlier writes', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new RemoteConversationStore(fs, 'frozen');
        const record = {draft: 'Second', draftRevision: 2};
        const first = store.save({draft: 'First'}), second = store.save(record);
        record.draft = 'Changed outside the store'; await Promise.all([first, second]);
        const loaded = (await store.load())!; loaded.draft = 'Changed returned snapshot';
        await store.submitted('turn');
        expect(await new RemoteConversationStore(fs, 'frozen').load())
            .toEqual({draft: 'Second', draftRevision: 2, submittedTurnId: 'turn'});
    } finally {await manager.dispose();}
});

it('does not let a delayed load move the local CAS cursor behind an accepted save', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let release = () => {}, saved: Promise<void> | undefined, loaded: Promise<unknown> | undefined;
    try {
        const fault = interceptConversationTransactions(await manager.openFileSystem('/'));
        const store = new RemoteConversationStore(fault.fs, 'read-order'); await store.save({draft: 'Before'});
        let entered!: () => void;
        const started = new Promise<void>(resolve => {entered = resolve;});
        const gate = new Promise<void>(resolve => {release = resolve;});
        const read = fault.read.getMockImplementation()!;
        fault.read.mockImplementationOnce(async (...args) => {
            const snapshot = await read(...args); entered(); await gate; return snapshot;
        });
        loaded = store.load(); await started; saved = store.save({draft: 'After'});
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(fault.transaction).toHaveBeenCalledOnce();
        release(); await loaded; await saved; await store.submitted('turn');
        expect(await new RemoteConversationStore(fault.fs, 'read-order').load())
            .toEqual({draft: 'After', submittedTurnId: 'turn'});
    } finally {release(); await Promise.allSettled([loaded, saved]); await manager.dispose();}
});


it('persists queued draft ownership across reopening and rejects malformed consumption markers', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new RemoteConversationStore(fs, 'queue-draft');
        const record = {draft: 'Next input', draftRevision: 2, pending: {requestId: 'original', epoch: 'e', operation: 'turn', inputText: 'Queued input', consumeDraft: false as const}};
        await store.save(record);
        expect(await new RemoteConversationStore(fs, 'queue-draft').load()).toEqual(record);
        for (const value of [true, 'false', null, 0]) {
            const invalid = {...record, pending: {...record.pending, consumeDraft: value}} as unknown as typeof record;
            await expect(store.save(invalid)).rejects.toMatchObject({code: 'EINVAL'});
        }
        expect(await store.load()).toEqual(record);
    } finally {await manager.dispose();}
});
