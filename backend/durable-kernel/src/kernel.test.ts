import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { Kernel } from './application/kernel';
import type {
    DurableTaskProgram,
    EffectAdapter,
    EventEnvelope,
    KernelRegistration,
    JsonValue,
    StorageBindingRef,
    WaitSpec,
    WorkspaceAdapter,
} from './domain/types';

const helperKernels: Kernel[] = [];
const binding: StorageBindingRef = { kind: 'test', locator: { rootPath: '/sessions/one/.kernel' } };

describe('Kernel durable kernel', () => {
    let manager: IVFSManager;
    let fs: IFileSystem;
    let kernel: Kernel;
    let backend: MemoryBackend;

    it('inspects without activation and restores only selected Sessions before starting their resource workers', async () => {
        for (const id of ['one', 'two', 'other']) {
            const session = await kernel.createSession({ id, storage: { kind: 'test', locator: { rootPath: `/sessions/${id}/.kernel` } } });
            await session.setShared('probe', { id });
        }
        kernel.dispose(); await kernel.waitIdle();
        const reader = await configuredKernel(fs, { maxConcurrent: 0, pollMs: 0 });
        const order: string[] = [];
        const internals = reader as unknown as {
            sessions: Map<string, unknown>;
            resourcePoller: { start(scope: string): void };
            managedResources: { recover(scope: string, takeover?: boolean): Promise<void> };
        };
        vi.spyOn(internals.resourcePoller, 'start').mockImplementation(scope => {
            if (scope.startsWith('session:')) order.push(`start:${scope}`);
        });
        const recover = internals.managedResources.recover.bind(internals.managedResources);
        vi.spyOn(internals.managedResources, 'recover').mockImplementation(async (scope, takeover) => {
            await recover(scope, takeover); order.push(`recovered:${scope}`);
        });
        const inspection = await reader.inspectSession('one');
        expect(await inspection.listTasks()).toEqual([]);
        expect((await inspection.getShared('probe'))?.value).toEqual({ id: 'one' });
        expect(internals.sessions.size).toBe(0);
        expect(order).toEqual([]);
        await reader.recoverSessions(['one', 'two', 'one'], { takeover: true });
        expect(order).toEqual(['recovered:kernel', 'recovered:session:one', 'recovered:session:two',
            'start:session:one', 'start:session:two']);
        expect([...internals.sessions.keys()]).toEqual(['one', 'two']);
    });

    it('reports one recovery timing sample per Session without changing the recovered set', async () => {
        for (const id of ['one', 'two']) {
            const session = await kernel.createSession({ id, storage: { kind: 'test', locator: { rootPath: `/sessions/${id}/.kernel` } } });
            await session.setShared('probe', { id });
        }
        kernel.dispose(); await kernel.waitIdle();
        const reader = await configuredKernel(fs, { maxConcurrent: 0, pollMs: 0 });
        const samples: Array<{ id: string; state: number; resources: number }> = [];
        await reader.recoverSessions(['one', 'two'], { takeover: true,
            onSessionRecovered: (id, timing) => samples.push({ id, ...timing }) });
        expect(samples.map(sample => sample.id)).toEqual(['one', 'two']);
        for (const sample of samples) {
            expect(sample.state).toBeGreaterThanOrEqual(0);
            expect(sample.resources).toBeGreaterThanOrEqual(0);
        }
    });

    it('repairs a stale catalog task mapping during recovery', async () => {
        const first = await kernel.createSession({ id: 'one', storage: { kind: 'test', locator: { rootPath: '/sessions/one/.kernel' } } });
        const second = await kernel.createSession({ id: 'two', storage: { kind: 'test', locator: { rootPath: '/sessions/two/.kernel' } } });
        const task = await first.submit({ program: { kind: 'test.manual', version: '1' }, input: 'first', deferStart: true });
        await second.submit({ program: { kind: 'test.manual', version: '1' }, input: 'second', deferStart: true });

        const catalog = '/.config/kernel/catalog.seq';
        await fs.meta.seq!.transaction!(tx => tx.setEntry(catalog, `task/${task.id}`, 'two'));
        const store = (kernel as unknown as { store: { locateTask(id: string): Promise<string> } }).store;
        expect(await store.locateTask(task.id)).toBe('two');

        await kernel.recoverSession('one');

        expect(await store.locateTask(task.id)).toBe('one');
    });

    it('recovers a Session by keyed catalog reads instead of scanning foreign task rows', async () => {
        const first = await kernel.createSession({ id: 'one', storage: { kind: 'test', locator: { rootPath: '/sessions/one/.kernel' } } });
        const second = await kernel.createSession({ id: 'two', storage: { kind: 'test', locator: { rootPath: '/sessions/two/.kernel' } } });
        const task = await first.submit({ program: { kind: 'test.manual', version: '1' }, input: 'first', deferStart: true });
        for (let index = 0; index < 50; index++) {
            await second.submit({ program: { kind: 'test.manual', version: '1' }, input: index, deferStart: true });
        }

        const reads: Array<{ op: string; path: string; key: string }> = [];
        const records = backend.records as unknown as {
            getRecordField(path: string, field: string): Promise<unknown>;
            walkRecordFields(path: string, callback: (field: string, value: unknown) => boolean | Promise<boolean>,
                options?: { prefix?: string }): Promise<{ total: number; processed: number }>;
        };
        const get = records.getRecordField.bind(records), walk = records.walkRecordFields.bind(records);
        records.getRecordField = async (path, field) => { reads.push({ op: 'get', path, key: field }); return get(path, field); };
        records.walkRecordFields = async (path, callback, options) => {
            reads.push({ op: 'walk', path, key: options?.prefix ?? '' });
            return walk(path, callback, options);
        };
        try { await kernel.recoverSession('one'); } finally {
            records.getRecordField = get; records.walkRecordFields = walk;
        }

        const catalog = reads.filter(read => read.path.endsWith('catalog.seq'));
        expect(catalog.filter(read => read.op === 'walk')).toEqual([]);
        expect(catalog.some(read => read.key.includes('session/one'))).toBe(true);
        expect(catalog.filter(read => read.key.includes(`task/${task.id}`))).toHaveLength(1);
        // Foreign Tasks must not add catalog reads: recovery stays O(this Session's Tasks).
        expect(catalog.filter(read => /task\//.test(read.key)).length).toBeLessThanOrEqual(2);
        expect(catalog.length).toBeLessThanOrEqual(4);
    });

    beforeEach(async () => {
        backend = new MemoryBackend();
        ({ manager } = await createVFS({ rootBackend: backend,}));
        fs = await manager.openFileSystem('/data/test');
        kernel = new Kernel({ catalog: { fs }, pollMs: 0 });
        kernel.registerStorageResolver({
            kind: 'test',
            async resolve(reference) {
                return { fs, rootPath: (reference.locator as { rootPath: string }).rootPath };
            },
        });
        await kernel.initialize();
    });

    afterEach(async () => {
        const all = [kernel, ...helperKernels.splice(0)];
        for (const k of all) k.dispose();
        await Promise.all(all.map(k => k.waitIdle()));
        await manager.dispose();
    });

    it('does not publish a catalog change when creating an already registered Session', async () => {
        await kernel.createSession({ id: 'session-one', storage: binding });
        await kernel.waitIdle();
        const changed: string[] = [];
        const off = fs.on('seq:committed', event => changed.push(...event.payload.paths));
        try {
            const repeated = await kernel.createSession({ id: 'session-one', storage: binding });
            await kernel.waitIdle();
            expect(repeated.id).toBe('session-one');
            expect(changed.filter(path => path.endsWith('/catalog.seq'))).toEqual([]);
            await expect(kernel.createSession({ id: 'session-one', storage: {
                kind: 'test', locator: { rootPath: '/other' },
            } })).rejects.toThrow('binding conflict');
        } finally { off(); }
    });

    it('fences task submission and shared writes in the transaction after a lease takeover', async () => {
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const lease = { key: 'owner', ownerId: 'old', epoch: 1 };
        await session.setShared('owner', { ownerId: 'old', epoch: 1, expiresAt: Date.now() + 60_000 });
        const spec = { program: { kind: 'test.echo', version: '1' }, input: 'once', requestId: 'stable', deferStart: true };
        const original = await session.submit(spec, { lease });
        await session.setShared('checkpoint', { task: original.id }, { lease });
        // A prior ownership read cannot authorize a write after the new owner commits.
        expect((await session.getShared('owner'))?.value).toMatchObject({ ownerId: 'old' });
        const successor = { ...lease, ownerId: 'new', epoch: 2 };
        await session.setShared('owner', { ...successor, expiresAt: Date.now() + 60_000 });
        const rejection = { code: 'STALE_SHARED_LEASE' };
        await expect(session.submit({ ...spec, requestId: 'new-task' }, { lease })).rejects.toMatchObject(rejection);
        await expect(session.submit(spec, { lease })).rejects.toMatchObject(rejection);
        await expect(session.setShared('checkpoint', null, { lease })).rejects.toMatchObject(rejection);
        await expect(session.deleteShared('checkpoint', { lease })).rejects.toMatchObject(rejection);
        const taskBeforeSignal = await original.status();
        await expect(session.signal(original.id, { type: 'late' }, { lease })).rejects.toMatchObject(rejection);
        await expect(original.cancel('late', { lease })).rejects.toMatchObject(rejection);
        await expect(original.pause({ requestId: 'late-pause', lease })).rejects.toMatchObject(rejection);
        await expect(original.interrupt({ requestId: 'late-interrupt', lease })).rejects.toMatchObject(rejection);
        await expect(original.resume({ requestId: 'late-resume', lease })).rejects.toMatchObject(rejection);
        await expect(original.start({ lease })).rejects.toMatchObject(rejection);
        await expect(original.createResource({ kind: 'test', uri: 'test://late' }, { lease })).rejects.toMatchObject(rejection);
        await expect(session.setBudget('missing', 'tokens', 3, undefined, { lease })).rejects.toMatchObject(rejection);
        await expect(original.respond({ interactionId: 'late', value: true }, { lease })).rejects.toMatchObject(rejection);
        expect(await original.status()).toEqual(taskBeforeSignal);
        expect((await session.getShared('checkpoint'))?.value).toEqual({ task: original.id });
        expect((await session.listTasks()).map(task => task.id)).toEqual([original.id]);
        // Authority is a write condition, not part of the logical submission fingerprint.
        expect((await session.submit(spec, { lease: successor })).id).toBe(original.id);
    });

    it.each(['expired', 'deleted', 'missing'])('refuses a %s lease without committing a task or shared revision', async state => {
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const lease = { key: 'owner', ownerId: 'old', epoch: 1 };
        if (state !== 'missing') await session.setShared('owner', { ownerId: 'old', epoch: 1,
            expiresAt: state === 'expired' ? Date.now() - 1 : Date.now() + 60_000, deleted: state === 'deleted' });
        const spec = { program: { kind: 'test.echo', version: '1' }, deferStart: true };
        await expect(session.submit(spec, { lease })).rejects.toMatchObject({ code: 'STALE_SHARED_LEASE' });
        await expect(session.setShared('checkpoint', 1, { lease })).rejects.toMatchObject({ code: 'STALE_SHARED_LEASE' });
        expect(await session.getShared('checkpoint')).toBeUndefined();
        expect(await session.listTasks()).toEqual([]);
    });

    it('persists and completes a task', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit<string, string>({
            program: { kind: 'test.echo', version: '1' }, input: 'hello',
        });
        const exit = await task.wait({ timeoutMs: 2_000 });
        expect(exit.output).toBe('hello');
        expect((await task.status()).task.status).toBe('succeeded');
        expect(await fs.driver.exists('/sessions/one/.kernel/tasks')).toBe(true);
    });

    it('reschedules polls only for catalog commits, not for sibling files under the catalog root', async () => {
        const scheduled: string[] = [];
        // A host's Session-lease heartbeat writes /<catalogRoot>/session-leases.seq every
        // few seconds. Reacting to it made every idle Session re-scan all its Tasks.
        const catalogRoot = '/.config/kernel';
        vi.spyOn(kernel as unknown as { schedulePoll(id: string): void }, 'schedulePoll')
            .mockImplementation((id: string) => { scheduled.push(id); });
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const leasePath = `${catalogRoot}/session-leases.seq`;
        await fs.driver.createFile({ name: 'session-leases.seq', parentPath: catalogRoot, type: 'seqfile' });
        // Quiesce the resource poller: a background resources.seq commit under the Session
        // root would legitimately reschedule a poll and hide the catalog filter.
        await kernel.waitIdle();
        const internals = kernel as unknown as {
            resourcePoller: { stop(key: string): void };
            stopPoll(sessionId: string): void;
        };
        internals.resourcePoller.stop('kernel');
        internals.resourcePoller.stop(`session:${session.id}`);
        internals.stopPoll(session.id);
        await new Promise(resolve => setTimeout(resolve, 30));
        scheduled.length = 0;

        await fs.meta.seq!.transaction(tx => tx.setEntry(leasePath, 'lease', 'value'));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(scheduled).toEqual([]);

        const resourceStarts: string[] = [];
        vi.spyOn((kernel as unknown as { resourcePoller: { start(key: string): void } }).resourcePoller, 'start')
            .mockImplementation(key => { resourceStarts.push(key); });
        await fs.meta.seq!.transaction(tx => tx.setEntry(`${catalogRoot}/resources.seq`, 'managed/schema', '2'));
        expect(resourceStarts).toContain('kernel');
        expect(scheduled).toEqual([]);

        await fs.meta.seq!.transaction(tx => tx.setEntry(`${catalogRoot}/catalog.seq`, 'session/other', 'value'));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(scheduled).toContain(session.id);
    });

    it('sweeps Session managed resources only for resources.seq commits, not for other Session records', async () => {
        const starts: string[] = [];
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        await kernel.waitIdle();
        const internals = kernel as unknown as {
            resourcePoller: { start(key: string): void; stop(key: string): void };
        };
        vi.spyOn(internals.resourcePoller, 'start').mockImplementation((key: string) => { starts.push(key); });
        internals.resourcePoller.stop(`session:${session.id}`);
        // Drain the sweep scheduled while the Session was being created.
        await new Promise(resolve => setTimeout(resolve, 30));
        starts.length = 0;

        // A Task/Effect record write must not re-read the managed-resource file.
        await fs.meta.seq!.transaction(tx => tx.setEntry('/sessions/one/.kernel/session.seq', 'record/note', 'value'));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(starts, 'after unrelated commit').toEqual([]);

        await fs.meta.seq!.transaction(tx => tx.setEntry('/sessions/one/.kernel/resources.seq', 'managed/schema', '2'));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(starts).toContain(`session:${session.id}`);
    });

    it('supports durable task-board claims and task-tree recovery', async () => {
        kernel.registerProgram(manualProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const parent = await session.submit({ program: { kind: 'test.manual', version: '1' }, input: 'parent' });
        const child = await session.submit({ program: { kind: 'test.manual', version: '1' }, input: 'child', parent: parent.id });
        const prerequisite = await session.createTaskBoardItem({ id: 'prepare', title: 'Prepare' });
        const work = await session.createTaskBoardItem({ id: 'work', title: 'Work', dependencies: [prerequisite.id] });

        await expect(session.claimTaskBoardItem(work.id, child.id)).rejects.toThrow('incomplete dependencies');
        const claimedPrepare = await session.claimTaskBoardItem(prerequisite.id, parent.id);
        await session.completeTaskBoardItem(claimedPrepare.id, claimedPrepare.leaseToken!, { ok: true });
        const claimedWork = await session.claimTaskBoardItem(work.id, child.id, { leaseMs: 1_000 });
        expect(claimedWork.assigneeTaskId).toBe(child.id);
        expect((await session.renewTaskBoardLease(work.id, child.id, claimedWork.leaseToken!, 2_000)).leaseUntil).toBeGreaterThan(claimedWork.leaseUntil!);
        expect((await session.attachTask(child.id)).id).toBe(child.id);
        expect((await session.listTasks()).map(task => task.id)).toEqual(expect.arrayContaining([parent.id, child.id]));

        await parent.cancel('stop tree');
        expect((await child.status()).task.status).toBe('cancelled');
    });

    it('rejects non-durable Task state before committing it', async () => {
        kernel.registerProgram(nonDurableStateProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.non-durable-state', version: '1' }, input: null,
        });

        const exit = await task.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('Task state.callback is not JSON serializable');
    });

    it('prepares resources and signals before a deferred task starts', async () => {
        kernel.registerProgram(grantedEffectProgram());
        kernel.registerEffect(uppercaseEffect());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.granted-effect', version: '1' },
            input: null,
            deferStart: true,
        });
        const resource = await task.createResource({
            kind: 'test', uri: 'test://resource', rights: ['execute'],
        });
        expect(resource.handle.holderTaskId).toBe(task.id);
        await task.signal({ type: 'run', payload: resource.handle.id });
        expect((await task.status()).task.status).toBe('created');

        await task.start();

        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('HELLO');
    });

    it('resumes after a durable effect', async () => {
        kernel.registerProgram(effectProgram());
        kernel.registerEffect(uppercaseEffect());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit<string, string>({
            program: { kind: 'test.effect', version: '1' }, input: 'hello',
        });
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('HELLO');
    });

    it('streams incremental events emitted during an effect to task.events()', async () => {
        kernel.registerProgram(streamingEffectProgram());
        kernel.registerEffect(streamingEffect());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit<string, string>({
            program: { kind: 'test.streaming-effect', version: '1' }, input: 'hello',
        });

        const envelopes: EventEnvelope[] = [];
        const collector = (async () => {
            for await (const envelope of task.events()) envelopes.push(envelope);
        })();

        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('HELLO');
        await collector;

        const streamed = envelopes.filter(envelope => envelope.type === 'agent.event');
        expect(streamed.map(envelope => (envelope.payload as { delta: string }).delta)).toEqual(['a', 'b', 'c']);
        expect(streamed.every(envelope => envelope.taskId === task.id)).toBe(true);
    });

    it('tags streamed content changes as content so listings can skip re-rendering', async () => {
        kernel.registerProgram(streamingEffectProgram());
        kernel.registerEffect(streamingEffect());
        const reasons: string[] = [];
        const off = kernel.onChanged(event => reasons.push(`${event.taskId ? 'task' : 'session'}:${event.reason}`));
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit<string, string>({
            program: { kind: 'test.streaming-effect', version: '1' }, input: 'hello',
        });
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('HELLO');
        off();

        expect(reasons).toContain('task:structure');
        expect(reasons).toContain('task:content');
        expect(reasons.filter(reason => reason === 'task:content').length).toBeGreaterThanOrEqual(3);
    });

    it('installs provider capabilities through the public plugin port', async () => {
        const plugin = {
            id: 'test.provider', version: '1',
            install(registration: KernelRegistration) {
                registration.registerProgram(effectProgram());
                registration.registerEffect(uppercaseEffect());
            },
        };
        await kernel.use(plugin);
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit<string, string>({
            program: { kind: 'test.effect', version: '1' }, input: 'plugin',
        });

        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('PLUGIN');
        await expect(kernel.use(plugin)).rejects.toThrow('already installed');
    });

    it('cancels an active effect through its adapter', async () => {
        let cancelCalls = 0;
        kernel.registerProgram(recoverableEffectProgram());
        kernel.registerEffect(cancellableEffect(() => { cancelCalls++; }));
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.recoverable-effect', version: '1' }, input: 'cancel',
        });
        await waitForEffectStatus(task, 'leased');

        await task.cancel('user cancelled');

        const snapshot = await task.status();
        expect(snapshot.task.status).toBe('cancelled');
        expect(snapshot.task.effects.recoverable.status).toBe('cancelled');
        expect(cancelCalls).toBe(1);
        await task.cancel('duplicate cancel');
        expect(cancelCalls).toBe(1);
    });

    it('ends a hanging effect at its deadline and invokes adapter cancellation', async () => {
        let cancelCalls = 0;
        kernel.registerProgram(timeoutEffectProgram());
        kernel.registerEffect({
            kind: 'test.timeout', version: '1',
            async execute() { return new Promise<never>(() => undefined); },
            async cancel() { cancelCalls++; },
        });
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.timeout-effect', version: '1' }, input: null,
        });

        const exit = await task.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('succeeded');
        expect(exit.output).toContain('timed out after 20ms');
        expect(cancelCalls).toBe(1);
    });

    it('rejects non-JSON effect requests before persistence', async () => {
        kernel.registerProgram(nonJsonEffectProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.non-json-effect', version: '1' }, input: null,
        });

        const exit = await task.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toContain('non-JSON object');
    });

    it('renews a long-running effect lease without occupying a task worker', async () => {
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const first = await configuredKernel(fs, { leaseMs: 30, pollMs: 0 });
        first.registerProgram(recoverableEffectProgram());
        first.registerEffect(delayedEffect(barrier));
        const session = await first.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.recoverable-effect', version: '1' }, input: 'long',
        });
        await waitForEffectStatus(task, 'leased');
        await new Promise(resolve => setTimeout(resolve, 70));
        const second = await configuredKernel(fs);

        const report = await second.recover();
        release();

        expect(report.recoveredEffects).toBe(0);
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('long');
    });

    it('recovers and reconciles an effect abandoned by a disposed worker', async () => {
        const first = await configuredKernel(fs, { leaseMs: 5 });
        first.registerProgram(recoverableEffectProgram());
        first.registerEffect(hangingEffect());
        const session = await first.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.recoverable-effect', version: '1' }, input: 'reconciled',
        });
        await waitForEffectStatus(task, 'leased');
        first.dispose();
        await new Promise(resolve => setTimeout(resolve, 10));
        const second = await configuredKernel(fs);
        second.registerProgram(recoverableEffectProgram());
        second.registerEffect(reconcilingEffect());

        const report = await second.recover();

        expect(report.recoveredEffects).toBe(1);
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('reconciled');
        const attempts = (await task.status()).task.effects.recoverable.attempts;
        expect(attempts.map(attempt => attempt.outcome)).toEqual(['lost', 'completed']);
    });

    it('allows only one concurrent claim', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'x' });
        await task.wait({ timeoutMs: 2_000 });
        const iterator = session.events({ after: 0 })[Symbol.asyncIterator]();
        const leased = (await iterator.next()).value;
        expect(leased?.sessionId).toBe('session-one');
    });

    it('releases a dependent task after its predecessor succeeds', async () => {
        kernel.registerProgram(echoProgram());
        kernel.registerProgram(dependencyProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const first = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'first' });
        const second = await session.submit({
            program: { kind: 'test.dependency', version: '1' },
            input: null,
            dependsOn: [{ task: first.id }],
        });
        expect((await second.wait({ timeoutMs: 2_000 })).output).toBe('first');
    });

    it('durably wakes a task waiter without losing completion', async () => {
        kernel.registerProgram(manualProgram());
        kernel.registerProgram(taskWaiterProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const target = await session.submit({
            program: { kind: 'test.manual', version: '1' }, input: 'target-result',
        });
        const waiter = await session.submit({
            program: { kind: 'test.task-waiter', version: '1' }, input: target.id,
        });
        await waitForStatus(target, 'waiting');
        await waitForStatus(waiter, 'waiting');
        await target.signal({ type: 'ignored' });
        expect((await target.status()).task.status).toBe('waiting');
        await target.signal({ type: 'finish' });

        expect((await waiter.wait({ timeoutMs: 2_000 })).output).toBe('target-result');
    });

    it('spawns one idempotent child and waits for it atomically', async () => {
        kernel.registerProgram(echoProgram());
        kernel.registerProgram(spawnParentProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const parent = await session.submit({
            program: { kind: 'test.spawn-parent', version: '1' }, input: 'child-result',
        });

        expect((await parent.wait({ timeoutMs: 2_000 })).output).toBe('child-result');
        const spawned = (await kernel.eventList(session.id, 0))
            .filter(event => event.type === 'task.spawned');
        expect(spawned).toHaveLength(1);
    });

    it('supports nested all and quorum durable waits', async () => {
        kernel.registerProgram(manualProgram());
        kernel.registerProgram(compositeWaitProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const targets = await Promise.all(['a', 'b', 'c'].map(input => session.submit({
            program: { kind: 'test.manual', version: '1' }, input,
        })));
        const waiter = await session.submit({
            program: { kind: 'test.composite-wait', version: '1' },
            input: {
                type: 'all',
                waits: [
                    { type: 'task', id: targets[0].id },
                    { type: 'quorum', required: 1, waits: [
                        { type: 'task', id: targets[1].id }, { type: 'task', id: targets[2].id },
                    ] },
                ],
            } satisfies WaitSpec,
        });
        await waitForStatus(waiter, 'waiting');
        await targets[1].signal({ type: 'finish' });
        expect((await waiter.status()).task.status).toBe('waiting');
        await targets[0].signal({ type: 'finish' });

        expect((await waiter.wait({ timeoutMs: 2_000 })).output).toBe('task-exited');
    });

    it('durably resumes approval and interactive input requests', async () => {
        kernel.registerProgram(interactionProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const approval = await session.submit({
            program: { kind: 'test.interaction', version: '1' }, input: 'approval',
        });
        const input = await session.submit({
            program: { kind: 'test.interaction', version: '1' }, input: 'input',
        });
        await Promise.all([waitForStatus(approval, 'waiting'), waitForStatus(input, 'waiting')]);

        await approval.respond({ interactionId: 'request', value: 'approved' });
        await session.respond(input.id, { interactionId: 'request', value: 'continue' });

        expect((await approval.wait({ timeoutMs: 2_000 })).output).toBe('approved');
        expect((await input.wait({ timeoutMs: 2_000 })).output).toBe('continue');
        expect((await approval.status()).task.interactions.request.status).toBe('resolved');
    });

    it('persists versioned session shared state with CAS', async () => {
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const first = await session.setShared('agent/context', { count: 1 }, { expectedVersion: null });
        const second = await session.setShared('agent/context', { count: 2 }, { expectedVersion: first.version });

        expect(second.version).toBe(2);
        expect((await session.getShared('agent/context'))?.value).toEqual({ count: 2 });
        expect(await session.listShared('agent/')).toHaveLength(1);
        await expect(session.setShared('agent/context', { count: 3 }, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await session.deleteShared('agent/context', { expectedVersion: 2 })).toBe(true);
        const recreated = await session.setShared('agent/context', { count: 3 }, { expectedVersion: null });
        expect(recreated.version).toBe(4);
        expect((await session.sharedHistory('agent/context')).map(revision => revision.deleted))
            .toEqual([false, false, true, false]);
    });

    it('commits task state and session shared state atomically', async () => {
        kernel.registerProgram(sharedStateProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.shared-state', version: '1' }, input: { count: 4 },
        });

        expect((await task.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
        expect((await session.getShared('task/result'))?.value).toEqual({ count: 4 });
        expect((await session.getShared('task/result'))?.updatedByTaskId).toBe(task.id);
    });

    it('persists context branches with CAS and explicit merge parents', async () => {
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const root = await session.commitContext({ message: 'root' }, { expectedHead: null });
        const left = await session.commitContext({ message: 'left' }, {
            branch: 'left', parents: [root.id], expectedHead: null,
        });
        const right = await session.commitContext({ message: 'right' }, {
            branch: 'right', parents: [root.id], expectedHead: null,
        });
        const merged = await session.commitContext({ message: 'merge' }, {
            parents: [left.id, right.id], expectedHead: root.id,
        });

        expect((await session.getContextBranch()).head).toBe(merged.id);
        expect(new Set((await session.contextHistory()).map(commit => commit.id)))
            .toEqual(new Set([root.id, left.id, right.id, merged.id]));
        await expect(session.commitContext({ message: 'stale' }, { expectedHead: root.id }))
            .rejects.toThrow('conflict');
    });

    it('enforces resource grants, revocation, and ancestor budgets', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        await session.suspend();
        const owner = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'owner' });
        const reader = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'reader' });
        const workspace = await session.createResource({
            kind: 'workspace', uri: 'workspace://main', ownerTaskId: owner.id,
        });
        const readHandle = await session.grantResource(workspace.handle.id, reader.id, ['read']);
        expect((await session.authorizeResource(readHandle.id, 'read', reader.id)).uri).toBe('workspace://main');
        await expect(session.authorizeResource(readHandle.id, 'write', reader.id)).rejects.toThrow('lacks write');
        await expect(session.grantResource(readHandle.id, reader.id, ['write'])).rejects.toThrow();

        await session.setBudget(workspace.handle.id, 'tokens', 10, null);
        const branch = await session.createResource({
            kind: 'workspace', uri: 'workspace://branch', ownerTaskId: owner.id,
            parentResourceId: workspace.resource.id, parentHandleId: workspace.handle.id,
        });
        expect((await session.chargeBudget(branch.handle.id, 'tokens', 6))[0].used).toBe(6);
        await expect(session.chargeBudget(branch.handle.id, 'tokens', 5)).rejects.toThrow('exceeded');
        expect(await session.revokeResource(workspace.handle.id)).toBeGreaterThanOrEqual(2);
        await expect(session.authorizeResource(readHandle.id, 'read', reader.id)).rejects.toThrow('revoked');
    });

    it('distinguishes an accepted cancel request from a confirmed external stop', async () => {
        const held = heldEffect();
        kernel.registerProgram(echoProgram());
        kernel.registerProgram(held.program);
        kernel.registerEffect(held.adapter);
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({ program: { kind: 'test.held-effect', version: '1' }, input: null });
        await held.begun;

        const cancelling = task.cancel();
        await held.stopping;
        // The request is accepted and the logical state already changed, but the external
        // Effect has not confirmed its stop: observers must be able to tell the two apart.
        expect(await task.stat()).toMatchObject({
            phase: 'done', activeOperations: 1, control: { requested: 'cancel', acknowledged: false },
        });

        held.release();
        await cancelling;
        expect(await task.stat()).toMatchObject({ activeOperations: 0, control: { requested: 'cancel', acknowledged: true } });
    });

    it('settles a budget charge once per usage id and refuses a conflicting replay', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const owner = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'owner' });
        const workspace = await session.createResource({ kind: 'workspace', uri: 'workspace://settle', ownerTaskId: owner.id });
        await session.setBudget(workspace.handle.id, 'tokens', 10, null);

        const first = await session.chargeBudget(workspace.handle.id, 'tokens', 4, { usageId: 'usage-1' });
        expect(first[0].used).toBe(4);
        // A replay returns the recorded settlement instead of charging again.
        expect(await session.chargeBudget(workspace.handle.id, 'tokens', 4, { usageId: 'usage-1' })).toEqual(first);
        // A different amount under the same usage id is a conflict, not a second charge.
        await expect(session.chargeBudget(workspace.handle.id, 'tokens', 6, { usageId: 'usage-1' })).rejects.toThrow('already settled');
        await expect(session.chargeBudget(workspace.handle.id, 'tokens', 4, { usageId: '   ' })).rejects.toThrow('non-empty');
        // Without a usage id the facade keeps the legacy charge-every-call behavior.
        await session.chargeBudget(workspace.handle.id, 'tokens', 1);
        await session.chargeBudget(workspace.handle.id, 'tokens', 1);
        expect((await session.chargeBudget(workspace.handle.id, 'tokens', 1))[0].used).toBe(7);

        // The receipt is durable and still dedupes on a replacement Kernel.
        const reopened = await configuredKernel(fs);
        const restored = await reopened.openSession('session-one');
        expect((await restored.chargeBudget(workspace.handle.id, 'tokens', 4, { usageId: 'usage-1' }))[0].used).toBe(4);
        expect((await restored.chargeBudget(workspace.handle.id, 'tokens', 1))[0].used).toBe(8);
    });

    it('charges effect-driven usage once per logical Effect even when the attempt is retried', async () => {
        kernel.registerProgram(echoProgram());
        kernel.registerProgram(chargingEffectProgram());
        kernel.registerEffect(chargingEffect());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({ program: { kind: 'test.charging-effect', version: '1' }, input: null });
        await waitForStatus(task, 'waiting');
        const workspace = await session.createResource({ kind: 'workspace', uri: 'workspace://charging', ownerTaskId: task.id });
        await session.setBudget(workspace.handle.id, 'tokens', 10, null);
        await task.signal({ type: 'run', payload: workspace.handle.id });
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('charged');

        const effect = Object.values((await task.status()).task.effects)[0];
        expect(effect.attempts.map(attempt => attempt.outcome)).toEqual(['failed', 'completed']);
        // Both attempts charged; the kernel's default settlement id folded them into one.
        const usageId = `effect:${task.id}:${effect.request.id}:${workspace.handle.id}:tokens`;
        expect((await session.chargeBudget(workspace.handle.id, 'tokens', 4, { usageId }))[0].used).toBe(4);
        await expect(session.chargeBudget(workspace.handle.id, 'tokens', 5, { usageId })).rejects.toThrow('already settled');
    });

    it('charges distinct Tasks independently when their Effect ids and budget handle match', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const owner = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'owner' });
        const resource = await session.createResource({ kind: 'workspace', uri: 'workspace://shared-charge', ownerTaskId: owner.id });
        await session.setBudget(resource.handle.id, 'tokens', 10, null);
        kernel.registerEffect({ kind: 'test.shared-charge', version: '1', async execute(_request, context) {
            await context.chargeBudget!(resource.handle.id, 'tokens', 4);
            return 'charged';
        } });
        kernel.registerProgram({ manifest: { kind: 'test.shared-charge', version: '1' },
            init: () => ({ state: null, actions: [{ type: 'effect', effect: {
                id: 'same-id', kind: 'test.shared-charge', version: '1', request: null, idempotencyKey: 'same-key',
            } }], next: { type: 'wait', on: { type: 'effect', id: 'same-id' } } }),
            reduce: () => ({ state: null, next: { type: 'complete', output: 'done' } }),
        });
        for (let index = 0; index < 2; index++) {
            const task = await session.submit({ program: { kind: 'test.shared-charge', version: '1' }, input: null });
            expect((await task.wait({ timeoutMs: 2_000 })).status).toBe('succeeded');
        }
        expect((await session.chargeBudget(resource.handle.id, 'tokens', 1))[0].used).toBe(9);
    });

    it('authorizes declared resource grants before executing an effect', async () => {
        kernel.registerProgram(grantedEffectProgram());
        kernel.registerEffect(uppercaseEffect());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.granted-effect', version: '1' }, input: null,
        });
        await waitForStatus(task, 'waiting');
        const resource = await session.createResource({
            kind: 'model', uri: 'model://uppercase', ownerTaskId: task.id,
        });
        await task.signal({ type: 'run', payload: resource.handle.id });

        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('HELLO');
    });

    it('persists workspace snapshots, diffs, and merge ancestry through an adapter', async () => {
        kernel.registerProgram(echoProgram());
        const workspace = mutableWorkspaceAdapter({ files: { 'a.txt': 'base' } });
        kernel.registerWorkspace(workspace.adapter);
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        await session.suspend();
        const owner = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'owner' });
        const grant = await session.createResource({
            kind: 'workspace', uri: 'memory://workspace', ownerTaskId: owner.id,
        });
        const adapter = { kind: 'test.workspace', version: '1' };
        const base = await session.snapshotWorkspace(grant.handle.id, adapter);
        workspace.set({ files: { 'a.txt': 'left' } });
        const left = await session.snapshotWorkspace(grant.handle.id, adapter);
        workspace.set({ files: { 'a.txt': 'right' } });
        const right = await session.snapshotWorkspace(grant.handle.id, adapter);

        const diff = await session.diffWorkspace(grant.handle.id, base.id, left.id);
        const merged = await session.mergeWorkspace(grant.handle.id, base.id, left.id, right.id);

        expect(diff.payload).toEqual({ base: base.payload, target: left.payload });
        expect(merged.snapshot.parentIds).toEqual([left.id, right.id]);
        expect(merged.conflicts).toEqual([{ path: 'a.txt' }]);
        expect((await kernel.eventList(session.id, 0)).map(event => event.type))
            .toContain('workspace.snapshot.created');
    });

    it('keeps task snapshots and completed attempt history', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'history' });
        await task.wait({ timeoutMs: 2_000 });

        expect((await task.history()).map(snapshot => snapshot.status)).toEqual(['ready', 'running', 'succeeded']);
        expect((await task.attempts()).map(attempt => attempt.outcome)).toEqual(['completed']);
    });

    it('delivers cross-session messages through a durable outbox', async () => {
        const source = await kernel.createSession({ id: 'session-one', storage: binding });
        const pending = await source.sendToSession('session-two', 'context.updated', { revision: 1 });
        expect(pending.status).toBe('pending');

        const target = await kernel.createSession({
            id: 'session-two',
            storage: { kind: 'test', locator: { rootPath: '/sessions/two/.kernel' } },
        });
        expect(await kernel.relayPendingMessages()).toBe(1);
        expect((await target.inbox()).map(message => message.payload)).toEqual([{ revision: 1 }]);
        expect(await kernel.relayPendingMessages()).toBe(0);
        expect(await target.inbox()).toHaveLength(1);
    });

    it('rebuilds task indexes and catalog routes from task directories', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        await session.suspend();
        const task = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'repair' });
        await fs.meta.seq!.deleteEntry('/sessions/one/.kernel/index.seq', `task/${task.id}`);
        await fs.meta.seq!.deleteEntry('/sessions/one/.kernel/index.seq', `ready/${task.id}`);
        await fs.meta.seq!.deleteEntry('/.config/kernel/catalog.seq', `task/${task.id}`);

        const report = await kernel.recover();

        expect(report.rebuiltIndexes).toBeGreaterThanOrEqual(1);
        expect((await (await kernel.openTask(task.id)).status()).task.status).toBe('ready');
    });

    it('allows only one worker to claim a task across kernel instances', async () => {
        const creator = await configuredKernel(fs, { maxConcurrent: 0 });
        const session = await creator.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'once' });
        const first = await configuredKernel(fs);
        const second = await configuredKernel(fs);
        first.registerProgram(echoProgram());
        second.registerProgram(echoProgram());

        await Promise.all([first.openSession(session.id), second.openSession(session.id)]);

        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('once');
        expect(await task.attempts()).toHaveLength(1);
    });

    it('discovers durable ready work without sharing in-memory notifications', async () => {
        const creator = await configuredKernel(fs, { maxConcurrent: 0 });
        const session = await creator.createSession({ id: 'session-one', storage: binding });
        const worker = await configuredKernel(fs, { pollMs: 0 });
        worker.registerProgram(echoProgram());
        await worker.openSession(session.id);

        const task = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'durable' });

        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('durable');
    });

    it('requeues an expired running attempt and records it as lost', async () => {
        const first = await configuredKernel(fs, { leaseMs: 5 });
        first.registerProgram(hangingProgram());
        const session = await first.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.lease', version: '1' }, input: 'replayed', retry: { maxAttempts: 2 },
        });
        await waitForStatus(task, 'running');
        first.dispose();
        await new Promise(resolve => setTimeout(resolve, 10));
        const second = await configuredKernel(fs);
        second.registerProgram(replayedProgram());

        const report = await second.recover();

        expect(report.expiredAttempts).toBe(1);
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('replayed');
        expect((await task.attempts()).map(attempt => attempt.outcome)).toEqual(['lost', 'completed']);
    });

    it('fails an expired attempt when its retry budget is exhausted', async () => {
        const first = await configuredKernel(fs, { leaseMs: 5 });
        first.registerProgram(hangingProgram());
        const session = await first.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.lease', version: '1' }, input: 'never', retry: { maxAttempts: 1 },
        });
        await waitForStatus(task, 'running');
        first.dispose();
        await new Promise(resolve => setTimeout(resolve, 10));
        const second = await configuredKernel(fs);

        await second.recover();

        expect((await task.wait({ timeoutMs: 2_000 })).status).toBe('failed');
        expect((await task.attempts()).map(attempt => attempt.outcome)).toEqual(['lost']);
    });

    it('renews a live attempt lease while a reducer is running', async () => {
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const first = await configuredKernel(fs, { leaseMs: 30, pollMs: 0 });
        first.registerProgram(delayedProgram(barrier));
        const session = await first.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({ program: { kind: 'test.delayed', version: '1' }, input: 'alive' });
        await waitForStatus(task, 'running');
        await new Promise(resolve => setTimeout(resolve, 70));
        const second = await configuredKernel(fs);

        const report = await second.recover();
        release();

        expect(report.expiredAttempts).toBe(0);
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('alive');
        expect(await task.attempts()).toHaveLength(1);
    });

    it('retries a retryable decision after durable backoff', async () => {
        kernel.registerProgram(retryOnceProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.retry-once', version: '1' }, input: 'retried',
            retry: { maxAttempts: 2, backoffMs: 40 },
        });
        const retry = await waitForRetry(task);

        expect(retry.lastError?.message).toBe('retry me');
        expect(retry.readyAt! - retry.updatedAt).toBeGreaterThanOrEqual(30);
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('retried');
        expect((await task.attempts()).map(attempt => attempt.outcome)).toEqual(['failed', 'completed']);
        expect((await kernel.eventList(session.id, 0)).map(event => event.type))
            .toContain('task.retry.scheduled');
    });

    it('fails after exception retry attempts are exhausted', async () => {
        kernel.registerProgram(alwaysFailingProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        const task = await session.submit({
            program: { kind: 'test.always-fail', version: '1' }, input: null,
            retry: { maxAttempts: 2 },
        });

        const exit = await task.wait({ timeoutMs: 2_000 });

        expect(exit.status).toBe('failed');
        expect(exit.error?.message).toBe('still failing');
        expect((await task.attempts()).map(attempt => attempt.outcome)).toEqual(['failed', 'failed']);
    });

    it('persists session suspend and resume', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        await session.suspend();
        const task = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'later' });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect((await task.status()).task.status).toBe('ready');
        await session.resume();
        expect((await task.wait({ timeoutMs: 2_000 })).output).toBe('later');
    });

    it('closes a session and cancels unfinished tasks', async () => {
        kernel.registerProgram(echoProgram());
        const session = await kernel.createSession({ id: 'session-one', storage: binding });
        await session.suspend();
        const task = await session.submit({ program: { kind: 'test.echo', version: '1' }, input: 'later' });

        await session.close({ cancelRunning: true });

        expect((await task.status()).task.status).toBe('cancelled');
        expect((await kernel.listSessions().next()).value?.status).toBe('closed');
    });
});

/** Task + adapter whose external Effect only stops when the returned `release()` is called. */
function heldEffect() {
    let begun!: () => void, stopped!: () => void, release!: () => void;
    const begunPromise = new Promise<void>(resolve => { begun = resolve; });
    const stopping = new Promise<void>(resolve => { stopped = resolve; });
    let inFlight: Promise<unknown> | undefined;
    const adapter: EffectAdapter<null, string> = {
        kind: 'test.held', version: '1',
        execute(_request, context) {
            begun();
            const execution = new Promise<never>((_, reject) => {
                context.abortSignal.addEventListener('abort', () => { stopped(); release = () => reject(new Error('aborted')); }, { once: true });
            });
            inFlight = execution.catch(() => undefined);
            return execution;
        },
        async cancel() { await inFlight; },
    };
    const program: DurableTaskProgram<null, null, string> = {
        manifest: { kind: 'test.held-effect', version: '1' },
        init: () => ({ state: null, actions: [{ type: 'effect', effect: { id: 'e', kind: 'test.held', version: '1', request: null, idempotencyKey: 'held' } }],
            next: { type: 'wait', on: { type: 'effect', id: 'e' } } }),
        reduce() { throw new Error('Unexpected reduce'); },
    };
    return { adapter, program, begun: begunPromise, stopping, release: () => release() };
}

function chargingEffect(): EffectAdapter<string, string> {
    let calls = 0;
    return {
        kind: 'test.charging', version: '1', recoveryPolicy: 'idempotent-retry',
        async execute(_request, context) {
            await context.chargeBudget?.(context.grants[0].handleId, 'tokens', 4);
            if (++calls === 1) throw new Error('temporary');
            return 'charged';
        },
    };
}

function chargingEffectProgram(): DurableTaskProgram<null, null, string> {
    return {
        manifest: { kind: 'test.charging-effect', version: '1' },
        init() { return { state: null, next: { type: 'wait', on: { type: 'signal', id: 'run' } } }; },
        reduce(state, event) {
            if (event.type === 'signal') {
                const handleId = String(event.signal.payload);
                return {
                    state,
                    actions: [{ type: 'effect', effect: {
                        kind: 'test.charging', version: '1', request: 'charge', idempotencyKey: 'charge',
                        grants: [{ handleId, right: 'execute' }], retry: { maxAttempts: 2, backoffMs: 5 },
                    } }],
                    next: { type: 'wait', on: { type: 'effect' } },
                };
            }
            if (event.type === 'effect-completed') return { state, next: { type: 'complete', output: event.result as string } };
            throw new Error(`Unexpected event: ${event.type}`);
        },
    };
}

function echoProgram(): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.echo', version: '1' },
        init(input) { return { state: null, next: { type: 'complete', output: input } }; },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

function nonDurableStateProgram(): DurableTaskProgram<{ callback: () => void }, null, never> {
    return {
        manifest: { kind: 'test.non-durable-state', version: '1' },
        init: () => ({
            state: { callback: () => undefined },
            next: { type: 'continue' },
        }),
        reduce: state => ({ state: { ...state }, next: { type: 'continue' } }),
    };
}

function effectProgram(): DurableTaskProgram<{ input: string }, string, string> {
    return {
        manifest: { kind: 'test.effect', version: '1' },
        init(input) {
            return {
                state: { input },
                actions: [{ type: 'effect', effect: {
                    kind: 'test.uppercase', version: '1', request: input, idempotencyKey: 'uppercase',
                } }],
                next: { type: 'wait', on: { type: 'effect' } },
            };
        },
        reduce(state, event) {
            if (event.type !== 'effect-completed') throw new Error(`Unexpected event: ${event.type}`);
            return { state: { ...state }, next: { type: 'complete', output: event.result as string } };
        },
    };
}

function recoverableEffectProgram(): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.recoverable-effect', version: '1' },
        init(input) {
            return {
                state: null,
                actions: [{ type: 'effect', effect: {
                    id: 'recoverable', kind: 'test.recoverable', version: '1', request: input,
                    idempotencyKey: `recoverable:${input}`, timeoutMs: 2_000,
                } }],
                next: { type: 'wait', on: { type: 'effect', id: 'recoverable' } },
            };
        },
        reduce(state, event) {
            if (event.type !== 'effect-completed') throw new Error(`Unexpected event: ${event.type}`);
            return { state, next: { type: 'complete', output: String(event.result) } };
        },
    };
}

function timeoutEffectProgram(): DurableTaskProgram<null, null, string> {
    return {
        manifest: { kind: 'test.timeout-effect', version: '1' },
        init() {
            return {
                state: null,
                actions: [{ type: 'effect', effect: {
                    id: 'timeout', kind: 'test.timeout', version: '1', request: null,
                    idempotencyKey: 'timeout', timeoutMs: 20,
                } }],
                next: { type: 'wait', on: { type: 'effect', id: 'timeout' } },
            };
        },
        reduce(state, event) {
            if (event.type !== 'effect-failed') throw new Error(`Unexpected event: ${event.type}`);
            return { state, next: { type: 'complete', output: event.error.message } };
        },
    };
}

function nonJsonEffectProgram(): DurableTaskProgram<null, null, never> {
    return {
        manifest: { kind: 'test.non-json-effect', version: '1' },
        init() {
            return {
                state: null,
                actions: [{ type: 'effect', effect: {
                    kind: 'test.invalid', version: '1',
                    request: { signal: new AbortController().signal }, idempotencyKey: 'invalid',
                } }],
                next: { type: 'wait', on: { type: 'effect' } },
            };
        },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

function cancellableEffect(onCancel: () => void): EffectAdapter<string, string> {
    return {
        kind: 'test.recoverable', version: '1',
        execute(_request, context) {
            return new Promise((_resolve, reject) => {
                context.abortSignal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
            });
        },
        async cancel() { onCancel(); },
    };
}

function dependencyProgram(): DurableTaskProgram<Record<string, never>, null, string> {
    return {
        manifest: { kind: 'test.dependency', version: '1' },
        init() { return { state: {}, next: { type: 'continue' } }; },
        reduce(state, event) {
            if (event.type !== 'task-exited') throw new Error(`Unexpected event: ${event.type}`);
            return { state, next: { type: 'complete', output: event.exit.output as string } };
        },
    };
}

function sharedStateProgram(): DurableTaskProgram<null, { count: number }, null> {
    return {
        manifest: { kind: 'test.shared-state', version: '1' },
        init(input) {
            return {
                state: null,
                actions: [{ type: 'set-shared', key: 'task/result', value: input, expectedVersion: null }],
                next: { type: 'complete', output: null },
            };
        },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

function manualProgram(): DurableTaskProgram<string, string, string> {
    return {
        manifest: { kind: 'test.manual', version: '1' },
        init(input) { return { state: input, next: { type: 'wait', on: { type: 'signal', id: 'finish' } } }; },
        reduce(state, event) {
            if (event.type !== 'signal') throw new Error(`Unexpected event: ${event.type}`);
            if (event.signal.type !== 'finish') {
                return { state, next: { type: 'wait', on: { type: 'signal', id: 'finish' } } };
            }
            return { state, next: { type: 'complete', output: state } };
        },
    };
}

function taskWaiterProgram(): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.task-waiter', version: '1' },
        init(targetId) { return { state: null, next: { type: 'wait', on: { type: 'task', id: targetId } } }; },
        reduce(state, event) {
            if (event.type !== 'task-exited') throw new Error(`Unexpected event: ${event.type}`);
            return { state, next: { type: 'complete', output: event.exit.output as string } };
        },
    };
}

function spawnParentProgram(): DurableTaskProgram<null, string, string> {
    const spawn = (input: string) => ({
        type: 'spawn' as const,
        spawnKey: 'only-child',
        spec: { program: { kind: 'test.echo', version: '1' }, input },
    });
    return {
        manifest: { kind: 'test.spawn-parent', version: '1' },
        init(input) {
            return {
                state: null, actions: [spawn(input)],
                next: { type: 'wait', on: { type: 'child', spawnKey: 'only-child' } },
            };
        },
        reduce(state, event) {
            if (event.type !== 'task-exited') throw new Error(`Unexpected event: ${event.type}`);
            return { state, actions: [spawn('ignored')], next: { type: 'complete', output: event.exit.output as string } };
        },
    };
}

function grantedEffectProgram(): DurableTaskProgram<null, null, string> {
    return {
        manifest: { kind: 'test.granted-effect', version: '1' },
        init() { return { state: null, next: { type: 'wait', on: { type: 'signal', id: 'run' } } }; },
        reduce(state, event) {
            if (event.type === 'signal') {
                const handleId = String(event.signal.payload);
                return {
                    state,
                    actions: [{ type: 'effect', effect: {
                        kind: 'test.uppercase', version: '1', request: 'hello', idempotencyKey: 'granted',
                        grants: [{ handleId, right: 'execute' }],
                    } }],
                    next: { type: 'wait', on: { type: 'effect' } },
                };
            }
            if (event.type === 'effect-completed') {
                return { state, next: { type: 'complete', output: event.result as string } };
            }
            throw new Error(`Unexpected event: ${event.type}`);
        },
    };
}

function compositeWaitProgram(): DurableTaskProgram<null, WaitSpec, string> {
    return {
        manifest: { kind: 'test.composite-wait', version: '1' },
        init(wait) { return { state: null, next: { type: 'wait', on: wait } }; },
        reduce(state, event) { return { state, next: { type: 'complete', output: event.type } }; },
    };
}

function interactionProgram(): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.interaction', version: '1' },
        init(kind) {
            return {
                state: null,
                actions: [{ type: 'request-interaction', interaction: {
                    id: 'request', kind: kind === 'approval' ? 'approval' : 'input', prompt: `Need ${kind}`,
                } }],
                next: { type: 'wait', on: { type: 'interaction', id: 'request' } },
            };
        },
        reduce(state, event) {
            if (event.type !== 'interaction-resolved') throw new Error(`Unexpected event: ${event.type}`);
            return { state, next: { type: 'complete', output: String(event.value) } };
        },
    };
}

async function waitForStatus(
    task: { status(): Promise<{ task: { status: string } }> },
    expected: string,
): Promise<void> {
    for (let index = 0; index < 100; index++) {
        if ((await task.status()).task.status === expected) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Task did not reach ${expected}`);
}

function uppercaseEffect(): EffectAdapter<string, string> {
    return {
        kind: 'test.uppercase', version: '1',
        async execute(request) { return request.toUpperCase(); },
    };
}

function streamingEffect(): EffectAdapter<string, string> {
    return {
        kind: 'test.streaming', version: '1',
        async execute(request, context) {
            for (const delta of ['a', 'b', 'c']) {
                await context.emit?.({ type: 'agent.event', payload: { type: 'stream:content', delta } });
            }
            return request.toUpperCase();
        },
    };
}

function streamingEffectProgram(): DurableTaskProgram<{ input: string }, string, string> {
    return {
        manifest: { kind: 'test.streaming-effect', version: '1' },
        init(input) {
            return {
                state: { input },
                actions: [{ type: 'effect', effect: {
                    kind: 'test.streaming', version: '1', request: input, idempotencyKey: 'streaming',
                } }],
                next: { type: 'wait', on: { type: 'effect' } },
            };
        },
        reduce(state, event) {
            if (event.type !== 'effect-completed') throw new Error(`Unexpected event: ${event.type}`);
            return { state: { ...state }, next: { type: 'complete', output: event.result as string } };
        },
    };
}

function delayedEffect(barrier: Promise<void>): EffectAdapter<string, string> {
    return {
        kind: 'test.recoverable', version: '1',
        async execute(request) { await barrier; return request; },
    };
}

function hangingEffect(): EffectAdapter<string, string> {
    return {
        kind: 'test.recoverable', version: '1',
        async execute() { return new Promise(() => undefined); },
    };
}

function reconcilingEffect(): EffectAdapter<string, string> {
    return {
        kind: 'test.recoverable', version: '1',
        async execute(request) { return request; },
        async reconcile(request) { return { status: 'completed', result: request }; },
    };
}

async function configuredKernel(
    fs: IFileSystem,
    options: { maxConcurrent?: number; leaseMs?: number; pollMs?: number } = {},
): Promise<Kernel> {
    const value = new Kernel({ catalog: { fs }, ...options });
    helperKernels.push(value);
    value.registerStorageResolver({
        kind: 'test',
        async resolve(reference) {
            return { fs, rootPath: (reference.locator as { rootPath: string }).rootPath };
        },
    });
    await value.initialize();
    return value;
}

function mutableWorkspaceAdapter(initial: JsonValue): {
    adapter: WorkspaceAdapter;
    set(value: JsonValue): void;
} {
    let value = initial;
    return {
        set(next) { value = next; },
        adapter: {
            kind: 'test.workspace', version: '1',
            async snapshot() { return structuredClone(value); },
            async diff(base, target) { return { base, target }; },
            async merge(base, left, right) {
                return { payload: { base, left, right }, conflicts: [{ path: 'a.txt' }] };
            },
        },
    };
}

function hangingProgram(): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.lease', version: '1' },
        async init() { return new Promise(() => undefined); },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

function replayedProgram(): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.lease', version: '1' },
        init(input) { return { state: null, next: { type: 'complete', output: input } }; },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

function delayedProgram(barrier: Promise<void>): DurableTaskProgram<null, string, string> {
    return {
        manifest: { kind: 'test.delayed', version: '1' },
        async init(input) {
            await barrier;
            return { state: null, next: { type: 'complete', output: input } };
        },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

function retryOnceProgram(): DurableTaskProgram<null, string, string> {
    let attempts = 0;
    return {
        manifest: { kind: 'test.retry-once', version: '1' },
        init(input) {
            attempts++;
            if (attempts === 1) {
                return { state: null, next: { type: 'fail', error: { message: 'retry me' }, retryable: true } };
            }
            return { state: null, next: { type: 'complete', output: input } };
        },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

function alwaysFailingProgram(): DurableTaskProgram<null, null, never> {
    return {
        manifest: { kind: 'test.always-fail', version: '1' },
        init() { throw new Error('still failing'); },
        reduce() { throw new Error('Unexpected reduce'); },
    };
}

async function waitForRetry(
    task: { status(): Promise<{ task: import('./types').TaskRecord }> },
): Promise<import('./types').TaskRecord> {
    for (let index = 0; index < 100; index++) {
        const record = (await task.status()).task;
        if (record.status === 'ready' && record.attemptCount === 1 && record.readyAt) return record;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Task did not schedule retry');
}

async function waitForEffectStatus(
    task: { status(): Promise<{ task: import('./types').TaskRecord }> },
    expected: string,
): Promise<void> {
    for (let index = 0; index < 100; index++) {
        const effect = (await task.status()).task.effects.recoverable;
        if (effect?.status === expected) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error(`Effect did not reach ${expected}`);
}
