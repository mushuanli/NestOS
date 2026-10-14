import { afterEach, beforeEach, expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Kernel } from '@itookit/durable-kernel';
import type { MemoryPolicy } from '@itookit/llm-tasks/contracts';
import { SharedMemoryStore } from '../src/session/shared-memory-store';
import { SessionMemoryProvider } from '../src/session/session-memory-provider';

let manager: Awaited<ReturnType<typeof createVFS>>['manager'];
let kernel: Kernel, shared: SharedMemoryStore, memory: SessionMemoryProvider, policy: MemoryPolicy;

beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/');
    shared = new SharedMemoryStore(fs); await shared.init();
    kernel = new Kernel({ catalog: { fs } }); await kernel.initialize();
    memory = new SessionMemoryProvider(kernel, shared);
    const ref = await shared.create('team', 'notes', 'creator');
    policy = { sharedMemory: { id: ref.id, incarnation: ref.incarnation }, namespaceId: 'notes', readScopes: ['project'], writeScopes: ['project'] };
});
afterEach(async () => { await kernel.dispose(); await manager.dispose(); });

async function grant(sessionId: string, writable = true) {
    const resource = await shared.inspect(policy.sharedMemory!);
    await shared.grant(resource, sessionId, { readScopes: ['project'], writeScopes: writable ? ['project'] : [] }, resource.revision);
}

it('requires explicit grants and shares across Sessions without creating or depending on the creator Session', async () => {
    await expect(memory.list('one', policy)).rejects.toThrow('denied');
    await grant('one'); await grant('two', false);
    await memory.upsert('one', policy, { scope: 'project', entryId: 'note', content: 'shared' });
    expect((await memory.list('two', policy))[0]).toMatchObject({ content: 'shared', source: { sessionId: 'one' } });
    await expect(memory.upsert('two', policy, { scope: 'project', entryId: 'note', content: 'forbidden' })).rejects.toThrow('denied');
    await expect(memory.list('one', { ...policy, namespaceId: 'another' })).rejects.toThrow('denied');
    const sessions = [];
    for await (const session of kernel.listSessions()) sessions.push(session);
    expect(sessions).toEqual([]);
});

it('serializes concurrent writes and condition conflicts in the same authority', async () => {
    await grant('one'); await grant('two');
    await Promise.all(['one', 'two'].map(sessionId => memory.upsert(sessionId, policy, { scope: 'project', entryId: sessionId, content: sessionId })));
    expect(await memory.list('one', policy)).toHaveLength(2);
    const revision = (await memory.list('one', policy))[0].revision;
    const results = await Promise.allSettled(['one', 'two'].map(sessionId => memory.upsert(sessionId, policy,
        { scope: 'project', entryId: 'one', content: sessionId }, { expectedRevision: revision })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});

it('replays committed operation receipts without rewriting a newer version or resurrecting deleted content', async () => {
    await grant('one');
    const entry = { scope: 'project', entryId: 'note', content: 'original' };
    const options = { origin: { operationId: 'write', taskId: 'task', effectId: 'effect' }, expectedRevision: null };
    await memory.upsert('one', policy, entry, options);
    const first = (await memory.list('one', policy))[0];
    await memory.remove('one', policy, 'project', 'note', { origin: { operationId: 'remove' } });
    await memory.upsert('one', policy, entry, options);
    expect(await memory.list('one', policy)).toEqual([]);
    await memory.upsert('one', policy, entry);
    expect((await memory.list('one', policy))[0].revision).not.toBe(first.revision);
    await memory.remove('one', policy, 'project', 'note', { origin: { operationId: 'remove' } });
    expect(await memory.list('one', policy)).toHaveLength(1);
    await expect(memory.upsert('one', policy, { ...entry, content: 'different' }, options)).rejects.toThrow('identity conflict');
    expect((await shared.history(policy.sharedMemory!)).filter(event => event.action === 'mutate')).toHaveLength(3);
});

it('fences revoked grants and stale incarnations after resource deletion and recreation', async () => {
    await grant('one');
    let resource = await shared.inspect(policy.sharedMemory!);
    await shared.grant(resource, 'one', null, resource.revision);
    await expect(memory.list('one', policy)).rejects.toThrow('denied');
    resource = await shared.inspect(resource);
    await shared.remove(resource, resource.revision);
    const replacement = await shared.create(resource.id, resource.namespaceId, 'new-creator');
    expect(replacement.incarnation).not.toBe(resource.incarnation);
    await expect(memory.list('one', policy)).rejects.toThrow('unavailable');
    expect((await shared.history(resource)).map(event => event.action)).toEqual(['create', 'grant', 'revoke', 'delete']);
});

it('records a no-op removal receipt so a later recreation is safe from its replay', async () => {
    await grant('one');
    const options = { origin: { operationId: 'remove-missing' } };
    await memory.remove('one', policy, 'project', 'missing', options);
    await memory.upsert('one', policy, { scope: 'project', entryId: 'missing', content: 'later' });
    await memory.remove('one', policy, 'project', 'missing', options);
    expect((await memory.list('one', policy))[0].content).toBe('later');
});

it('requires current read and write grants when compacting and replays summaries without changing their sources', async () => {
    await grant('one');
    await memory.upsert('one', policy, { scope: 'project', entryId: 'source', content: 'Long original content retained after compression.' });
    const original = (await memory.list('one', policy))[0];
    const source = [{ entryId: original.entryId, revision: original.revision }];
    const summary = { scope: 'project', entryId: 'summary', content: 'Short summary' };
    const resource = await shared.inspect(policy.sharedMemory!);
    await shared.grant(resource, 'two', { readScopes: [], writeScopes: ['project'] }, resource.revision);
    await expect(memory.compact('two', policy, summary, source)).rejects.toThrow('readScopes denied');
    const options = { origin: { operationId: 'compact', taskId: 'task', effectId: 'effect' }, model: 'model' };
    await memory.compact('one', policy, summary, source, options);
    const entries = await memory.list('one', policy);
    await memory.compact('one', policy, summary, source, options);
    expect(await memory.list('one', policy)).toEqual(entries);
    expect(entries.find(item => item.entryId === 'source')).toEqual(original);
    expect(entries.find(item => item.entryId === 'summary')?.compression).toMatchObject({ model: 'model', sources: source });
});
