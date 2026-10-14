import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { SessionMemoryProvider } from '../src/session/session-memory-provider';
import { TaskMemoryService } from '../src/session/task-memory-service';
import { DurableAgentProgram } from '@itookit/llm-tasks';

let manager: IVFSManager, fs: IFileSystem, kernel: Kernel;
const policy = { namespaceId: 'agent', readScopes: ['project'], writeScopes: ['project'], retrievalLimit: 10 };
const plan = { pendingUserMessage: { role: 'user', content: 'authorization' } } as never;
const agent = { id: 'agent', version: '1' };
async function openKernel() {
    const value = new Kernel({ catalog: { fs } });
    value.registerStorageResolver({ kind: 'memory-test', resolve: async ref => ({ fs, rootPath: `/sessions/${ref.locator}` }) });
    await value.initialize(); return value;
}
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    fs = await manager.openFileSystem('/test'); kernel = await openKernel();
    for (const id of ['one', 'two']) await kernel.createSession({ id, storage: { kind: 'memory-test', locator: id } });
});
afterEach(async () => { kernel.dispose(); await manager.dispose(); });

it('authorizes memory tools from persisted Task input rather than model-supplied identity or policy', async () => {
    kernel.registerProgram(new DurableAgentProgram());
    const session = await kernel.openSession('one');
    const task = await session.submit({ program: { kind: 'llm.agent', version: '1' }, deferStart: true,
        input: { sessionId: 'one', roundId: 'round', connectionId: 'default', messages: [],
            memoryPolicy: policy, allowedToolIds: ['memory_write', 'memory_list'] } });
    const service = new TaskMemoryService(kernel);
    const context = { sessionId: 'one', taskId: task.id, abortSignal: new AbortController().signal };
    await service.invoke('memory_write', { scope: 'project', entryId: 'note', content: 'saved',
        sessionId: 'two', memoryPolicy: { writeScopes: ['private'] } }, context);
    expect(JSON.parse(await service.invoke('memory_list', {}, context))[0].content).toBe('saved');
    expect(await new SessionMemoryProvider(kernel).list('two', policy)).toEqual([]);
    await expect(service.invoke('memory_write', { scope: 'private', entryId: 'note', content: 'secret' }, context)).rejects.toThrow('denied');
    await expect(service.invoke('memory_remove', { scope: 'project', entryId: 'note' }, context)).rejects.toThrow('capability denied');
    const abort = new AbortController(); abort.abort(new Error('cancelled'));
    await expect(service.invoke('memory_write', { scope: 'project', entryId: 'note', content: 'late' },
        { ...context, abortSignal: abort.signal })).rejects.toThrow('cancelled');
    await task.cancel();
    await expect(service.invoke('memory_list', {}, context)).rejects.toThrow('already ended');
});

it('rejects stale management edits and deletes after a concurrent content update', async () => {
    const provider = new SessionMemoryProvider(kernel);
    const entry = { entryId: 'entry', scope: 'project', content: 'original' };
    await provider.upsert('one', policy, entry, { expectedContentHash: null });
    const [original] = await provider.list('one', policy);
    const results = await Promise.allSettled(['first', 'second'].map(content => provider.upsert('one', policy,
        { ...entry, content }, { expectedContentHash: original.contentHash })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await expect(provider.remove('one', policy, entry.scope, entry.entryId,
        { expectedContentHash: original.contentHash })).rejects.toThrow('changed');
    await expect(provider.upsert('one', policy, entry, { expectedContentHash: null })).rejects.toThrow('changed');
    const [current] = await provider.list('one', policy);
    await provider.remove('one', policy, entry.scope, entry.entryId, { expectedContentHash: current.contentHash });
    expect(await provider.list('one', policy)).toEqual([]);
    await expect(provider.upsert('one', policy, entry, { expectedContentHash: current.contentHash })).rejects.toThrow('changed');
    await expect(provider.upsert('one', policy, entry, { expectedContentHash: 'invalid' })).rejects.toThrow('Invalid expected');
});

it('rejects an old revision after the same memory is deleted and recreated with identical content', async () => {
    const provider = new SessionMemoryProvider(kernel);
    const entry = { entryId: 'same', scope: 'project', content: 'unchanged text' };
    await provider.upsert('one', policy, entry);
    const first = (await provider.list('one', policy))[0];
    await provider.remove('one', policy, entry.scope, entry.entryId, { expectedRevision: first.revision });
    await provider.upsert('one', policy, entry, { expectedRevision: null });
    const recreated = (await provider.list('one', policy))[0];
    expect(recreated.contentHash).toBe(first.contentHash);
    expect(recreated.revision).not.toBe(first.revision);
    await expect(provider.upsert('one', policy, { ...entry, content: 'stale edit' }, { expectedRevision: first.revision }))
        .rejects.toThrow('revision changed');
    await expect(provider.remove('one', policy, entry.scope, entry.entryId, { expectedRevision: first.revision }))
        .rejects.toThrow('revision changed');
    expect((await provider.list('one', policy))[0]).toEqual(recreated);
});

it('commits smaller summaries with immutable source references and rejects concurrent source changes', async () => {
    const provider = new SessionMemoryProvider(kernel);
    await provider.upsert('one', policy, { entryId: 'source', scope: 'project', content: 'A long original memory describing the same useful fact in many words.' });
    const source = (await provider.list('one', policy))[0];
    const summary = { entryId: 'summary', scope: 'project', content: 'Useful fact.' };
    await provider.compact('one', policy, summary, [{ entryId: source.entryId, revision: source.revision }],
        { model: 'test-model', origin: { operationId: 'compact', taskId: 'task', effectId: 'effect' } });
    const stored = await provider.list('one', policy);
    expect(stored).toHaveLength(2);
    expect(stored.find(item => item.entryId === 'source')).toEqual(source);
    expect(stored.find(item => item.entryId === 'summary')).toMatchObject({ content: 'Useful fact.',
        source: { sessionId: 'one', taskId: 'task', effectId: 'effect' }, compression: { version: 1, model: 'test-model',
            sources: [{ entryId: source.entryId, revision: source.revision, contentHash: source.contentHash }] } });
    await provider.upsert('one', policy, { entryId: 'source', scope: 'project', content: 'Concurrent source update' });
    await expect(provider.compact('one', policy, { ...summary, entryId: 'stale' }, [{ entryId: source.entryId, revision: source.revision }]))
        .rejects.toThrow('source changed');
    expect(await provider.list('one', policy)).toHaveLength(2);
});

it('lists management identities without retrieval truncation and isolates unreadable scopes', async () => {
    const provider = new SessionMemoryProvider(kernel);
    for (const scope of ['project', 'private']) {
        await provider.upsert('one', { ...policy, writeScopes: [scope] }, { entryId: 'same', scope, content: scope });
    }
    await provider.upsert('one', policy, { entryId: 'second', scope: 'project', content: 'second' });
    const entries = await provider.list('one', { ...policy, readScopes: ['project', 'project'], retrievalLimit: 0 });
    expect(entries.map(entry => [entry.scope, entry.entryId])).toEqual([['project', 'same'], ['project', 'second']]);
    expect(entries[0]).toMatchObject({ namespaceId: 'agent', content: 'project', updatedAt: expect.any(Number) });
    entries[0].content = 'mutated outside storage';
    expect((await provider.list('one', policy))[0].content).toBe('project');
    expect(await provider.list('two', policy)).toEqual([]);
    expect(await provider.list('one', { ...policy, namespaceId: 'other' })).toEqual([]);
    const open = vi.spyOn(kernel, 'openSession');
    expect(await provider.list('one', { ...policy, readScopes: [] })).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    await provider.remove('one', policy, entries[0].scope, entries[0].entryId);
    expect((await provider.list('one', policy)).map(entry => entry.entryId)).toEqual(['second']);
    expect((await provider.list('one', { ...policy, readScopes: ['private'] }))[0].content).toBe('private');
});

it('keeps the just-written memory when timestamps tie or the clock moves backward', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2000);
    try {
        const provider = new SessionMemoryProvider(kernel);
        const capped = { ...policy, retention: { maxEntriesPerScope: 1 } };
        for (const [entryId, time] of [['a', 2000], ['z', 2000], ['last', 1000]] as const) {
            clock.mockReturnValue(time);
            await provider.upsert('one', capped, { entryId, scope: 'project', content: entryId });
            expect((await provider.retrieve(plan, agent, { sessionId: 'one', policy })).map(entry => entry.content)).toEqual([entryId]);
        }
    } finally { clock.mockRestore(); }
});

it('counts only committed removals when concurrent pruners retry a CAS conflict', async () => {
    const provider = new SessionMemoryProvider(kernel);
    await provider.upsert('one', policy, { entryId: 'old', scope: 'project', content: 'old' });
    const results = await Promise.all([provider.prune('one', policy, Date.now() + 1000),
        provider.prune('one', policy, Date.now() + 1000)]);
    expect(results.reduce((sum, result) => sum + result.removed, 0)).toBe(1);
    expect(await provider.retrieve(plan, agent, { sessionId: 'one', policy })).toEqual([]);
});

it('merges concurrent memories, isolates sessions/scopes and retrieves them after Kernel reconstruction', async () => {
    const provider = new SessionMemoryProvider(kernel);
    await Promise.all(['authorization', 'formatting'].map(entryId => provider.upsert('one', policy,
        { entryId, scope: 'project', content: `${entryId} rules` })));
    await provider.upsert('one', { ...policy, writeScopes: ['private'] }, { entryId: 'secret', scope: 'private', content: 'authorization private' });
    expect(await provider.retrieve(plan, agent, { sessionId: 'two', policy })).toEqual([]);
    expect(await provider.retrieve(plan, agent, { sessionId: 'one', policy: { ...policy, namespaceId: 'other' } })).toEqual([]);
    kernel.dispose(); kernel = await openKernel();
    const restored = new SessionMemoryProvider(kernel);
    const entries = await restored.retrieve(plan, agent, { sessionId: 'one', policy });
    expect(entries.map(entry => entry.content)).toEqual(['authorization rules', 'formatting rules']);
    expect(entries[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    await restored.upsert('one', policy, { entryId: 'authorization', scope: 'project', content: 'updated authorization' });
    expect(entries[0].content).toBe('authorization rules');
    await restored.remove('one', policy, 'project', 'formatting');
    expect(await restored.retrieve(plan, agent, { sessionId: 'one', policy })).toHaveLength(1);
});

it('rejects writes outside policy and invalid limits before opening storage', async () => {
    const openSession = vi.spyOn(kernel, 'openSession');
    const provider = new SessionMemoryProvider(kernel);
    await expect(provider.upsert('one', policy, { entryId: 'entry', scope: 'private', content: 'secret' })).rejects.toThrow('denied');
    await expect(provider.remove('one', policy, 'private', 'entry')).rejects.toThrow('denied');
    await expect(provider.retrieve(plan, agent, { sessionId: 'one', policy: { ...policy, retrievalLimit: -1 } })).rejects.toThrow('limit');
    expect(await provider.retrieve(plan, agent, { sessionId: 'one' })).toEqual([]);
    expect(await provider.retrieve(plan, agent, { sessionId: 'one', policy: { ...policy, retrievalLimit: 0 } })).toEqual([]);
    expect(openSession).not.toHaveBeenCalled();
});

it('rejects corrupt memory records without overwriting them', async () => {
    const session = await kernel.openSession('one');
    const key = 'memory.entries.["agent","project"]';
    await session.setShared(key, [{ content: 'corrupt' }]);
    const provider = new SessionMemoryProvider(kernel);
    await expect(provider.retrieve(plan, agent, { sessionId: 'one', policy })).rejects.toThrow('Invalid stored memory');
    await expect(provider.upsert('one', policy, { entryId: 'new', scope: 'project', content: 'new' })).rejects.toThrow('Invalid stored memory');
    expect((await session.getShared(key))?.value).toEqual([{ content: 'corrupt' }]);
});

it('caps stored entries per scope and prunes by an explicit watermark', async () => {
    vi.useFakeTimers();
    try {
        const provider = new SessionMemoryProvider(kernel);
        const capped = { ...policy, retention: { maxEntriesPerScope: 2 } };
        for (const [index, entryId] of ['first', 'second', 'third'].entries()) {
            vi.setSystemTime(new Date(1_000 + index * 1_000));
            await provider.upsert('one', capped, { entryId, scope: 'project', content: `${entryId} rules` });
        }
        const stored = await provider.retrieve(plan, agent, { sessionId: 'one', policy: { ...capped, readScopes: ['project'] } });
        expect(stored.map(entry => entry.content)).toEqual(['third rules', 'second rules']);
        // Another scope keeps its own budget, and writes outside it stay denied.
        await provider.upsert('one', { ...capped, writeScopes: ['private'] }, { entryId: 'secret', scope: 'private', content: 'secret' });
        expect((await provider.retrieve(plan, agent, { sessionId: 'one', policy: { ...capped, readScopes: ['private'] } })).length).toBe(1);

        // A host-owned watermark drops only entries older than it, and needs write authority.
        await expect(provider.prune('one', policy, -1)).rejects.toThrow('watermark');
        await expect(provider.prune('one', { ...policy, writeScopes: [] }, 2_500)).resolves.toEqual({ removed: 0 });
        expect(await provider.prune('one', capped, 2_500)).toEqual({ removed: 1 });
        expect((await provider.retrieve(plan, agent, { sessionId: 'one', policy: { ...capped, readScopes: ['project'] } }))
            .map(entry => entry.content)).toEqual(['third rules']);
        await expect(provider.upsert('one', { ...policy, retention: { maxEntriesPerScope: 0 } },
            { entryId: 'bad', scope: 'project', content: 'x' })).rejects.toThrow('retention cap');
    } finally { vi.useRealTimers(); }
});

it.each(['before', 'after'] as const)('does not hide a storage failure %s a retention commit behind a successful retry', async phase => {
    const provider = new SessionMemoryProvider(kernel);
    await provider.upsert('one', policy, { entryId: 'old', scope: 'project', content: 'old' });
    const session = await kernel.openSession('one');
    const setShared = session.setShared.bind(session);
    const opened = vi.spyOn(kernel, 'openSession').mockResolvedValue(session);
    const write = vi.spyOn(session, 'setShared').mockImplementationOnce(async (key, value, options) => {
        if (phase === 'after') await setShared(key, value, options);
        throw new Error('storage result unavailable');
    });
    try {
        await expect(provider.prune('one', policy, Date.now() + 1000)).rejects.toThrow('storage result unavailable');
        expect(write).toHaveBeenCalledOnce();
    } finally { write.mockRestore(); opened.mockRestore(); }
    kernel.dispose(); kernel = await openKernel();
    expect((await new SessionMemoryProvider(kernel).list('one', policy)).map(entry => entry.entryId))
        .toEqual(phase === 'before' ? ['old'] : []);
});
