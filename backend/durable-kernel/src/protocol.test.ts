import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager, type IFileSystem } from '@itookit/vfs-core';
import { Kernel } from './application/kernel';
import { SeqFileKernelStore } from './infrastructure/seqfile/store';
import { addEffect, executeEffectAdapter } from './application/effect-utils';
import { recoverWaitGraphTx } from './infrastructure/seqfile/store-helpers';
import { ensureTree, resourcesPath, sessionPath, taskPath, eventsPath, taskEventKey, taskEventFirstKey } from './infrastructure/seqfile/seqfile-core';
import { bindCapabilities } from './application/capabilities';
import { waitForChange } from './public/event-stream';
import type { ResolvedStorageBinding, TaskRecord, DurableTaskProgram } from './domain/types';

describe('durable harness protocols', () => {
    let manager: IVFSManager, fs: IFileSystem, binding: ResolvedStorageBinding;
    let store: SeqFileKernelStore, kernel: Kernel;
    const spec = { program: { kind: 'test', version: '1' }, input: null };
    it('keeps repeated close requests terminal while rejecting general reopening transitions', async () => {
        const session = await kernel.openSession('s');
        await kernel.closeSession(session.id, true);
        expect((await kernel.sessionStat(session.id)).phase).toBe('closed');
        await Promise.all([kernel.closeSession(session.id, true), kernel.closeSession(session.id, false)]);
        expect((await kernel.sessionStat(session.id)).phase).toBe('closed');
        await expect(kernel.setSessionStatus(session.id, 'closing')).rejects.toThrow('Invalid session transition');
        await kernel.setSessionStatus(session.id, 'archived');
        await kernel.closeSession(session.id, true);
        expect((await store.sessionRecord(binding)).status).toBe('archived');
    });
    it('explicitly reopens a closed Session for new Tasks while retaining terminal Tasks', async () => {
        const session = await kernel.openSession('s');
        const old = await session.spawn(spec);
        await kernel.closeSession('s', true);
        const snapshot = (await old.status()).task;
        expect(snapshot.status).toBe('cancelled');
        await expect((await kernel.openSession('s')).spawn(spec)).rejects.toThrow('Session is closed');
        await expect(kernel.setSessionStatus('s', 'open')).rejects.toThrow('Invalid session transition');
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
        const [reopened] = await Promise.all([kernel.reopenSession('s'), kernel.reopenSession('s')]);
        const next = await reopened.spawn(spec);
        expect(next.id).not.toBe(old.id);
        expect((await old.status()).task).toEqual(snapshot);
        expect((await kernel.sessionStat('s')).phase).toBe('open');
        expect((await kernel.eventList('s')).filter(event => event.type === 'session.reopened')).toHaveLength(1);
    });
    it('does not reopen closing or archived Sessions', async () => {
        await store.setSessionStatus(binding, 'closing', 'cancel');
        await expect(kernel.reopenSession('s')).rejects.toThrow('Cannot reopen session: closing');
        await store.setSessionStatus(binding, 'closed');
        await store.setSessionStatus(binding, 'archived');
        await expect(kernel.reopenSession('s')).rejects.toThrow('Cannot reopen session: archived');
    });
    it('waits for close cleanup before admitting new work', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        await kernel.use({ id: 'slow-close', version: '1', install() {}, async onSessionClosed() { calls++; await gate; } });
        const closing = kernel.closeSession('s', true);
        await expect.poll(() => calls).toBe(1);
        const reopening = kernel.reopenSession('s');
        expect((await kernel.sessionStat('s')).phase).toBe('closed');
        release(); await closing; await reopening;
        expect((await kernel.sessionStat('s')).phase).toBe('open');
    });
    it('ensures deep layouts with bounded reads and observes deletion on the next call', async () => {
        await ensureTree(fs, '/existing/deep/root');
        const exists = vi.spyOn(fs.driver, 'exists');
        try {
            await ensureTree(fs, '/existing/deep/root');
            expect(exists).toHaveBeenCalledTimes(1);
            exists.mockClear();
            await ensureTree(fs, '/existing/deep/root/task/artifacts');
            expect(exists).toHaveBeenCalledTimes(3);
            expect(await fs.driver.exists('/existing/deep/root/task/artifacts')).toBe(true);
            await fs.driver.delete(['/existing/deep/root/task'], { recursive: true });
            await ensureTree(fs, '/existing/deep/root/task/artifacts');
            expect(await fs.driver.exists('/existing/deep/root/task/artifacts')).toBe(true);
        } finally { exists.mockRestore(); }
    });
    it('reads Task records once per scan and observes later changes while skipping crash leftovers', async () => {
        const first = await store.createTask(binding, 's', spec);
        const second = await store.createTask(binding, 's', spec);
        await fs.driver.createDirectory({ name: 'unfinished', parentPath: `${binding.rootPath}/tasks` });
        const scan = vi.fn();
        const scanning = (tx: any) => new Proxy(tx, { get(target, key) {
            if (key !== 'getEntriesMany') {
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return (requests: ReadonlyArray<{ fileIdOrPath: string; key: string }>) => {
                scan(requests);
                return tx.getEntriesMany(requests);
            };
        } });
        const scannedIds = () => scan.mock.calls.flatMap(([requests]) => requests)
            .filter(request => request.key === 'record')
            .map(request => request.fileIdOrPath.split('/tasks/')[1]?.replace('/task.seq', '') ?? request.fileIdOrPath)
            .sort();
        const measured = { ...binding, fs: new Proxy(fs, { get(target, key) {
            return key === 'meta' ? { ...fs.meta, seq: { ...fs.meta.seq,
                transaction: (operation: any) => fs.meta.seq!.transaction!(tx => operation(scanning(tx))) } }
                : Reflect.get(target, key, target);
        } }) };
        {
            const listed = await store.listTasks(measured);
            expect(listed.map(task => task.id)).toEqual([first.id, second.id].sort());
            // One batched read for the whole scan; the crash leftover is probed but yields no Task.
            expect(scan).toHaveBeenCalledTimes(1);
            expect(scannedIds()).toEqual([first.id, second.id, 'unfinished'].sort());
            await store.signalTask(binding, first.id, { type: 'changed', payload: 'new' });
            scan.mockClear();
            const updated = await store.listTasks(measured);
            expect(updated.find(task => task.id === first.id)?.version).toBe(first.version + 1);
            expect(scan).toHaveBeenCalledTimes(1);
            expect(scannedIds()).toEqual([first.id, second.id, 'unfinished'].sort());
        }
    });

    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend(),}));
        fs = await manager.openFileSystem('/data/test');
        binding = { fs, rootPath: '/session' };
        store = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => binding);
        await store.initialize(); await store.createSession('s', { kind: 'test', locator: null });
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0, maxConcurrentEffects: 2 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
    });
    afterEach(async () => { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); });

    it.each(['succeeded', 'failed', 'cancelled'] as const)('replays a resolved interaction after %s without mutating the terminal Task', async status => {
        kernel.registerProgram({ manifest: spec.program,
            init: () => ({ state: null, actions: [{ type: 'request-interaction', interaction: { id: 'answer', kind: 'input', prompt: 'Answer' } }],
                next: { type: 'wait', on: { type: 'interaction', id: 'answer' } } }),
            reduce: () => ({ state: null, next: status === 'failed'
                ? { type: 'fail', error: { message: 'failed after response' } } : { type: 'complete', output: 'done' } }),
        });
        const task = await (await kernel.openSession('s')).submit(spec);
        await vi.waitFor(async () => expect((await task.status()).task.interactions?.answer?.status).toBe('pending'));
        if (status === 'cancelled') await task.pause({ requestId: 'pause-before-response' });
        const response = { interactionId: 'answer', value: { accepted: true } };
        await task.respond(response);
        if (status === 'cancelled') await task.cancel();
        await task.wait({ timeoutMs: 1000 });
        const before = (await task.status()).task;
        expect(before.status).toBe(status);
        const events = await kernel.taskEventPage('s', task.id);
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
        const restored = await (await kernel.openSession('s')).attachTask(task.id);
        await restored.respond(response);
        await expect(restored.respond({ ...response, value: { accepted: false } })).rejects.toThrow('conflict');
        expect((await restored.status()).task).toEqual(before);
        expect(await kernel.taskEventPage('s', task.id)).toEqual(events);
    });

    it.each(['succeeded', 'failed', 'cancelled'] as const)('keeps %s Tasks terminal across lifecycle controls and receipt replay', async status => {
        kernel.registerProgram({ manifest: spec.program,
            init: () => ({ state: null, next: status === 'failed'
                ? { type: 'fail', error: { message: 'failure' } } : { type: 'complete', output: 'done' } }),
            reduce() { throw new Error('unexpected'); },
        });
        const task = await (await kernel.openSession('s')).submit({ ...spec, deferStart: true });
        await task.pause({ requestId: 'pause-original' });
        await task.resume({ requestId: 'resume-original' });
        const start = { signal: { type: 'initial', payload: 'value' } };
        if (status === 'cancelled') await task.cancel();
        else await task.start(start);
        await task.wait({ timeoutMs: 1000 });
        const before = (await task.status()).task, events = await kernel.taskEventPage('s', task.id);
        expect(before.status).toBe(status);
        await task.start();
        await task.signal({ type: 'late', payload: 'ignored' });
        await task.cancel('late cancellation');
        if (status === 'cancelled') await expect(task.start(start)).rejects.toThrow('not started');
        else await task.start(start);
        for (const operation of ['pause', 'resume', 'interrupt'] as const) {
            await expect(task[operation]({ requestId: `new-${operation}` })).rejects.toThrow('terminal');
        }
        expect((await task.pause({ requestId: 'pause-original' })).requestId).toBe('pause-original');
        expect((await task.resume({ requestId: 'resume-original' })).requestId).toBe('resume-original');
        await expect(task.pause({ requestId: 'pause-original', reason: 'changed' })).rejects.toThrow('conflict');
        expect((await task.status()).task).toEqual(before);
        expect(await kernel.taskEventPage('s', task.id)).toEqual(events);
    });

    it('manually retries a terminal Task as an idempotent fresh deferred root', async () => {
        kernel.registerProgram({ manifest: spec.program,
            init() { return { state: { fresh: true }, next: { type: 'complete', output: 'done' } }; },
            reduce() { throw new Error('unexpected'); } });
        const session = await kernel.openSession('s');
        const original = await session.submit({ ...spec, input: { value: 7 } });
        await original.wait({ timeoutMs: 1000 });
        const before = (await original.status()).task;
        const [first, same] = await Promise.all([original.retry({ requestId: 'manual-one' }), original.retry({ requestId: 'manual-one' })]);
        expect(first.id).toBe(same.id);
        expect(first.id).not.toBe(original.id);
        const record = (await first.status()).task;
        expect(record).toMatchObject({ retryOfTaskId: original.id, rootTaskId: first.id, status: 'created',
            input: { value: 7 }, effects: {}, interactions: {}, attemptCount: 0, initialized: false });
        expect(record.parentTaskId).toBeUndefined();
        expect(record.state).toBeUndefined();
        expect((await original.status()).task).toEqual(before);
        await first.start();
        expect((await first.wait({ timeoutMs: 1000 })).output).toBe('done');
        expect((await original.retry({ requestId: 'manual-one' })).id).toBe(first.id);
        expect((await original.retry({ requestId: 'manual-two' })).id).not.toBe(first.id);
    });

    it('rejects retry provenance for nonterminal Tasks and invalid request identity', async () => {
        const session = await kernel.openSession('s');
        const original = await session.submit({ ...spec, deferStart: true });
        await expect(original.retry({ requestId: ' ' })).rejects.toThrow('requestId');
        await expect(original.retry({ requestId: 'retry' })).rejects.toThrow('terminal Task');
        await expect(session.submit({ ...spec, retryOfTaskId: original.id })).rejects.toThrow('terminal Task');
        expect(await session.listTasks()).toHaveLength(1);
        await original.cancel();
        const retry = await original.retry({ requestId: 'retry' });
        expect((await retry.status()).task.status).toBe('created');
        expect((await original.status()).task.status).toBe('cancelled');
    });

    it('validates retry provenance inside structured spawn commits', async () => {
        const session = await kernel.openSession('s');
        const original = await session.submit({ ...spec, deferStart: true });
        kernel.registerProgram({ manifest: { kind: 'retry-spawner', version: '1' },
            init() { return { state: null, actions: [{ type: 'spawn', spawnKey: 'retry',
                spec: { ...spec, retryOfTaskId: original.id, deferStart: true } }], next: { type: 'complete', output: null } }; },
            reduce() { throw new Error('unexpected'); } });
        const parent = await session.submit({ program: { kind: 'retry-spawner', version: '1' }, input: null, retry: { maxAttempts: 1 } });
        expect((await parent.wait({ timeoutMs: 1000 })).status).toBe('failed');
        expect((await session.listTasks()).filter(task => task.retryOfTaskId)).toEqual([]);
        expect((await original.status()).task.status).toBe('created');
    });

    it('retains manual retry request identity after Kernel reconstruction', async () => {
        const session = await kernel.openSession('s');
        const original = await session.submit({ ...spec, deferStart: true });
        await original.cancel();
        const retry = await original.retry({ requestId: 'user-action' });
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
        const restored = await (await kernel.openSession('s')).attachTask(original.id);
        expect((await restored.retry({ requestId: 'user-action' })).id).toBe(retry.id);
        expect((await (await (await kernel.openSession('s')).attachTask(retry.id)).status()).task)
            .toMatchObject({ retryOfTaskId: original.id, status: 'created' });
        expect((await restored.status()).task.status).toBe('cancelled');
    });

    it('deduplicates resource creation per owner and keeps revocation on replay', async () => {
        const session = await kernel.openSession('s');
        const owner = await session.submit({ ...spec, deferStart: true });
        const resource = { requestId: 'llm', kind: 'llm', uri: 'llm://flow', rights: ['execute'] as const };
        const create = () => owner.createResource({ ...resource, rights: ['execute', 'admin'] });
        const [first, duplicate] = await Promise.all([create(), create()]);
        expect(duplicate).toEqual(first);
        expect((await kernel.taskEventPage('s', owner.id)).items.filter(event => event.type === 'resource.created')).toHaveLength(1);
        await expect(owner.createResource({ ...resource, rights: ['admin'] })).rejects.toThrow('Resource creation conflict');
        const other = await session.submit({ ...spec, deferStart: true });
        expect((await other.createResource({ ...resource, rights: ['execute'] })).handle.id).not.toBe(first.handle.id);
        await session.revokeResource(first.handle.id);
        expect((await create()).handle.revokedAt).toBeDefined();
    });

    it('reuses the resource creation receipt after Kernel reconstruction', async () => {
        const owner = await (await kernel.openSession('s')).submit({ ...spec, deferStart: true });
        const request = { requestId: 'tool', kind: 'tool', uri: 'tool://flow' };
        const first = await owner.createResource(request);
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
        const restored = await (await kernel.openSession('s')).attachTask(owner.id);
        expect(await restored.createResource(request)).toEqual(first);
        await expect(restored.createResource({ ...request, requestId: '' })).rejects.toThrow('requestId');
    });

    it('atomically starts with one initial signal and rejects conflicting replays', async () => {
        const task = await (await kernel.openSession('s')).submit({ ...spec, deferStart: true });
        const signal = { type: 'capabilities', payload: { llmHandleId: 'test-handle' } };
        await Promise.all([task.start({ signal }), task.start({ signal })]);
        expect((await task.status()).task.pendingEvents.filter(event => event.type === 'signal')).toHaveLength(1);
        const events = (await kernel.taskEventPage('s', task.id)).items;
        expect(events.filter(event => event.type === 'task.signal')).toHaveLength(1);
        expect(events.filter(event => event.type === 'task.started')).toHaveLength(1);
        await expect(task.start({ signal: { ...signal, payload: {} } })).rejects.toThrow('start signal conflict');
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
        await (await (await kernel.openSession('s')).attachTask(task.id)).start({ signal });
        expect((await kernel.taskEventPage('s', task.id)).items.filter(event => event.type === 'task.signal')).toHaveLength(1);
    });

    it('reuses prepared capabilities after setup failure without prematurely starting', async () => {
        const task = await (await kernel.openSession('s')).submit({ ...spec, deferStart: true });
        const bindings = [{ kind: 'llm', uri: 'llm://test', rights: ['execute' as const], signalKey: 'llmHandleId' }];
        const handles: string[] = [];
        await expect(bindCapabilities(task, bindings, async (_binding, id) => {
            handles.push(id); throw new Error('budget setup failed');
        })).rejects.toThrow('budget setup failed');
        expect((await task.status()).task).toMatchObject({ status: 'created', pendingEvents: [] });
        await bindCapabilities(task, bindings, async (_binding, id) => { handles.push(id); });
        expect(handles[1]).toBe(handles[0]);
        expect((await kernel.taskEventPage('s', task.id)).items.filter(event => event.type === 'resource.created')).toHaveLength(1);
        expect((await task.status()).task.pendingEvents).toContainEqual(expect.objectContaining({ type: 'signal',
            signal: { type: 'capabilities', payload: { llmHandleId: handles[0] } } }));
    });

    it('pages immutable Task versions with bounded key reads and a stable upper bound', async () => {
        const task = await store.createTask(binding, 's', { ...spec, deferStart: true });
        await store.controlTask(binding, task.id, 'pause', { requestId: 'p1' });
        const first = await kernel.taskHistoryPage('s', task.id, { limit: 1 });
        expect(first.items.map(item => item.version)).toEqual([0]);
        expect(first.nextAfterVersion).toBe(0);
        await store.controlTask(binding, task.id, 'resume', { requestId: 'r1' });
        const walk = vi.fn(fs.meta.seq!.walkEntries.bind(fs.meta.seq));
        const get = vi.fn(fs.meta.seq!.getEntries.bind(fs.meta.seq));
        const observed = { ...binding, fs: { ...fs, meta: { ...fs.meta, seq: {
            ...fs.meta.seq, getEntry: fs.meta.seq!.getEntry.bind(fs.meta.seq), getEntries: get, walkEntries: walk,
        } } } } as ResolvedStorageBinding;
        const second = await store.taskHistoryPage(observed, task.id, { afterVersion: first.nextAfterVersion, throughVersion: first.throughVersion, limit: 1 });
        expect(second.items.map(item => item.version)).toEqual([1]);
        expect(second.nextAfterVersion).toBeUndefined();
        expect(walk).not.toHaveBeenCalled();
        expect(get.mock.calls[0][1]).toHaveLength(1);
        expect((await kernel.taskHistoryPage('s', task.id)).throughVersion).toBeGreaterThan(first.throughVersion);
        await expect(kernel.taskHistoryPage('s', task.id, { limit: 501 })).rejects.toThrow('history page');
        await expect(kernel.taskHistoryPage('s', task.id, { throughVersion: Number.MAX_SAFE_INTEGER })).rejects.toThrow('upper bound');
    });

    it('pages a Task event index without scanning unrelated events and pins the upper bound', async () => {
        const task = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const other = await store.createTask(binding, 's', { ...spec, deferStart: true });
        await store.appendEvent(binding, 's', other.id, 'unrelated');
        await store.appendEvent(binding, 's', task.id, 'selected');
        const expected = (await store.events(binding)).filter(event => event.taskId === task.id);
        const walk = vi.fn(() => { throw new Error('Unexpected full scan'); });
        const reads: number[] = [];
        const observed = { ...binding, fs: { ...fs, meta: { ...fs.meta, seq: { ...fs.meta.seq,
            transaction: (operation: any) => fs.meta.seq!.transaction!(tx => operation(new Proxy(tx, {
                get(target, key) {
                    if (key === 'walkEntries') return walk;
                    if (key === 'getEntries') return (path: string, entries: string[]) => {
                        const selected = entries.filter(entry => entry.startsWith('task-event/') || entry.startsWith('event/'));
                        if (selected.length) reads.push(selected.length);
                        return tx.getEntries(path, entries);
                    };
                    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
                },
            }))),
        } } } } as ResolvedStorageBinding;
        let page = await store.taskEventPage(observed, task.id, { limit: 1 });
        const items = [...page.items];
        await store.appendEvent(binding, 's', task.id, 'later');
        while (page.nextAfterIndex !== undefined) {
            page = await store.taskEventPage(observed, task.id, { afterIndex: page.nextAfterIndex, throughIndex: page.throughIndex, limit: 1 });
            items.push(...page.items);
        }
        expect(items).toEqual(expected);
        expect(walk).not.toHaveBeenCalled();
        expect(reads.every(size => size === 1)).toBe(true);
        expect(reads).toHaveLength(expected.length * 2);
        expect((await kernel.taskEventPage('s', task.id)).items.at(-1)?.type).toBe('later');
        await expect(kernel.taskEventPage('s', task.id, { limit: 501 })).rejects.toThrow('event page');
    });

    it('atomically builds a missing Task event index and rejects cross-Task pointers', async () => {
        const task = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const other = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const events = await store.events(binding);
        const seq = fs.meta.seq!, path = '/session/events.seq';
        const keys: string[] = [];
        await seq.walkEntries(path, row => { if (row.key.startsWith('task-event')) keys.push(row.key); return true; });
        for (const key of keys) await seq.deleteEntry(path, key);
        const restored = await kernel.taskEventPage('s', task.id);
        expect(restored.items).toEqual(events.filter(event => event.taskId === task.id));
        expect((await kernel.taskEventPage('s', task.id)).items).toEqual(restored.items);
        const countKey = `task-event-count/${encodeURIComponent(task.id)}`;
        const count = (await seq.getEntry(path, countKey))!;
        await seq.setEntry(path, countKey, String(Number.MAX_SAFE_INTEGER));
        await expect(store.appendEvent(binding, 's', task.id, 'must-rollback')).rejects.toThrow();
        expect(await store.events(binding)).toEqual(events);
        await seq.setEntry(path, countKey, count);
        const foreign = events.find(event => event.taskId === other.id)!;
        await seq.setEntry(path, `task-event/${encodeURIComponent(task.id)}/0000000000000001`, String(foreign.sequence));
        await expect(kernel.taskEventPage('s', task.id)).rejects.toThrow('scope mismatch');
    });

    it('batch-reads Task page pointers and bodies while rejecting missing or foreign records', async () => {
        const tasks = [];
        for (let i = 0; i < 4; i++) tasks.push(await store.createTask(binding, 's', { ...spec, deferStart: true }));
        const calls: string[] = [];
        const seq = fs.meta.seq!;
        const transaction = seq.transaction!.bind(seq);
        const traced: NonNullable<IFileSystem['meta']['seq']>['transaction'] = operation => transaction(tx => operation(new Proxy(tx, {
            get(target, key) {
                const value = Reflect.get(target, key);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => { calls.push(String(key)); return value.apply(target, args); };
            },
        })));
        const observed = { ...binding, fs: { ...fs, meta: { ...fs.meta, seq: { ...seq, transaction: traced } } } } as ResolvedStorageBinding;
        const page = await store.listTaskPage(observed);
        expect(page.items.map(task => task.id)).toEqual(tasks.map(task => task.id));
        expect(calls.filter(key => key === 'getEntries')).toHaveLength(1);
        expect(calls.filter(key => key === 'getEntriesMany')).toHaveLength(1);
        const path = taskPath('/session', tasks[0].id);
        const raw = (await seq.getEntry(path, 'record'))!;
        await seq.deleteEntry(path, 'record');
        await expect(store.listTaskPage(binding)).rejects.toThrow('Task not found');
        await seq.setEntry(path, 'record', JSON.stringify({ ...JSON.parse(raw), sessionId: 'foreign' }));
        await expect(store.listTaskPage(binding)).rejects.toThrow('scope mismatch');
        await seq.setEntry(path, 'record', raw);
        await seq.deleteEntry('/session/index.seq', 'task-order/0000000000000001');
        await expect(store.listTaskPage(binding)).rejects.toThrow('index is missing');
    });

    it('pages stable Task membership while reading current state and backfills old indexes', async () => {
        const first = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const second = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const page = await kernel.listSessionTaskPage('s', { limit: 1 });
        expect(page.items.map(task => task.id)).toEqual([first.id]);
        await store.createTask(binding, 's', { ...spec, deferStart: true });
        await store.controlTask(binding, second.id, 'pause', { requestId: 'pause-listed' });
        const next = await kernel.listSessionTaskPage('s', { afterIndex: page.nextAfterIndex, throughIndex: page.throughIndex, limit: 1 });
        expect(next.items.map(task => task.id)).toEqual([second.id]);
        expect(next.items[0].control.mode).toBe('pause');
        expect(next.nextAfterIndex).toBeUndefined();
        await expect(kernel.listSessionTaskPage('s', { limit: 0 })).rejects.toThrow('list page');
        const seq = fs.meta.seq!, path = '/session/index.seq', keys: string[] = [];
        await seq.walkEntries(path, row => { if (row.key.startsWith('task-order') || row.key.startsWith('task-ordinal') || row.key === 'task-count') keys.push(row.key); return true; });
        for (const key of keys) await seq.deleteEntry(path, key);
        const restored = await kernel.listSessionTaskPage('s');
        expect(restored.items).toHaveLength(3);
        expect(new Set(restored.items.map(task => task.id)).size).toBe(3);
        expect((await kernel.listSessionTaskPage('s')).items.map(task => task.id)).toEqual(restored.items.map(task => task.id));
    });

    it.each([
        { leaseMs: NaN }, { leaseMs: Infinity }, { leaseMs: Number.MAX_SAFE_INTEGER },
        { pollMs: NaN }, { pollMs: Infinity }, { pollMs: 0.5 },
        { maxConcurrent: Number.MAX_SAFE_INTEGER + 1 }, { maxConcurrentEffects: Infinity },
    ])('rejects invalid scheduler configuration %j', options => {
        expect(() => new Kernel({ catalog: { fs, rootPath: '/catalog' }, ...options })).toThrow('Kernel');
    });

    it('keeps long lease heartbeats within the platform timer range', async () => {
        const longLease = new Kernel({ catalog: { fs, rootPath: '/catalog' }, leaseMs: 1_000_000_000_000 });
        longLease.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        longLease.registerProgram({ manifest: spec.program,
            init() { return { state: null, next: { type: 'complete', output: 'done' } }; },
            reduce() { throw new Error('unexpected'); },
        });
        const intervals = vi.spyOn(globalThis, 'setInterval');
        try {
            await longLease.initialize();
            const session = await longLease.openSession('s');
            expect((await (await session.spawn(spec)).wait({ timeoutMs: 1000 })).output).toBe('done');
            expect(intervals.mock.calls.some(call => call[1] === 2147483647)).toBe(true);
            expect(intervals.mock.calls.every(call => Number(call[1]) <= 2147483647)).toBe(true);
        } finally { longLease.dispose(); await longLease.waitIdle(); intervals.mockRestore(); }
    });

    it('uses a deadline timer without polling and leaves idle sessions idle', async () => {
        kernel.registerProgram({
            manifest: { kind: 'timer-only', version: '1' },
            init() { return { state: null, next: { type: 'wait', on: { type: 'timer', id: 'due', at: Date.now() + 30 } } }; },
            reduce(state, event) {
                return event.type === 'timer-fired' ? { state, next: { type: 'complete', output: 'timer' } }
                    : { state, next: { type: 'continue' } };
            },
        });
        const session = await kernel.openSession('s');
        const task = await session.spawn({ program: { kind: 'timer-only', version: '1' }, input: null });
        expect((await task.wait({ timeoutMs: 1000 })).output).toBe('timer');
        await new Promise(resolve => setTimeout(resolve, 30));
        const sweep = vi.spyOn((kernel as any).store, 'sweep');
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(sweep).not.toHaveBeenCalled();
        sweep.mockRestore();
    });

    it('takes over an unexpired attempt and rejects its stale commit', async () => {
        const task = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'dead-process', 60_000))!;
        const paused = await store.createTask(binding, 's', { ...spec, deferStart: true });
        await store.controlTask(binding, paused.id, 'pause', { requestId: 'pause' });
        kernel.registerProgram({ manifest: spec.program,
            init() { return { state: null, next: { type: 'complete', output: 'recovered' } }; },
            reduce() { throw new Error('unexpected'); },
        });
        const report = await kernel.recoverSession('s', { takeover: true });
        expect(report.recoveredTasks).toBe(1);
        expect((await (await kernel.openTask(task.id)).wait({ timeoutMs: 1000 })).output).toBe('recovered');
        expect((await store.readTask(binding, paused.id)).control?.mode).toBe('pause');
        await expect(store.commitTask(binding, claim, { ...claim.task, status: 'succeeded' }, 'task.completed')).rejects.toThrow();
    });

    it('notifies task observers on an external SeqFile commit with polling disabled', async () => {
        const observer = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0, maxConcurrent: 0 });
        observer.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await observer.initialize(); await observer.openSession('s');
        const task = await store.createTask(binding, 's', { ...spec, deferStart: true });
        let notified = false;
        const waiting = waitForChange(observer, 's', task.id, 1000).then(() => { notified = true; });
        try {
            await store.signalTask(binding, task.id, { type: 'external' });
            await Promise.resolve();
            expect(notified).toBe(true);
            await waiting;
        } finally { observer.dispose(); await observer.waitIdle(); }
    });

    it('persists retry progress for a missing session and a rejection when it closes', async () => {
        const source = await kernel.openSession('s');
        const message = await source.sendToSession('later', 'topic', null);
        expect(message.status).toBe('pending');
        const [retry] = await source.outbox();
        expect(retry.deliveryAttempts).toBeGreaterThanOrEqual(1);
        expect(retry.nextAttemptAt).toBeGreaterThan(retry.createdAt);
        const targetBinding = { fs, rootPath: '/later' };
        const targetStore = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => targetBinding);
        await targetStore.createSession('later', { kind: 'later', locator: null });
        kernel.registerStorageResolver({ kind: 'later', async resolve() { return targetBinding; } });
        await targetStore.setSessionStatus(targetBinding, 'closing');
        await targetStore.setSessionStatus(targetBinding, 'closed');
        expect(await kernel.relayPendingMessages()).toBe(0);
        expect((await source.outbox())[0].rejection?.code).toBe('target-closed');
        expect(await store.pendingOutbox(binding)).toEqual([]);
    });

    it('expires a message to a never-created session and allows the source to close', async () => {
        const source = await kernel.openSession('s');
        const rejected = await source.sendToSession('never-created', 'topic', null, { expiresAt: 0 });
        expect(rejected.status).toBe('rejected');
        expect(rejected.rejection?.code).toBe('expired');
        await kernel.closeSession('s', false);
        expect((await store.sessionRecord(binding)).status).toBe('closed');
    });

    it('preserves wait registrations newer than the recovery task snapshot', async () => {
        const target = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const waiter = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        await store.commitTask(binding, claim, { ...claim.task, status: 'waiting', currentAttempt: undefined,
            wait: { type: 'task', id: target.id } }, 'task.waiting');
        await fs.meta.seq!.transaction!(tx => recoverWaitGraphTx(tx, binding.rootPath, [target.id]));
        await store.cancelTask(binding, target.id);
        expect((await store.readTask(binding, waiter.id)).status).toBe('ready');
    });

    it('does not probe empty dependency and wait prefixes for every terminal Task', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 12; i++) {
            const task = await store.createTask(binding, 's', { ...spec, deferStart: true });
            await store.cancelTask(binding, task.id);
            ids.push(task.id);
        }
        await fs.meta.seq!.transaction!(async tx => {
            const prefixes: Array<string | undefined> = [];
            const tracked = new Proxy(tx, { get(target, key) {
                if (key !== 'walkEntries') return Reflect.get(target, key);
                return (...args: Parameters<typeof tx.walkEntries>) => {
                    prefixes.push(args[2]?.keyPrefix);
                    return tx.walkEntries(...args);
                };
            } });
            await recoverWaitGraphTx(tracked, binding.rootPath, ids);
            expect(prefixes.filter(prefix => prefix === 'edge/')).toHaveLength(1);
            expect(prefixes.filter(prefix => prefix === 'wait/task/')).toHaveLength(1);
            expect(prefixes.some(prefix => prefix?.startsWith('edge/') && prefix !== 'edge/')).toBe(false);
            expect(prefixes.some(prefix => prefix?.startsWith('wait/task/') && prefix !== 'wait/task/')).toBe(false);
        });
    });

    it('repairs lost wait and dependency indexes from durable records', async () => {
        const target = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const dependent = await store.createTask(binding, 's', { ...spec, dependsOn: [{ task: target.id, condition: 'terminal' }] });
        const waiter = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        expect(claim.task.id).toBe(waiter.id);
        await store.commitTask(binding, claim, { ...claim.task, status: 'waiting', currentAttempt: undefined,
            wait: { type: 'all', waits: [{ type: 'task', id: target.id }, { type: 'shared-version', key: 'a/b', afterVersion: 0 }] } }, 'task.waiting');
        await fs.meta.seq!.transaction!(async tx => {
            const keys: string[] = [];
            await tx.walkEntries('/session/graph.seq', row => { keys.push(row.key); return true; });
            for (const key of keys) await tx.deleteEntry('/session/graph.seq', key);
        });
        await store.cancelTask(binding, target.id);
        await store.setShared(binding, 'a/b', 'done');
        expect((await store.readTask(binding, waiter.id)).status).toBe('waiting');
        await store.recover(binding);
        expect((await store.readTask(binding, waiter.id)).status).toBe('ready');
        expect((await store.readTask(binding, dependent.id)).status).toBe('ready');
        const before = await store.readTask(binding, waiter.id);
        await store.recover(binding);
        expect((await store.readTask(binding, waiter.id)).pendingEvents).toEqual(before.pendingEvents);
    });

    it('keeps task exits observable when no waiter existed at completion', async () => {
        const target = await store.createTask(binding, 's', { ...spec, deferStart: true });
        await store.cancelTask(binding, target.id);
        const waiter = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        const next = await store.commitTask(binding, claim, { ...claim.task, status: 'waiting', currentAttempt: undefined,
            wait: { type: 'task', id: target.id } }, 'task.waiting');
        expect(next.status).toBe('ready');
        expect(next.pendingEvents).toContainEqual(expect.objectContaining({ type: 'task-exited', taskId: target.id }));
        await expect(store.readTask(binding, '../escape')).rejects.toThrow('Invalid object ID');
    });

    it('cleans missing dependants without rolling back target completion', async () => {
        const target = await store.createTask(binding, 's', { ...spec, deferStart: true });
        await fs.meta.seq!.setEntry('/session/graph.seq', `edge/${target.id}/missing`, JSON.stringify({ task: target.id }));
        await fs.meta.seq!.setEntry('/session/graph.seq', `wait/task/${target.id}/missing`, '{}');
        await store.cancelTask(binding, target.id);
        expect((await store.readTask(binding, target.id)).status).toBe('cancelled');
        expect(await fs.meta.seq!.getEntry('/session/graph.seq', `edge/${target.id}/missing`)).toBeNull();
        expect(await fs.meta.seq!.getEntry('/session/graph.seq', `wait/task/${target.id}/missing`)).toBeNull();
    });

    it('protects the kernel layout from rename, ancestor moves and deletion', async () => {
        await expect(fs.driver.rename('/session', 'renamed')).rejects.toMatchObject({ code: 'EBUSY' });
        const task = await store.createTask(binding, 's', spec);
        await expect(fs.driver.rename(`/session/tasks/${task.id}`, 'changed')).rejects.toMatchObject({ code: 'EBUSY' });
        await expect(fs.driver.delete(['/session'], { recursive: true })).rejects.toMatchObject({ code: 'EBUSY' });
        await fs.driver.createDirectory({ name: 'outside', parentPath: null });
        await expect(fs.driver.move(['/outside'], '/session/tasks')).rejects.toMatchObject({ code: 'EBUSY' });
        expect((await store.readTask(binding, task.id)).id).toBe(task.id);
    });

    it('removes Session storage and catalog entries only when nothing is live', async () => {
        kernel.registerProgram({ manifest: spec.program,
            init: () => ({ state: null, actions: [{ type: 'request-interaction', interaction: { id: 'never', kind: 'input', prompt: 'Answer' } }],
                next: { type: 'wait', on: { type: 'interaction', id: 'never' } } }),
            reduce: () => ({ state: null, next: { type: 'complete', output: 'done' } }),
        });
        const task = await (await kernel.openSession('s')).submit(spec);
        await vi.waitFor(async () => expect((await task.status()).task.interactions?.never?.status).toBe('pending'));

        // A live Task must keep the Session: removal refuses instead of destroying state.
        await expect(kernel.removeSession('s')).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await fs.driver.exists('/session')).toBe(true);

        await task.cancel();
        await task.wait({ timeoutMs: 1000 });
        await kernel.closeSession('s', true);
        expect(await kernel.removeSession('s')).toBe(true);
        expect(await fs.driver.exists('/session')).toBe(false);
        const ids: string[] = []; for await (const record of kernel.listSessions()) ids.push(record.id);
        expect(ids).not.toContain('s');
        expect(await fs.meta.seq!.getEntry('/catalog/catalog.seq', `task/${task.id}`)).toBeNull();
        expect(await kernel.removeSession('s')).toBe(false);
    });

    it('closes a Session only after the in-flight Effect confirms it stopped', async () => {
        let started!: () => void, release!: () => void, aborted = false;
        const begun = new Promise<void>(resolve => { started = resolve; });
        let inFlight: Promise<unknown> | undefined;
        kernel.registerEffect({
            kind: 'slow', version: '1',
            execute(_request, context) {
                started();
                // The external call does not stop on abort alone: it stays pending until
                // the test releases it, standing in for a process that needs a SIGKILL.
                const execution = new Promise<never>((_, reject) => {
                    context.abortSignal.addEventListener('abort', () => { aborted = true; release = () => reject(new Error('aborted')); }, { once: true });
                });
                inFlight = execution.catch(() => undefined);
                return execution;
            },
            // The adapter confirms the stop by settling the recorded execution.
            async cancel() { await inFlight; },
        });
        kernel.registerProgram({ manifest: spec.program,
            init: () => ({ state: null, actions: [{ type: 'effect', effect: {
                id: 'e', kind: 'slow', version: '1', request: null, idempotencyKey: 'slow',
            } }], next: { type: 'wait', on: { type: 'effect', id: 'e' } } }),
            reduce() { throw new Error('unexpected'); },
        });
        const task = await (await kernel.openSession('s')).submit(spec);
        await begun;

        // `cancelRunning` must cancel live work and may only report completion once the
        // adapter confirms the external Effect stopped (not merely that it was signalled).
        let closed = false;
        const closing = kernel.closeSession('s', true).then(() => { closed = true; });
        await vi.waitFor(() => expect(aborted).toBe(true));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(closed).toBe(false);

        release();
        await closing;
        expect(closed).toBe(true);
        const record = (await task.status()).task;
        expect(record.status).toBe('cancelled');
        expect(Object.values(record.effects).every(effect => !effect.cleanupPending)).toBe(true);
        expect((await kernel.sessionStat('s')).phase).toBe('closed');

        // The terminal state is durable: a fresh Kernel sees the same closed Session.
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
        expect((await kernel.sessionStat('s')).phase).toBe('closed');
    });

    it('does not resurrect records when a removed Session identity is reused', async () => {
        const session = await kernel.openSession('s');
        await session.setShared('topic', { value: 'old' });
        await kernel.closeSession('s', true);
        expect(await kernel.removeSession('s')).toBe(true);
        expect(await fs.driver.exists('/session')).toBe(false);

        const recreated = await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        expect((await kernel.sessionStat('s')).phase).toBe('open');
        expect(await recreated.getShared('topic')).toBeUndefined();
        expect(await fs.meta.seq!.getEntry('/session/session.seq', 'record')).toContain('"status":"open"');
    });

    it('repeats an interrupted removal safely and starts the reused identity empty', async () => {
        const session = await kernel.openSession('s');
        await session.setShared('keep', 'stale');
        // Simulate a crash after the storage tree was deleted, before cleanup ran.
        await fs.driver.updateMetadata('/session', { vfsFixedLayout: false });
        await fs.driver.delete(['/session'], { recursive: true });

        expect(await kernel.removeSession('s')).toBe(true);
        expect(await fs.meta.seq!.getEntry('/catalog/catalog.seq', 'session/s')).toBeNull();
        const recreated = await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        expect((await kernel.sessionStat('s')).phase).toBe('open');
        expect(await recreated.getShared('keep')).toBeUndefined();
    });

    it('resumes an interrupted removal after a Kernel restart', async () => {
        await (await kernel.openSession('s')).setShared('stale', 'value');
        await kernel.closeSession('s', true);
        // Interrupted removal: storage tree gone, records and catalog entry remain.
        await fs.driver.updateMetadata('/session', { vfsFixedLayout: false });
        await fs.driver.delete(['/session'], { recursive: true });
        kernel.dispose(); await kernel.waitIdle();

        // A restart has no cached binding, so cleanup must work from the catalog.
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        await kernel.initialize();
        expect((await kernel.sessionStat('s')).phase).toBe('closed');
        await kernel.closeSession('s', true);
        expect(await kernel.removeSession('s')).toBe(true);
        expect(await fs.meta.seq!.getEntry('/catalog/catalog.seq', 'session/s')).toBeNull();

        const recreated = await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
        expect((await kernel.sessionStat('s')).phase).toBe('open');
        expect(await recreated.getShared('stale')).toBeUndefined();
    });

    it('persists terminal delivery rejection and exposes it in outbox', async () => {
        const sender = await store.createTask(binding, 's', spec);
        const target = await store.createTask(binding, 's', { ...spec, deferStart: true });
        await store.cancelTask(binding, target.id);
        const message = await store.sendTaskMessage(binding, sender.id, { idempotencyKey: 'once',
            targetSessionId: 's', targetTaskId: target.id, topic: 'done', payload: null });
        expect(message.status).toBe('rejected');
        expect(message.rejection?.code).toBe('target-terminal');
        expect(await store.pendingOutbox(binding)).toEqual([]);
        expect(await store.deliverMessage(binding, message)).toBe(false);
        expect((await store.readTask(binding, target.id)).pendingEvents).toEqual([]);
        expect((await (await kernel.openSession('s')).outbox())[0].status).toBe('rejected');
    });

    it('retains arrivals before waiting and rejects an expired undelivered message', async () => {
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const target = await store.createTask(binding, 's', spec);
        await store.sendTaskMessage(binding, sender.id, { idempotencyKey: 'early', targetSessionId: 's', targetTaskId: target.id, topic: 'early', payload: null });
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        const next = await store.commitTask(binding, claim, { ...claim.task, status: 'waiting', currentAttempt: undefined,
            wait: { type: 'message', topic: 'early' } }, 'task.waiting');
        expect(next.status).toBe('ready');
        const expired = await store.sendTaskMessage(binding, sender.id, { idempotencyKey: 'expired', targetSessionId: 's', targetTaskId: 'not-created', topic: 'late', payload: null, expiresAt: 0 });
        expect(expired.rejection?.code).toBe('expired');
    });

    it('preserves arrivals while the owning reducer commits and renews', async () => {
        const task = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        await store.signalTask(binding, task.id, { type: 'follow-up', payload: 'new' });
        expect(await store.renewLease(binding, claim, 10_000)).toBe(true);
        const next = await store.commitTask(binding, claim, { ...claim.task, state: 1, initialized: true, status: 'waiting', currentAttempt: undefined, wait: { type: 'signal' } }, 'task.waiting');
        expect(next.status).toBe('ready');
        expect(next.pendingEvents).toEqual([expect.objectContaining({ type: 'signal', signal: { type: 'follow-up', payload: 'new' } })]);
    });

    it('propagates terminal dependency failures through the graph and waiters', async () => {
        const a = await store.createTask(binding, 's', spec);
        const b = await store.createTask(binding, 's', { ...spec, dependsOn: [{ task: a.id }] });
        const c = await store.createTask(binding, 's', { ...spec, dependsOn: [{ task: b.id }] });
        await store.cancelTask(binding, a.id);
        expect((await store.readTask(binding, c.id)).status).toBe('failed');
        expect((await store.events(binding)).filter(e => e.type === 'task.failed').map(e => e.taskId)).toEqual([b.id, c.id]);
        await expect(store.createTask(binding, 's', { ...spec, dependsOn: [{ task: 'missing' }] })).rejects.toThrow('Dependency not found');
        await expect(store.createTask(binding, 's', { ...spec, dependsOn: [{ task: a.id }, { task: a.id }] })).rejects.toThrow('Duplicate');
    });

    it('executes internal steps and retries the first failure after many successes', async () => {
        let failed = false;
        const program: DurableTaskProgram<number> = {
            manifest: spec.program,
            init() { return { state: 0, next: { type: 'continue' } }; },
            reduce(state) {
                if (state === 10 && !failed) { failed = true; throw new Error('transient'); }
                return state === 12 ? { state, next: { type: 'complete', output: state } }
                    : { state: state + 1, next: { type: 'continue' } };
            },
        };
        kernel.registerProgram(program);
        const session = await kernel.openSession('s');
        const task = await session.submit({ ...spec, retry: { maxAttempts: 2 } });
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe(12);
        expect((await task.attempts()).filter(a => a.outcome === 'failed')).toHaveLength(1);
    });

    it('fences old decisions and abandonment across a pause/resume', async () => {
        const task = await store.createTask(binding, 's', spec);
        const old = (await store.claimReady(binding, 'old', 10_000))!;
        const pause = await store.controlTask(binding, task.id, 'pause', { requestId: 'pause' });
        expect(pause.acknowledged).toBe(true);
        expect(await store.claimReady(binding, 'new', 10_000)).toBeUndefined();
        await store.signalTask(binding, task.id, { type: 'input' });
        await store.controlTask(binding, task.id, 'run', { requestId: 'resume', expectedEpoch: pause.epoch });
        const current = (await store.claimReady(binding, 'new', 10_000))!;
        await store.abandonClaim(binding, old);
        await expect(store.commitTask(binding, old, { ...old.task, status: 'ready' }, 'task.ready')).rejects.toThrow('Stale');
        expect((await store.readTask(binding, task.id)).currentAttempt?.id).toBe(current.attempt.id);
    });

    it('captures the first shared revision through pause, deletion and recovery', async () => {
        const task = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        await store.commitTask(binding, claim, { ...claim.task, state: null, initialized: true, status: 'waiting', currentAttempt: undefined,
            wait: { type: 'shared-version', key: 'result', afterVersion: 0 } }, 'task.waiting');
        await store.controlTask(binding, task.id, 'pause', { requestId: 'pause' });
        await store.setShared(binding, 'result', 'v1');
        await store.setShared(binding, 'result', 'v2');
        await store.deleteShared(binding, 'result');
        await store.recover(binding);
        const current = await store.readTask(binding, task.id);
        expect(current.pendingEvents).toEqual([{ type: 'shared-changed', revision: expect.objectContaining({ version: 1, value: 'v1' }) }]);
        expect(await store.claimReady(binding, 'w', 10_000)).toBeUndefined();
    });

    it('hydrates timers durably even when polling starts before their deadline', async () => {
        const task = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10_000))!;
        await store.commitTask(binding, claim, { ...claim.task, state: null, status: 'waiting', currentAttempt: undefined,
            wait: { type: 'timer', id: 'alarm', at: Date.now() + 10 } }, 'task.waiting');
        await new Promise(resolve => setTimeout(resolve, 20));
        await store.sweep(binding);
        expect((await store.readTask(binding, task.id)).status).toBe('ready');
    });

    it('preserves successful effects and refuses unsafe replay', async () => {
        const task = await store.createTask(binding, 's', spec);
        const request = { id: 'effect', kind: 'write', version: '1', idempotencyKey: 'key', request: null, timeoutMs: 100 };
        const original = addEffect(task, request); original.effects.effect.status = 'succeeded';
        expect(addEffect(original, request).effects.effect.status).toBe('succeeded');
        expect(() => addEffect(original, { ...request, request: 'different' })).toThrow('conflict');
        let executions = 0;
        const completion = await executeEffectAdapter({ kind: 'write', version: '1', async execute() { executions++; return null; } }, request,
            { taskId: task.id, effectId: 'effect', effect: { ...original.effects.effect, attempts: [{ outcome: 'lost' } as any] } },
            { sessionId: 's', taskId: task.id, effectId: 'effect', grants: [], abortSignal: new AbortController().signal });
        expect(executions).toBe(0); expect(completion.indeterminate).toBe(true);
    });

    it('selects authorized cache sources and preserves receipts after invalidation', async () => {
        const task = await store.createTask(binding, 's', spec);
        const other = await store.createTask(binding, 's', spec);
        const { namespace, handle } = await store.createCache(binding, task.id, { name: 'parsed' });
        await store.publishCache(binding, task.id, { operationId: 'publish', handleId: handle.id, key: 'file', fingerprint: 'hash-v1', value: { ast: 1 }, expectedGeneration: 1 });
        const request = { operationId: 'read', sources: [{ handleId: handle.id, key: 'file', fingerprint: 'hash-v1' }] };
        expect((await store.readCache(binding, task.id, request)).value).toEqual({ ast: 1 });
        await expect(store.readCache(binding, other.id, request)).rejects.toThrow('holder mismatch');
        await store.invalidateCache(binding, task.id, handle.id, namespace.generation);
        expect((await store.readCache(binding, task.id, request)).value).toEqual({ ast: 1 });
        expect((await store.readCache(binding, task.id, { ...request, operationId: 'new-read' })).status).toBe('miss');
        await expect(store.publishCache(binding, task.id, { operationId: 'stale', handleId: handle.id, key: 'file', fingerprint: 'hash-v1', value: 2, expectedGeneration: 1 })).rejects.toThrow('generation conflict');
    });

    it('takes single-use cache atomically and replays only the winning receipt', async () => {
        const a = await store.createTask(binding, 's', spec), b = await store.createTask(binding, 's', spec);
        const { handle } = await store.createCache(binding, a.id, { name: 'once', usage: 'single-use', scope: 'session' });
        const shared = await store.grantResource(binding, 'shared-handle', handle.id, b.id, ['read']);
        await store.publishCache(binding, a.id, { operationId: 'put', handleId: handle.id, key: 'key', fingerprint: 'v1', value: 'result', expectedGeneration: 1 });
        const request = (handleId: string) => ({ operationId: 'take', sources: [{ handleId, key: 'key', fingerprint: 'v1' }] });
        const results = await Promise.all([store.readCache(binding, a.id, request(handle.id)), store.readCache(binding, b.id, request(shared.id))]);
        expect(results.map(r => r.status).sort()).toEqual(['hit', 'miss']);
        expect(await store.readCache(binding, a.id, request(handle.id))).toEqual(results[0]);
        expect(await store.readCache(binding, b.id, request(shared.id))).toEqual(results[1]);
    });

    it.each(['prefer-cache', 'cache-only', 'refresh', 'bypass'] as const)('validates every cache source in %s mode before consumption', async mode => {
        const a = await store.createTask(binding, 's', spec), b = await store.createTask(binding, 's', spec);
        const own = await store.createCache(binding, a.id, { name: 'own', usage: 'single-use' });
        const privateCache = await store.createCache(binding, b.id, { name: 'private' });
        await store.publishCache(binding, a.id, { operationId: 'put', handleId: own.handle.id, key: 'key', fingerprint: 'v1', value: 'one-shot', expectedGeneration: 1 });
        const source = { handleId: own.handle.id, key: 'key', fingerprint: 'v1' };
        await expect(store.readCache(binding, a.id, { operationId: 'read', mode,
            sources: [source, { ...source, handleId: privateCache.handle.id }] })).rejects.toThrow('holder mismatch');
        const valid = await store.readCache(binding, a.id, { operationId: 'read', sources: [source] });
        expect(valid).toMatchObject({ status: 'hit', value: 'one-shot' });
    });

    it('rejects unknown cache modes and invalid source versions without writing receipts', async () => {
        const task = await store.createTask(binding, 's', spec);
        const { handle } = await store.createCache(binding, task.id, { name: 'own' });
        const request = { operationId: 'read', sources: [{ handleId: handle.id, key: 'key', fingerprint: 'v1' }] };
        await expect(store.readCache(binding, task.id, { ...request, mode: 'unknown' as any })).rejects.toThrow('mode');
        await expect(store.readCache(binding, task.id, { ...request, sources: [{ ...request.sources[0], expectedVersion: -1 }] })).rejects.toThrow('version');
        expect((await store.readCache(binding, task.id, request)).status).toBe('miss');
    });

    it.each(['prefer-cache', 'cache-only'] as const)('serves a live entry in %s mode', async mode => {
        const task = await store.createTask(binding, 's', spec);
        const { handle } = await store.createCache(binding, task.id, { name: `serve-${mode}` });
        await store.publishCache(binding, task.id, { operationId: 'put', handleId: handle.id, key: 'key', fingerprint: 'v1', value: 'cached', expectedGeneration: 1 });

        const receipt = await store.readCache(binding, task.id, { operationId: `read-${mode}`, mode,
            sources: [{ handleId: handle.id, key: 'key', fingerprint: 'v1' }] });
        expect(receipt).toMatchObject({ status: 'hit', value: 'cached' });
    });

    it.each(['refresh', 'bypass'] as const)('never serves an entry in %s mode and leaves a single-use entry unconsumed', async mode => {
        const task = await store.createTask(binding, 's', spec);
        const { handle } = await store.createCache(binding, task.id, { name: `skip-${mode}`, usage: 'single-use' });
        await store.publishCache(binding, task.id, { operationId: 'put', handleId: handle.id, key: 'key', fingerprint: 'v1', value: 'cached', expectedGeneration: 1 });

        const receipt = await store.readCache(binding, task.id, { operationId: `read-${mode}`, mode,
            sources: [{ handleId: handle.id, key: 'key', fingerprint: 'v1' }] });
        expect(receipt.status).toBe('bypass');
        expect(receipt.value).toBeUndefined();
        // A skipped read must not consume the single-use entry.
        expect(await store.readCache(binding, task.id, { operationId: 'take',
            sources: [{ handleId: handle.id, key: 'key', fingerprint: 'v1' }] }))
            .toMatchObject({ status: 'hit', value: 'cached' });
    });

    it('misses when the dependency fingerprint or expected version no longer matches', async () => {
        const task = await store.createTask(binding, 's', spec);
        const { handle } = await store.createCache(binding, task.id, { name: 'dependency' });
        const publish = (operationId: string, value: string, expectedVersion?: number) => store.publishCache(binding, task.id, {
            operationId, handleId: handle.id, key: 'key', fingerprint: 'hash-v1', value, expectedGeneration: 1,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        const read = (operationId: string, fingerprint: string, expectedVersion?: number) => store.readCache(binding, task.id, {
            operationId, sources: [{ handleId: handle.id, key: 'key', fingerprint,
                ...(expectedVersion === undefined ? {} : { expectedVersion }) }],
        });

        expect((await publish('put-1', 'one')).version).toBe(1);
        expect(await read('r-v1', 'hash-v1')).toMatchObject({ status: 'hit', value: 'one', entryVersion: 1 });
        // A changed dependency fingerprint invalidates the cached derivation.
        expect(await read('r-v2', 'hash-v2')).toMatchObject({ status: 'miss' });

        expect((await publish('put-2', 'two', 1)).version).toBe(2);
        // The consumer that pinned the previous entry version must not observe the new one.
        expect(await read('r-old', 'hash-v1', 1)).toMatchObject({ status: 'miss' });
        expect(await read('r-new', 'hash-v1', 2)).toMatchObject({ status: 'hit', value: 'two', entryVersion: 2 });
    });

    it('rejects overflowing cache deadlines and generation increments atomically', async () => {
        const task = await store.createTask(binding, 's', spec);
        await expect(store.createCache(binding, task.id, { name: 'invalid', ttlMs: Number.MAX_VALUE })).rejects.toThrow('TTL');
        const { namespace, handle } = await store.createCache(binding, task.id, { name: 'valid' });
        await expect(store.renewCache(binding, task.id, handle.id, 1, Number.MAX_VALUE)).rejects.toThrow('TTL');
        const key = `cache/namespace/${namespace.id}`;
        const path = '/session/resources.seq';
        await fs.meta.seq!.setEntry(path, key, JSON.stringify({ ...namespace, generation: Number.MAX_SAFE_INTEGER }));
        await expect(store.invalidateCache(binding, task.id, handle.id, Number.MAX_SAFE_INTEGER)).rejects.toThrow('generation exhausted');
        await expect(store.renewCache(binding, task.id, handle.id, Number.MAX_SAFE_INTEGER, 1000)).rejects.toThrow('generation exhausted');
        expect(JSON.parse((await fs.meta.seq!.getEntry(path, key))!).generation).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('commits cache selection and its wake input with the decision', async () => {
        const t = await store.createTask(binding, 's', spec);
        const { handle } = await store.createCache(binding, t.id, { name: 'own' });
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        const request = { operationId: 'selection', sources: [{ handleId: handle.id, key: 'key', fingerprint: 'v1' }] };
        const next: TaskRecord = { ...claim.task, state: null, status: 'waiting', currentAttempt: undefined, wait: { type: 'cache', operationId: 'selection' } };
        const committed = await store.commitTask(binding, claim, next, 'task.waiting', undefined, { cache: [
            { type: 'cache-publish', request: { operationId: 'put', handleId: handle.id, key: 'key', fingerprint: 'v1', value: 'cached', expectedGeneration: 1 } },
            { type: 'cache-read', request },
        ] });
        expect(committed.status).toBe('ready');
        expect(committed.pendingEvents).toEqual([{ type: 'cache-result', receipt: expect.objectContaining({ value: 'cached' }) }]);
    });

    it('deduplicates mailbox deliveries and commits consumption with a reply', async () => {
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const receiver = await store.createTask(binding, 's', spec);
        const init = (await store.claimReady(binding, 'w', 10000))!;
        await store.commitTask(binding, init, { ...init.task, initialized: true, state: null, status: 'waiting', currentAttempt: undefined, wait: { type: 'message', topic: 'request' } }, 'task.waiting');
        const request = { idempotencyKey: 'one', targetSessionId: 's', targetTaskId: receiver.id, topic: 'request', payload: 'work' };
        const message = await store.sendTaskMessage(binding, sender.id, request);
        await store.sendTaskMessage(binding, sender.id, request);
        expect((await store.readTask(binding, receiver.id)).pendingEvents).toHaveLength(1);
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        const next: TaskRecord = { ...claim.task, pendingEvents: [], status: 'waiting', currentAttempt: undefined, wait: { type: 'signal' } };
        const reply = { idempotencyKey: 'reply', targetSessionId: 's', targetTaskId: sender.id, topic: 'reply', correlationId: message.id, payload: 'done' };
        await store.commitTask(binding, claim, next, 'task.waiting', undefined, { messages: [reply] });
        expect((await store.inbox(binding)).find(m => m.id === message.id)?.consumedAt).toBeTypeOf('number');
        expect((await store.readTask(binding, sender.id)).pendingEvents).toEqual([expect.objectContaining({ type: 'message', message: expect.objectContaining({ payload: 'done', correlationId: message.id }) })]);
        await expect(store.sendTaskMessage(binding, sender.id, { ...request, payload: 'changed' })).rejects.toThrow('identity conflict');
    });

    it('delivers cross-session Task messages idempotently after acknowledgement loss', async () => {
        const targetBinding = { fs, rootPath: '/target' };
        const targetStore = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => targetBinding);
        await targetStore.createSession('target', { kind: 'test', locator: { rootPath: '/target' } });
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const receiver = await targetStore.createTask(targetBinding, 'target', { ...spec, deferStart: true });
        const request = { idempotencyKey: 'one', targetSessionId: 'target', targetTaskId: receiver.id, topic: 'work', payload: null };
        const message = await store.sendTaskMessage(binding, sender.id, request);
        expect(message.status).toBe('pending');
        expect(await targetStore.deliverMessage(targetBinding, message)).toBe(true);
        await targetStore.cancelTask(targetBinding, receiver.id);
        expect(await targetStore.deliverMessage(targetBinding, message)).toBe(false);
        expect((await targetStore.messageReceipt(targetBinding, message.id)).status).toBe('delivered');
        const settled = await store.markMessageDelivered(binding, message.id);
        await targetStore.acknowledgeMessageSettlement(targetBinding, settled, 'inbox');
        await store.acknowledgeMessageSettlement(binding, settled, 'outbox');
        expect((await targetStore.readTask(targetBinding, receiver.id)).pendingEvents).toHaveLength(1);
        expect(await store.pendingOutbox(binding)).toHaveLength(0);
    });

    it.each([false, true].flatMap(crossSession => [false, true].map(saved => ({ crossSession, saved }))))(
    'persists ancestor-cancelled message rejection and preserves delivery replay: %j', async ({ crossSession, saved }) => {
        const targetBinding = crossSession ? { fs, rootPath: '/target' } : binding;
        const targetSession = crossSession ? 'target' : 's';
        const targetStore = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => targetBinding);
        if (crossSession) await targetStore.createSession(targetSession, { kind: 'test', locator: { rootPath: '/target' } });
        const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const parent = await store.createTask(targetBinding, targetSession, { ...spec, deferStart: true });
        const receiver = await store.createTask(targetBinding, targetSession, { ...spec, parent: parent.id, deferStart: true });
        const request = { idempotencyKey: 'one', targetSessionId: targetSession, targetTaskId: receiver.id, topic: 'work', payload: null };
        if (!saved) await store.cancelTask(targetBinding, parent.id);
        const before = await store.readTask(targetBinding, receiver.id);
        const message = await store.sendTaskMessage(binding, sender.id, request);
        if (crossSession) await store.deliverMessage(targetBinding, message);
        if (saved) await store.cancelTask(targetBinding, parent.id);
        const receipt = await store.messageReceipt(targetBinding, message.id);
        expect(receipt.status).toBe(saved ? 'delivered' : 'rejected');
        if (!saved) {
            expect(receipt.rejection?.code).toBe('target-ancestor-cancelled');
            expect(await store.readTask(targetBinding, receiver.id)).toEqual(before);
        }
        const events = await store.events(targetBinding), after = await store.readTask(targetBinding, receiver.id);
        expect(await store.deliverMessage(targetBinding, message)).toBe(false);
        expect(await store.messageReceipt(targetBinding, message.id)).toEqual(receipt);
        expect(await store.events(targetBinding)).toEqual(events);
        expect(await store.readTask(targetBinding, receiver.id)).toEqual(after);
    });

    it('prunes old Task events and reports the retention watermark for resync', async () => {
        const task = await store.createTask(binding, 's', spec);
        for (let step = 0; step < 4; step++) await store.signalTask(binding, task.id, { type: 'external', payload: { step } });
        const full = await store.taskEventPage(binding, task.id, { limit: 500 });
        expect(full.items.length).toBeGreaterThanOrEqual(4);
        expect(full.firstAvailableIndex).toBeUndefined();
        const total = full.throughIndex;
        const kept = 2;
        const before = await store.readTask(binding, task.id);

        const pruned = await store.pruneTaskEvents(binding, task.id, { keepEvents: kept });
        expect(pruned.removed).toBe(total - kept);
        expect(pruned.firstAvailableIndex).toBe(total - kept + 1);
        // A fresh read starts at the retained window and announces the watermark.
        const page = await store.taskEventPage(binding, task.id, { limit: 500 });
        expect(page.firstAvailableIndex).toBe(pruned.firstAvailableIndex);
        // The retained window keeps the newest `kept` events plus the prune event itself.
        expect(page.items.slice(0, kept).map(event => event.sequence))
            .toEqual(full.items.slice(-kept).map(event => event.sequence));
        expect(page.items.at(-1)?.type).toBe('task.events.pruned');
        // A stale cursor resyncs instead of reading missing events.
        const stale = await store.taskEventPage(binding, task.id, { afterIndex: 0, limit: 500 });
        expect(stale.items.map(event => event.sequence)).toEqual(page.items.map(event => event.sequence));
        // Pruned rows are gone from the raw log; the Task record and its history remain.
        const sequences = (await store.events(binding)).map(event => event.sequence);
        expect(sequences).not.toContain(full.items[0].sequence);
        expect((await store.readTask(binding, task.id)).version).toBe(before.version);
        expect((await store.taskHistory(binding, task.id)).length).toBeGreaterThan(0);
        // Re-running may prune the previous audit event because it is also indexed.
        const again = await store.pruneTaskEvents(binding, task.id, { keepEvents: kept });
        expect(again.removed).toBeLessThanOrEqual(1);
        await fs.meta.seq!.setEntry(eventsPath(binding.rootPath), taskEventFirstKey(task.id), '99999');
        await expect(store.taskEventPage(binding, task.id)).rejects.toThrow('retention watermark');
        await expect(store.pruneTaskEvents(binding, task.id)).rejects.toThrow('retention watermark');
    });

    it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid event retention count %s', async keepEvents => {
        const task = await store.createTask(binding, 's', spec);
        const before = await store.events(binding);
        await expect(store.pruneTaskEvents(binding, task.id, { keepEvents })).rejects.toThrow('keepEvents');
        expect(await store.events(binding)).toEqual(before);
    });

    it('refuses to delete another Task event through a corrupt retention index', async () => {
        const task = await store.createTask(binding, 's', spec);
        await store.signalTask(binding, task.id, { type: 'advance' });
        const other = await store.createTask(binding, 's', spec);
        const before = await store.events(binding);
        const foreign = before.find(event => event.taskId === other.id)!;
        await fs.meta.seq!.setEntry(eventsPath(binding.rootPath), taskEventKey(task.id, 1), String(foreign.sequence));
        await expect(store.pruneTaskEvents(binding, task.id, { keepEvents: 1 })).rejects.toThrow('scope mismatch');
        expect(await store.events(binding)).toEqual(before);
        expect(await fs.meta.seq!.getEntry(eventsPath(binding.rootPath), taskEventFirstKey(task.id))).toBeNull();
    });

    it('compacts Task version history without touching the authoritative record or facts', async () => {
        const task = await store.createTask(binding, 's', spec);
        // Every versioned write records a snapshot; signals advance the record cheaply.
        for (let step = 0; step < 4; step++) {
            await store.signalTask(binding, task.id, { type: 'external', payload: { step } });
        }
        const before = await store.readTask(binding, task.id);
        const versions = (await store.taskHistory(binding, task.id)).map(item => item.version);
        expect(versions[0]).toBe(0);
        expect(versions).toHaveLength(before.version + 1);

        // Keep the newest two snapshots; the main record stays authoritative.
        const oldest = versions[0];
        const compacted = await store.compactTaskHistory(binding, task.id, { keepVersions: 2 });
        expect(compacted.keptFrom).toBe(before.version - 1);
        expect(compacted.removed).toBe(versions.length - 2);
        expect((await store.taskHistory(binding, task.id)).map(item => item.version))
            .toEqual([before.version - 1, before.version]);
        expect(await store.readTask(binding, task.id)).toEqual(before);
        // A pruned version is simply unavailable; the retained window still reads.
        expect(await store.taskHistoryPage(binding, task.id, { afterVersion: -1, throughVersion: oldest }))
            .toMatchObject({ items: [] });
        expect((await store.taskHistoryPage(binding, task.id, { afterVersion: before.version - 1 })).items)
            .toHaveLength(1);
        expect((await store.events(binding)).some(event => event.type === 'task.history.compacted')).toBe(true);
        // Compacting again is a no-op.
        expect(await store.compactTaskHistory(binding, task.id, { keepVersions: 2 })).toEqual({ removed: 0, keptFrom: compacted.keptFrom });
        // The default window keeps everything at this size.
        expect(await store.compactTaskHistory(binding, task.id)).toEqual({ removed: 0, keptFrom: 0 });
        expect((await store.taskAttempts(binding, task.id))).toEqual([]);
    });

    it.each([0, 2, 100])('preserves both retention limits when beforeVersion is %s', async beforeVersion => {
        const task = await store.createTask(binding, 's', spec);
        for (let step = 0; step < 4; step++) await store.signalTask(binding, task.id, { type: 'advance' });
        const result = await store.compactTaskHistory(binding, task.id, { keepVersions: 2, beforeVersion });
        const retained = (await store.taskHistory(binding, task.id)).map(item => item.version);
        expect(retained).toEqual(beforeVersion === 0 ? [0, 1, 2, 3, 4] : beforeVersion === 2 ? [2, 3, 4] : [3, 4]);
        expect(result.removed).toBe(5 - retained.length);
    });

    it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid history retention count %s without deleting data', async keepVersions => {
        const task = await store.createTask(binding, 's', spec);
        const history = await store.taskHistory(binding, task.id);
        await expect(store.compactTaskHistory(binding, task.id, { keepVersions })).rejects.toThrow('keepVersions');
        expect(await store.taskHistory(binding, task.id)).toEqual(history);
    });

    it.each([-1, 1.5, NaN, Infinity])('rejects invalid history version boundary %s', async beforeVersion => {
        const task = await store.createTask(binding, 's', spec);
        await expect(store.compactTaskHistory(binding, task.id, { beforeVersion })).rejects.toThrow('beforeVersion');
        expect((await store.taskHistory(binding, task.id)).map(item => item.version)).toEqual([0]);
    });

    it('declares a layout manifest and refuses Sessions it cannot interpret', async () => {
        const record = await store.sessionRecord(binding);
        expect(record.layout).toMatchObject({ layoutVersion: 1, migration: { status: 'complete', to: 1 } });
        expect(record.layout?.recordSchemas).toHaveProperty('task');
        expect(record.layout?.requiredCapabilities).toContain('atomic-cas');

        await (await kernel.openSession('s')).setShared('probe', { ok: true });
        // A record written by a newer host must not be guessed at.
        const rewrite = (layout: unknown): Promise<void> => fs.meta.seq!.setEntry(
            sessionPath(binding.rootPath), 'record', JSON.stringify({ ...record, layout }));
        await rewrite({ ...record.layout, layoutVersion: 2 });
        await expect(kernel.openSession('s')).rejects.toThrow('Unsupported Session layout version 2');
        await expect(store.listShared(binding)).rejects.toThrow('Unsupported Session layout version 2');

        await rewrite({ ...record.layout, requiredCapabilities: ['transactional-seq', 'streams'] });
        await expect(kernel.openSession('s')).rejects.toThrow("unsupported storage capability 'streams'");

        await rewrite({ ...record.layout, migration: { status: 'pending', to: 2 } });
        await expect(kernel.openSession('s')).rejects.toThrow('migration is pending');

        for (const layout of [null, false, {},
            { ...record.layout, recordSchemas: { ...record.layout!.recordSchemas, task: 2 } },
            { ...record.layout, recordSchemas: {} },
            { ...record.layout, requiredCapabilities: undefined },
            { ...record.layout, migration: { status: 'complete', to: 2 } },
        ]) {
            await rewrite(layout);
            await expect(kernel.openSession('s')).rejects.toThrow();
            await expect(store.listShared(binding)).rejects.toThrow();
            await expect(store.setShared(binding, 'probe', { ok: false })).rejects.toThrow();
        }

        // A legacy record without a manifest still opens and works.
        await rewrite(undefined);
        const legacy = await kernel.openSession('s');
        expect((await store.sessionRecord(binding)).layout).toBeUndefined();
        expect((await legacy.getShared('probe'))?.value).toEqual({ ok: true });
    });

    it.each([false, true])('fences messages from cancelled ancestors while preserving queued replay: saved=%s', async saved => {
        const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const sender = await store.createTask(binding, 's', { ...spec, parent: parent.id, deferStart: true });
        const receiver = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const request = { idempotencyKey: 'one', targetSessionId: 's', targetTaskId: receiver.id, topic: 'work', payload: null };
        const queued = saved ? await store.sendTaskMessage(binding, sender.id, request) : undefined;
        await store.cancelTask(binding, parent.id);
        const before = await store.readTask(binding, receiver.id), events = await store.events(binding);
        const inbox = await store.inbox(binding), outbox = await store.outbox(binding);
        if (saved) {
            expect(await store.sendTaskMessage(binding, sender.id, request)).toEqual(queued);
            await expect(store.sendTaskMessage(binding, sender.id, { ...request, topic: 'changed' })).rejects.toThrow('identity conflict');
        } else await expect(store.sendTaskMessage(binding, sender.id, request)).rejects.toThrow('ancestor cancelled');
        expect(await store.readTask(binding, receiver.id)).toEqual(before);
        expect(await store.events(binding)).toEqual(events);
        expect(await store.inbox(binding)).toEqual(inbox);
        expect(await store.outbox(binding)).toEqual(outbox);
    });

    it.each(['sweep', 'recover'] as const)('propagates ancestor cancellation in one %s before lease recovery', async operation => {
        const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const child = await store.createTask(binding, 's', { ...spec, parent: parent.id, deferStart: true });
        const leaf = await store.createTask(binding, 's', { ...spec, parent: child.id });
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        const next = addEffect({ ...claim.task, initialized: true, state: null, status: 'waiting' as const,
            currentAttempt: undefined, wait: { type: 'effect' as const, id: 'e' } },
        { id: 'e', kind: 'x', version: '1', request: null, idempotencyKey: 'e', timeoutMs: 60000 });
        await store.commitTask(binding, claim, next, 'task.waiting');
        await store.claimEffect(binding, leaf.id, 'e', 'w', 1);
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.cancelTask(binding, parent.id);
        const ids = [leaf.id, child.id, parent.id];
        const listing = vi.spyOn(store, 'listTasks').mockImplementation(async () => Promise.all(ids.map(id => store.readTask(binding, id))));
        await store[operation](binding);
        listing.mockRestore();
        expect((await store.readTask(binding, child.id)).status).toBe('cancelled');
        const cancelled = await store.readTask(binding, leaf.id);
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.effects.e).toMatchObject({ status: 'cancelled', cleanupPending: true });
        expect(cancelled.effects.e.currentAttempt).toBeUndefined();
        const events = await store.events(binding);
        await store[operation](binding);
        expect(await store.readTask(binding, leaf.id)).toEqual(cancelled);
        expect(await store.events(binding)).toEqual(events);
    });

    it('recovers a lease at its deadline when it was valid as the new worker opened', async () => {
        const t = await store.createTask(binding, 's', { ...spec, retry: { maxAttempts: 2 } });
        await store.claimReady(binding, 'lost-worker', 30);
        kernel.registerProgram({ manifest: spec.program, init: () => ({ state: null, next: { type: 'complete', output: 'recovered' } }), reduce: () => { throw new Error('unexpected'); } });
        const session = await kernel.openSession('s');
        const handle = await session.attachTask(t.id);
        expect((await handle.wait({ timeoutMs: 2000 })).output).toBe('recovered');
        expect((await handle.attempts()).map(a => a.outcome)).toEqual(['lost', 'completed']);
    });

    it('does not resume an independently paused child when its parent resumes', async () => {
        const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const child = await store.createTask(binding, 's', { ...spec, parent: parent.id });
        await store.controlTask(binding, child.id, 'pause', { requestId: 'child-pause' });
        await store.controlTask(binding, parent.id, 'pause', { requestId: 'parent-pause' });
        await store.controlTask(binding, parent.id, 'run', { requestId: 'parent-resume' });
        expect((await store.readTask(binding, child.id)).control?.mode).toBe('pause');
        expect(await store.claimReady(binding, 'w', 10000)).toBeUndefined();
    });

    it.each(['create', 'start', 'start-signal', 'signal', 'pause', 'run', 'interrupt'] as const)(
    'rejects new descendant work after ancestor cancellation: %s', async operation => {
        const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const childSpec = { ...spec, parent: parent.id, deferStart: true, requestId: 'child' };
        const child = await store.createTask(binding, 's', childSpec);
        await store.controlTask(binding, child.id, 'pause', { requestId: 'original-pause' });
        await store.controlTask(binding, child.id, 'run', { requestId: 'original-run' });
        await store.cancelTask(binding, parent.id);
        const before = await store.readTask(binding, child.id), events = await store.events(binding);
        const actions = {
            create: () => store.createTask(binding, 's', { ...spec, parent: child.id, requestId: 'grandchild' }),
            start: () => store.startTask(binding, child.id),
            'start-signal': () => store.startTask(binding, child.id, { signal: { type: 'go' } }),
            signal: () => store.signalTask(binding, child.id, { type: 'go' }),
            pause: () => store.controlTask(binding, child.id, 'pause', { requestId: 'new' }),
            run: () => store.controlTask(binding, child.id, 'run', { requestId: 'new' }),
            interrupt: () => store.controlTask(binding, child.id, 'interrupt', { requestId: 'new' }),
        };
        await expect(actions[operation]()).rejects.toThrow('ancestor cancelled');
        expect((await store.createTask(binding, 's', childSpec)).id).toBe(child.id);
        await store.controlTask(binding, child.id, 'pause', { requestId: 'original-pause' });
        await store.controlTask(binding, child.id, 'run', { requestId: 'original-run' });
        expect(await store.readTask(binding, child.id)).toEqual(before);
        expect(await store.events(binding)).toEqual(events);
    });

    it.each([false, true])('fences descendant interaction responses while preserving resolved replay: saved=%s', async saved => {
        const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const task = await store.createTask(binding, 's', { ...spec, parent: parent.id, deferStart: true });
        const start = { signal: { type: 'initial' } };
        await store.startTask(binding, task.id, start);
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        await store.commitTask(binding, claim, { ...claim.task, initialized: true, state: null, status: 'waiting',
            pendingEvents: [], currentAttempt: undefined, wait: { type: 'interaction', id: 'answer' },
            interactions: { answer: { id: 'answer', kind: 'input', prompt: 'Answer', status: 'pending', requestedAt: Date.now() } },
        }, 'task.waiting');
        const response = { interactionId: 'answer', value: 'accepted' };
        if (saved) await store.resolveInteraction(binding, task.id, response);
        await store.cancelTask(binding, parent.id);
        const before = await store.readTask(binding, task.id), events = await store.events(binding);
        if (saved) {
            await store.resolveInteraction(binding, task.id, response);
            await expect(store.resolveInteraction(binding, task.id, { ...response, value: 'changed' })).rejects.toThrow('conflict');
        } else await expect(store.resolveInteraction(binding, task.id, response)).rejects.toThrow('ancestor cancelled');
        await store.startTask(binding, task.id, start);
        expect(await store.readTask(binding, task.id)).toEqual(before);
        expect(await store.events(binding)).toEqual(events);
    });

    it('fences cancelled effect event and shared-state writes', async () => {
        const t = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        const next = addEffect({ ...claim.task, state: null, status: 'waiting' as const, currentAttempt: undefined, wait: { type: 'effect' as const } }, { id: 'e', kind: 'x', version: '1', idempotencyKey: 'e', request: null, timeoutMs: 1000 });
        await store.commitTask(binding, claim, next, 'task.waiting');
        const effect = (await store.claimEffect(binding, t.id, 'e', 'w', 10000))!;
        await store.cancelTask(binding, t.id);
        await expect(store.appendEvent(binding, 's', t.id, 'late-chunk', 'data', effect)).rejects.toThrow('Stale effect');
        await expect(store.setShared(binding, 'late', 'data', { taskId: t.id }, effect)).rejects.toThrow('Stale effect');
        expect(await store.getShared(binding, 'late')).toBeUndefined();
    });

    it.each([
        { result: 'late-result' },
        { error: { message: 'late-failure' } },
        { error: { message: 'retry' }, retryable: true },
        { error: { message: 'unknown' }, indeterminate: true },
    ])('fences late effect completion after ancestor cancellation: %j', async outcome => {
        const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const child = await store.createTask(binding, 's', { ...spec, parent: parent.id, deferStart: true });
        const task = await store.createTask(binding, 's', { ...spec, parent: child.id });
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        expect(claim.task.id).toBe(task.id);
        const next = addEffect({ ...claim.task, state: null, status: 'waiting' as const,
            currentAttempt: undefined, wait: { type: 'effect' as const } },
        { id: 'e', kind: 'x', version: '1', idempotencyKey: 'e', request: null,
            timeoutMs: 60000, retry: { maxAttempts: 2, backoffMs: 0 } });
        await store.commitTask(binding, claim, next, 'task.waiting');
        const effect = (await store.claimEffect(binding, task.id, 'e', 'w', 10000))!;
        await store.cancelTask(binding, parent.id);
        const before = await store.readTask(binding, task.id), events = await store.events(binding);
        expect(before.status).toBe('waiting');
        expect(before.effects.e.status).toBe('leased');
        await expect(store.completeEffect(binding, task.id, 'e', effect.effect.currentAttempt!.leaseToken, outcome))
            .rejects.toThrow('Stale effect claim');
        expect(await store.readTask(binding, task.id)).toEqual(before);
        expect(await store.events(binding)).toEqual(events);
    });

    it('rejects a stale task-board claimant after reassignment', async () => {
        const session = await kernel.openSession('s');
        await session.createTaskBoardItem({ id: 'job', title: 'Job' });
        const taskA = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const taskB = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const a = await session.claimTaskBoardItem('job', taskA.id, { leaseMs: 1 });
        await new Promise(resolve => setTimeout(resolve, 5));
        const b = await session.claimTaskBoardItem('job', taskB.id);
        await expect(session.completeTaskBoardItem('job', a.leaseToken!, 'old')).rejects.toThrow();
        expect((await session.completeTaskBoardItem('job', b.leaseToken!, 'new')).result).toBe('new');
    });

    it('drains existing tasks before closing and forbids resurrection', async () => {
        const t = await store.createTask(binding, 's', spec);
        kernel.registerProgram({ manifest: spec.program, init: () => ({ state: null, next: { type: 'complete', output: null } }), reduce: () => { throw new Error('unexpected'); } });
        await kernel.closeSession('s', false);
        const handle = await kernel.openTask(t.id);
        expect((await handle.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        await expect.poll(async () => (await store.sessionRecord(binding)).status).toBe('closed');
        await expect(store.setSessionStatus(binding, 'open')).rejects.toThrow('Invalid session transition');
    });

    it('holds unknown effects for an idempotent manual resolution', async () => {
        const t = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        const next = addEffect({ ...claim.task, state: null, initialized: true, status: 'waiting' as const, currentAttempt: undefined, wait: { type: 'effect' as const, id: 'unknown' } },
            { id: 'unknown', kind: 'write', version: '1', request: null, idempotencyKey: 'unknown', timeoutMs: 1000 });
        await store.commitTask(binding, claim, next, 'task.waiting');
        const effect = (await store.claimEffect(binding, t.id, 'unknown', 'w', 10000))!;
        await store.completeEffect(binding, t.id, 'unknown', effect.effect.currentAttempt!.leaseToken, { error: { message: 'unknown' }, indeterminate: true });
        expect((await store.readTask(binding, t.id)).status).toBe('waiting');
        const resolution = { requestId: 'verified', effectId: 'unknown', outcome: { type: 'completed' as const, result: 'external-result' } };
        await store.resolveEffect(binding, t.id, resolution);
        await store.resolveEffect(binding, t.id, resolution);
        const current = await store.readTask(binding, t.id);
        expect(current.status).toBe('ready');
        expect(current.pendingEvents).toEqual([{ type: 'effect-completed', effectId: 'unknown', result: 'external-result' }]);
        await expect(store.resolveEffect(binding, t.id, { ...resolution, outcome: { type: 'completed', result: 'different' } })).rejects.toThrow('conflict');
    });

    it.each([
        { type: 'completed' as const, result: 'verified' },
        { type: 'failed' as const, error: { message: 'abandoned' } },
        { type: 'retry' as const },
    ].flatMap(outcome => [false, true].map(saved => ({ outcome, saved }))))(
    'fences new effect resolutions after ancestor cancellation and replays saved receipts: %j', async ({ outcome, saved }) => {
        const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const task = await store.createTask(binding, 's', { ...spec, parent: parent.id });
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        const next = addEffect({ ...claim.task, state: null, initialized: true, status: 'waiting' as const,
            currentAttempt: undefined, wait: { type: 'effect' as const, id: 'unknown' } },
        { id: 'unknown', kind: 'write', version: '1', request: null, idempotencyKey: 'unknown', timeoutMs: 60000 });
        await store.commitTask(binding, claim, next, 'task.waiting');
        const effect = (await store.claimEffect(binding, task.id, 'unknown', 'w', 10000))!;
        await store.completeEffect(binding, task.id, 'unknown', effect.effect.currentAttempt!.leaseToken,
            { error: { message: 'unknown' }, indeterminate: true });
        const request = { requestId: 'verified', effectId: 'unknown', outcome };
        if (saved) await store.resolveEffect(binding, task.id, request);
        await store.cancelTask(binding, parent.id);
        const before = await store.readTask(binding, task.id), events = await store.events(binding);
        if (saved) {
            await store.resolveEffect(binding, task.id, request);
            await expect(store.resolveEffect(binding, task.id, { ...request, effectId: 'different' })).rejects.toThrow('conflict');
        } else await expect(store.resolveEffect(binding, task.id, request)).rejects.toThrow('Task ancestor cancelled');
        expect(await store.readTask(binding, task.id)).toEqual(before);
        expect(await store.events(binding)).toEqual(events);
    });

    it('retries only explicitly replay-safe effects with persistent backoff', async () => {
        let calls = 0;
        kernel.registerEffect({ kind: 'safe', version: '1', recoveryPolicy: 'idempotent-retry', async execute() { if (++calls === 1) throw new Error('temporary'); return 'done'; } });
        kernel.registerProgram({ manifest: spec.program,
            init() { return { state: null, actions: [{ type: 'effect', effect: { id: 'e', kind: 'safe', version: '1', request: null, idempotencyKey: 'e', retry: { maxAttempts: 2, backoffMs: 5 } } }], next: { type: 'wait', on: { type: 'effect', id: 'e' } } }; },
            reduce(state, event) { return { state, next: { type: 'complete', output: event.type === 'effect-completed' ? event.result : 'wrong' } }; },
        });
        const session = await kernel.openSession('s'), task = await session.submit(spec);
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe('done');
        expect(calls).toBe(2);
        expect((await task.status()).task.effects.e.attempts.map(a => a.outcome)).toEqual(['failed', 'completed']);
    });

    it('keeps suspend pending until its external effect has settled', async () => {
        const t = await store.createTask(binding, 's', spec);
        const claim = (await store.claimReady(binding, 'w', 10000))!;
        await store.commitTask(binding, claim, addEffect({ ...claim.task, status: 'waiting' as const, currentAttempt: undefined, wait: { type: 'effect' as const } },
            { id: 'e', kind: 'x', version: '1', request: null, idempotencyKey: 'e', timeoutMs: 1000 }), 'task.waiting');
        const effect = (await store.claimEffect(binding, t.id, 'e', 'w', 10000))!;
        expect((await store.setSessionStatus(binding, 'suspended')).status).toBe('suspending');
        await store.completeEffect(binding, t.id, 'e', effect.effect.currentAttempt!.leaseToken, { result: 'settled' });
        expect((await store.setSessionStatus(binding, 'suspended')).status).toBe('suspended');
        expect(await store.claimReady(binding, 'w', 10000)).toBeUndefined();
        await store.setSessionStatus(binding, 'open');
        expect((await store.claimReady(binding, 'w', 10000))?.task.id).toBe(t.id);
    });

    it('reuses durable submission identities and rejects changed requests', async () => {
        const request = { ...spec, requestId: 'submit-once' };
        const [a, b] = await Promise.all([store.createTask(binding, 's', request), store.createTask(binding, 's', request)]);
        expect(a.id).toBe(b.id);
        expect(await store.listTasks(binding)).toHaveLength(1);
        await expect(store.createTask(binding, 's', { ...request, input: 'changed' })).rejects.toThrow('submission conflict');
        await expect(store.createSession('different-session', { kind: 'test', locator: null })).rejects.toThrow('already belongs');
        expect((await store.sessionRecord(binding)).id).toBe('s');
    });

    it('blocks missing program versions without destroying recoverable work', async () => {
        const session = await kernel.openSession('s'), task = await session.submit(spec);
        await expect.poll(async () => (await task.status()).task.blockedReason).toBe('program-unavailable');
        expect(await task.poll()).toBeUndefined();
        kernel.registerProgram({ manifest: spec.program, init: () => ({ state: null, next: { type: 'complete', output: 'restored' } }), reduce: () => { throw new Error('unexpected'); } });
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe('restored');
    });

    it('does not persist reducer mutations from a failed attempt', async () => {
        let failures = 0;
        const program: DurableTaskProgram<{ count: number }> = {
            manifest: spec.program, init: () => ({ state: { count: 0 }, next: { type: 'continue' } }),
            reduce(state) {
                if (failures++ === 0) { (state as { count: number }).count = 999; throw new Error('retry'); }
                return { state, next: { type: 'complete', output: state.count } };
            },
        };
        kernel.registerProgram(program);
        const session = await kernel.openSession('s'), task = await session.submit({ ...spec, retry: { maxAttempts: 2 } });
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe(0);
    });

    it('renews live cache entries without reviving expired entries or old fills', async () => {
        const task = await store.createTask(binding, 's', spec);
        const { handle } = await store.createCache(binding, task.id, { name: 'ttl', ttlMs: 1000 });
        const write = { operationId: 'put', handleId: handle.id, key: 'value', fingerprint: 'v1', value: 'value', expectedGeneration: 1 };
        await store.publishCache(binding, task.id, write);
        const renewed = await store.renewCache(binding, task.id, handle.id, 1, 2000);
        expect(renewed.generation).toBe(2);
        const request = { operationId: 'read', sources: [{ handleId: handle.id, key: 'value', fingerprint: 'v1' }] };
        expect((await store.readCache(binding, task.id, request)).status).toBe('hit');
        await expect(store.publishCache(binding, task.id, { ...write, operationId: 'stale-fill' })).rejects.toThrow('generation conflict');
        const expiring = await store.createCache(binding, task.id, { name: 'short', ttlMs: 1 });
        await store.publishCache(binding, task.id, { ...write, handleId: expiring.handle.id, operationId: 'short-put' });
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.renewCache(binding, task.id, expiring.handle.id, 1, 1000);
        expect((await store.readCache(binding, task.id, { operationId: 'expired-read', sources: [{ handleId: expiring.handle.id, key: 'value', fingerprint: 'v1' }] })).status).toBe('miss');
    });

    it('bounds external effect concurrency independently of reducer claims', async () => {
        let active = 0, maximum = 0;
        kernel.registerEffect({ kind: 'bounded', version: '1', async execute() {
            active++; maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            active--; return null;
        } });
        const ids = ['one', 'two', 'three', 'four'];
        const program: DurableTaskProgram<number> = {
            manifest: spec.program,
            init() { return { state: 0, actions: ids.map(id => ({ type: 'effect', effect: {
                id, kind: 'bounded', version: '1', idempotencyKey: id, request: null,
            } })), next: { type: 'wait', on: { type: 'all', waits: ids.map(id => ({ type: 'effect', id })) } } }; },
            reduce(state) { return { state: state + 1, next: state === 3 ? { type: 'complete', output: 'done' } : { type: 'continue' } }; },
        };
        kernel.registerProgram(program);
        const task = await (await kernel.openSession('s')).submit(spec);
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe('done');
        expect(maximum).toBe(2);
    });

    it('releases a hung reducer slot when pause invalidates its claim', async () => {
        kernel.dispose(); await kernel.waitIdle();
        kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0, maxConcurrent: 1 });
        kernel.registerStorageResolver({ kind: 'test', async resolve() { return binding; } });
        let calls = 0;
        kernel.registerProgram({ manifest: spec.program,
            async init() { if (++calls === 1) return new Promise(() => {}); return { state: null, next: { type: 'complete', output: 'resumed' } }; },
            reduce() { throw new Error('unexpected'); },
        });
        const task = await (await kernel.openSession('s')).submit(spec);
        await expect.poll(async () => (await task.status()).task.status).toBe('running');
        const pause = await task.pause({ requestId: 'pause' });
        await task.resume({ requestId: 'resume', expectedEpoch: pause.epoch });
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe('resumed');
        expect(calls).toBe(2);
    });

    it('fences descendant decisions immediately after ancestor cancellation', async () => {
        const root = await store.createTask(binding, 's', { ...spec, deferStart: true });
        const child = await store.createTask(binding, 's', { ...spec, parent: root.id });
        const claim = (await store.claimReady(binding, 'worker', 10000))!;
        await store.cancelTask(binding, root.id);
        expect(await store.renewLease(binding, claim, 10000)).toBe(false);
        await expect(store.commitTask(binding, claim, { ...claim.task, status: 'ready' }, 'task.ready')).rejects.toThrow('ancestor cancelled');
        await store.sweep(binding);
        expect((await store.readTask(binding, child.id)).status).toBe('cancelled');
    });

    it('lets a program create and use its own cache entirely through decisions', async () => {
        kernel.registerProgram({ manifest: spec.program,
            init() { return { state: null, actions: [{ type: 'cache-create', operationId: 'create', spec: { name: 'private' } }],
                next: { type: 'wait', on: { type: 'cache-management', operationId: 'create' } } }; },
            reduce(state, event) {
                if (event.type === 'cache-managed' && event.receipt.type === 'created') {
                    const handleId = event.receipt.handle.id;
                    return { state, actions: [
                        { type: 'cache-publish', request: { operationId: 'fill', handleId, key: 'key', fingerprint: 'v1', value: 'derived', expectedGeneration: 1 } },
                        { type: 'cache-read', request: { operationId: 'read', sources: [{ handleId, key: 'key', fingerprint: 'v1' }] } },
                    ], next: { type: 'wait', on: { type: 'cache', operationId: 'read' } } };
                }
                if (event.type === 'cache-result') return { state, next: { type: 'complete', output: event.receipt.value } };
                throw new Error('Unexpected input');
            },
        });
        const task = await (await kernel.openSession('s')).submit(spec);
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe('derived');
    });
});
