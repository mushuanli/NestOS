import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SeqFileKernelStore } from './infrastructure/seqfile/store';
import { Kernel } from './application/kernel';
import { ManagedResourceStore } from './infrastructure/seqfile/managed-resources';
import { DurablePoller } from './runtime/durable-poller';
import type { DurableTaskProgram } from './domain/types';

/** A program that finishes on init, so a test Session can hold only terminal Tasks. */
function completedProgram(): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.echo', version: '1' },
        init(input) { return { state: null, next: { type: 'complete', output: input } }; },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

/** Paths passed as the first argument to each spy, regardless of the spy's exact type. */
function firstArguments(spies: Array<{ mock: { calls: unknown[][] } }>): string[] {
    return spies.flatMap(spy => spy.mock.calls.map(call => String(call[0])));
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('reuses binding listeners without recreating layout and still validates current records', async () => {
    vi.useFakeTimers();
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, maxConcurrent: 0, pollMs: 0 });
    const storage = { kind: 'test', locator: '/session' };
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session' }; } });
    try {
        await kernel.initialize(); await kernel.createSession({ id: 's', storage });
        const metadata = vi.spyOn(fs.driver, 'updateMetadata'), create = vi.spyOn(fs.driver, 'createFile');
        const start = vi.spyOn(DurablePoller.prototype, 'start');
        await kernel.openSession('s', storage); await kernel.openSession('s', storage);
        expect(metadata).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
        expect(start.mock.calls.flat()).not.toContain('session:s');
        await expect(kernel.openSession('s', { kind: 'other', locator: null })).rejects.toThrow('binding conflict');
        const record = JSON.parse((await fs.meta.seq!.getEntry('/session/session.seq', 'record'))!);
        await fs.meta.seq!.setEntry('/session/session.seq', 'record', JSON.stringify({ ...record, layout: { ...record.layout, layoutVersion: 999 } }));
        await expect(kernel.openSession('s', storage)).rejects.toThrow();
        // Simulate external removal, bypassing VFS's fixed-layout protection.
        await backend.delete('/session', { recursive: true });
        await expect(kernel.openSession('s', storage)).rejects.toThrow();
        expect(create).not.toHaveBeenCalled(); expect(metadata).not.toHaveBeenCalled();
    } finally { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); }
});

it('scans idle managed resources once and returns the deadline from the same transaction', async () => {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const binding = { fs, rootPath: '/kernel' };
    const resources = new ManagedResourceStore(binding, async () => binding);
    try {
        await resources.initialize();
        const transaction = vi.spyOn(backend.records, 'transaction');
        const walk = vi.spyOn(backend.records, 'walkRecordFields');
        expect(await resources.sweep('kernel')).toBeUndefined();
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(walk.mock.calls.map(call => call[2]?.prefix)).toEqual(['managed/resource/', 'managed/request/', 'managed/cleanup/'].map(prefix => `__vfs_seq__:${prefix}`));
    } finally { resources.dispose(); await manager.dispose(); }
});

it('uses the deadline returned by a poll and wakes again on an explicit change', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValueOnce({ nextDelay: 50 }).mockResolvedValue({ nextDelay: undefined });
    const nextDelay = vi.fn();
    const poller = new DurablePoller({ intervalMs: 0, poll, nextDelay, onError: () => false });
    try {
        poller.start('s'); await vi.advanceTimersByTimeAsync(0);
        expect(poll).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(50); expect(poll).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1000); expect(poll).toHaveBeenCalledTimes(2);
        expect(nextDelay).not.toHaveBeenCalled();
        poller.start('s'); await vi.advanceTimersByTimeAsync(0); expect(poll).toHaveBeenCalledTimes(3);
    } finally { poller.dispose(); }
});

it('recovers a clean Session without rewriting Task records, index projections or catalog rows', async () => {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const storage = { kind: 'test', locator: { rootPath: '/session' } };
    const resolver = { kind: 'test', async resolve() { return { fs, rootPath: '/session' }; } };
    const owner = new Kernel({ catalog: { fs, rootPath: '/catalog' }, maxConcurrent: 1, pollMs: 0 });
    const reader = new Kernel({ catalog: { fs, rootPath: '/catalog' }, maxConcurrent: 0, pollMs: 0 });
    for (const kernel of [owner, reader]) {
        kernel.registerStorageResolver(resolver);
        kernel.registerProgram(completedProgram());
    }
    try {
        await owner.initialize();
        const session = await owner.createSession({ id: 's', storage });
        for (let index = 0; index < 3; index += 1) {
            await session.submit({ program: { kind: 'test.echo', version: '1' }, input: `t${index}`, requestId: `r${index}` });
        }
        await owner.waitIdle();
        owner.dispose(); await owner.waitIdle();
        await reader.initialize();
        // The first recovery may repair projections left behind by the completing Kernel.
        await reader.recoverSessions(['s'], { takeover: true });
        const transactions = vi.spyOn(backend.records, 'transaction');
        const batch = vi.spyOn(backend.records, 'getRecordFieldsMany');
        const reads = [
            vi.spyOn(backend.records, 'getRecordField'), vi.spyOn(backend.records, 'getRecordFields'),
            vi.spyOn(backend.records, 'walkRecordFields'), vi.spyOn(backend.records, 'queryRecordFields'),
        ];
        const writes = [
            vi.spyOn(backend.records, 'setRecordField'), vi.spyOn(backend.records, 'setAllRecordFields'),
            vi.spyOn(backend.records, 'deleteRecordField'), vi.spyOn(backend.records, 'clearRecordFields'),
        ];
        await reader.recoverSessions(['s'], { takeover: true });
        const written = firstArguments(writes), read = firstArguments(reads);
        expect(written.filter(path => path.includes('/tasks/'))).toEqual([]);
        expect(written.filter(path => path.includes('/index.seq'))).toEqual([]);
        expect(written.filter(path => path.includes('/catalog.seq'))).toEqual([]);
        // Every Task record is read once for the whole recovery, in one batched read.
        expect(batch.mock.calls.flatMap(([requests]) => requests)
            .filter(request => request.path.includes('/tasks/') && request.field === '__vfs_seq__:record')).toHaveLength(3);
        expect(read.filter(path => path.includes('/tasks/'))).toHaveLength(0);
        // Index repair and the wait graph share one transaction; the deadline reuse and the
        // Session-record pass-through keep the whole clean recovery inside this budget.
        expect(transactions.mock.calls.length).toBeLessThanOrEqual(12);
    } finally {
        owner.dispose(); reader.dispose();
        await Promise.all([owner.waitIdle(), reader.waitIdle()]);
        await manager.dispose();
    }
});

it('rebuilds a damaged Task index densely so the Task page stays readable', async () => {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const storage = { kind: 'test', locator: { rootPath: '/session' } };
    const resolver = { kind: 'test', async resolve() { return { fs, rootPath: '/session' }; } };
    const owner = new Kernel({ catalog: { fs, rootPath: '/catalog' }, maxConcurrent: 1, pollMs: 0 });
    const reader = new Kernel({ catalog: { fs, rootPath: '/catalog' }, maxConcurrent: 0, pollMs: 0 });
    for (const kernel of [owner, reader]) {
        kernel.registerStorageResolver(resolver);
        kernel.registerProgram(completedProgram());
    }
    try {
        await owner.initialize();
        const session = await owner.createSession({ id: 's', storage });
        const ids: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            ids.push((await session.submit({ program: { kind: 'test.echo', version: '1' }, input: `t${index}`, requestId: `r${index}` })).id);
        }
        await owner.waitIdle();
        owner.dispose(); await owner.waitIdle();
        // A projection that never committed leaves the index inconsistent with the records.
        await fs.meta.seq!.setEntry('/session/index.seq', `task/${ids[1]}`, JSON.stringify({ status: 'running', updatedAt: 0 }));
        await reader.initialize();
        await reader.recoverSessions(['s'], { takeover: true });
        const page = await reader.listSessionTaskPage('s', { limit: 10 });
        expect(page.items.map(task => task.id).sort()).toEqual([...ids].sort());
        const inspection = await reader.inspectSession('s');
        expect(await inspection.listTasks()).toHaveLength(3);
    } finally {
        owner.dispose(); reader.dispose();
        await Promise.all([owner.waitIdle(), reader.waitIdle()]);
        await manager.dispose();
    }
});

it('reads shared state and its layout guard in one transaction', async () => {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const binding = { fs, rootPath: '/session' };
    const store = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => binding);
    try {
        await store.initialize();
        await store.createSession('s', { kind: 'test', locator: null });
        await store.setShared(binding, 'b', 2);
        await store.setShared(binding, 'a', 1);
        const transaction = vi.spyOn(backend.records, 'transaction');
        expect((await store.listShared(binding)).map(entry => entry.key)).toEqual(['a', 'b']);
        expect(transaction).toHaveBeenCalledTimes(1);
    } finally { await manager.dispose(); }
});
