import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVFS, MemoryBackend, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { Kernel } from './application/kernel';
import { createHarness, defineTask } from './core';
import { ManagedResourceStore, executeResourceTx } from './infrastructure/seqfile/managed-resources';
import { resourceResult as result } from './public/resources';
import type { DurableTaskProgram, SessionHandle } from './domain/types';
import type { ResourceClaim, ManagedGrant, ManagedResourceAdapter, ResourceCleanup, ManagedResource } from './domain/resource-api';

describe('simple durable resource facade', () => {
    let fs: IFileSystem, manager: IVFSManager, kernel: Kernel, s1: SessionHandle, s2: SessionHandle;
    const kernels: Kernel[] = [];
    const spec = { program: { kind: 'idle', version: '1' }, input: null, deferStart: true };
    function worker(concurrency = 0) {
        const k = new Kernel({ catalog: { fs, rootPath: '/kernel' }, maxConcurrent: concurrency, pollMs: 0 });
        k.registerStorageResolver({ kind: 'local', async resolve(ref) { return { fs, rootPath: ref.locator as string }; } });
        kernels.push(k); return k;
    }
    beforeEach(async () => {
        ({ manager } = await createVFS({ rootBackend: new MemoryBackend(),}));
        fs = await manager.openFileSystem('/data/test');
        kernel = worker(); await kernel.initialize();
        s1 = await kernel.createSession({ id: 's1', storage: { kind: 'local', locator: '/s1' } });
        s2 = await kernel.createSession({ id: 's2', storage: { kind: 'local', locator: '/s2' } });
    });
    afterEach(async () => { for (const k of kernels.splice(0)) { k.dispose(); await k.waitIdle(); } await manager.dispose(); });
    async function poolHandles() {
        const pool = await result(kernel.resources.create({ requestId: 'pool', kind: 'pool', name: 'browser', capacity: 1 }));
        const t1 = await s1.spawn(spec), t2 = await s2.spawn(spec);
        await result(kernel.resources.share(pool.ref, { requestId: 'share1', toSessionId: s1.id, rights: ['execute'] }));
        await result(kernel.resources.share(pool.ref, { requestId: 'share2', toSessionId: s2.id, rights: ['execute'] }));
        const h1 = await result(s1.resources.open(pool.ref, { requestId: 'open', taskId: t1.id, name: 'browser', rights: ['execute'] }));
        const h2 = await result(s2.resources.open(pool.ref, { requestId: 'open', taskId: t2.id, name: 'browser', rights: ['execute'] }));
        return { pool, t1, t2, h1, h2 };
    }
    async function physicalPool(adapter?: ManagedResourceAdapter) {
        if (adapter) kernel.registerResourceAdapter(adapter);
        const pool = await result(kernel.resources.create({ requestId: 'physical', kind: 'pool', name: 'device', capacity: 1,
            physical: { kind: 'device', version: '1', externalId: 'device-1' } }));
        const t1 = await s1.spawn(spec), t2 = await s2.spawn(spec);
        await result(kernel.resources.share(pool.ref, { requestId: 'p-share1', toSessionId: s1.id, rights: ['execute'] }));
        await result(kernel.resources.share(pool.ref, { requestId: 'p-share2', toSessionId: s2.id, rights: ['execute'] }));
        const h1 = await result(t1.resources.open(pool.ref, { requestId: 'open', name: 'device', rights: ['execute'] }));
        const h2 = await result(t2.resources.open(pool.ref, { requestId: 'open', name: 'device', rights: ['execute'] }));
        return { pool, t1, t2, h1, h2 };
    }
    function deviceAdapter(cleanup: ManagedResourceAdapter['cleanup']): ManagedResourceAdapter {
        return { kind: 'device', version: '1', timeoutMs: 100, cleanup,
            async destroy(c) { return { operationId: c.operationId, epoch: c.epoch, status: 'stopped' }; } };
    }
    async function grantRevision(resourceId: string, sessionId: string) {
        const grants = (await kernel.resources.query({ kind: 'grants', scope: 'kernel', sessionId })).items as ManagedGrant[];
        return grants.find(g => g.resourceId === resourceId)!.revision;
    }

    it('retains physical capacity until an idempotent cleanup confirms reuse', async () => {
        let stopped = false;
        const operations: string[] = [];
        const { pool, t1, t2, h1, h2 } = await physicalPool(deviceAdapter(async c => {
            operations.push(c.operationId);
            // A separate transaction here proves adapter execution is outside the authority transaction.
            expect((await kernel.resources.stat(pool.ref)).held).toBe(1);
            return { operationId: c.operationId, epoch: c.epoch, status: stopped ? 'stopped' : 'pending', retryAfterMs: 25 };
        }));
        const held = await result(t1.resources.acquire(h1, { requestId: 'take', quantity: 1 }));
        const waiting = await t2.resources.acquire(h2, { requestId: 'wait', quantity: 1 });
        const release = await t1.resources.release(held, { requestId: 'release' });
        expect((await release.poll()).status).toBe('pending');
        await expect(t1.resources.validate(held)).rejects.toThrow('not active');
        expect(await kernel.resources.stat(pool.ref)).toMatchObject({ held: 1, waiting: 1 });
        await expect(release.cancel()).rejects.toThrow('cannot cancel');
        stopped = true;
        expect((await release.wait({ timeoutMs: 1000 })).released).toBe(true);
        expect((await waiting.wait({ timeoutMs: 1000 })).released).toBe(false);
        expect(new Set(operations).size).toBe(1);
        expect(operations.length).toBeGreaterThanOrEqual(2);
    });

    it('fails closed for unknown, mismatched and timed out physical cleanup', async () => {
        let mode: 'unknown' | 'wrong' | 'hang' | 'stopped' = 'unknown';
        const { pool, t1, h1 } = await physicalPool(deviceAdapter(async c => {
            if (mode === 'hang') return new Promise(() => {});
            return { operationId: mode === 'wrong' ? 'wrong' : c.operationId, epoch: c.epoch,
                status: mode === 'stopped' ? 'stopped' : 'unknown', retryAfterMs: 25 };
        }));
        const claim = await result(t1.resources.acquire(h1, { requestId: 'take', quantity: 1 }));
        const release = await t1.resources.release(claim, { requestId: 'release' });
        expect((await release.poll()).status).toBe('pending');
        let cleanups = (await kernel.resources.query({ kind: 'cleanups' })).items as ResourceCleanup[];
        expect(cleanups[0].status).toBe('unknown');
        mode = 'wrong';
        await eventually(async () => ((await kernel.resources.query({ kind: 'cleanups' })).items[0] as ResourceCleanup).error?.includes('mismatch') ?? false);
        expect((await kernel.resources.stat(pool.ref)).held).toBe(1);
        mode = 'hang';
        await eventually(async () => ((await kernel.resources.query({ kind: 'cleanups' })).items[0] as ResourceCleanup).error?.includes('timed out') ?? false);
        expect((await kernel.resources.stat(pool.ref)).held).toBe(1);
        mode = 'stopped';
        expect((await release.wait({ timeoutMs: 2000 })).released).toBe(true);
    });

    it('recovers physical cleanup after worker replacement even when the holder is terminal', async () => {
        const ids: string[] = [];
        const { pool, t1, h1 } = await physicalPool(deviceAdapter(async c => {
            ids.push(c.operationId);
            return { operationId: c.operationId, epoch: c.epoch, status: 'pending', retryAfterMs: 25 };
        }));
        const claim = await result(t1.resources.acquire(h1, { requestId: 'take', quantity: 1 }));
        const release = await t1.resources.release(claim, { requestId: 'release' });
        await release.poll();
        await t1.cancel();
        kernel.dispose(); await kernel.waitIdle();
        const replacement = worker();
        replacement.registerResourceAdapter(deviceAdapter(async c => {
            ids.push(c.operationId);
            return { operationId: c.operationId, epoch: c.epoch, status: 'stopped' };
        }));
        await replacement.initialize(); await replacement.recover();
        const restored = await replacement.openTask(t1.id);
        expect((await restored.resources.request('kernel', 'release').wait({ timeoutMs: 1000 }) as ResourceClaim).released).toBe(true);
        expect((await replacement.resources.stat(pool.ref)).held).toBe(0);
        expect(new Set(ids).size).toBe(1);
    });

    it('revokes queued work and cleans active claims without resurrecting old handles on re-share', async () => {
        let stopped = false;
        const { pool, t1, t2, h1, h2 } = await physicalPool(deviceAdapter(async c => ({
            operationId: c.operationId, epoch: c.epoch, status: stopped ? 'stopped' : 'pending', retryAfterMs: 25,
        })));
        const held = await result(t1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const queued = await t2.resources.acquire(h2, { requestId: 'wait', quantity: 1 });
        const revision = await grantRevision(pool.ref.id, s2.id);
        await result(kernel.resources.revoke(pool.ref, { requestId: 'revoke2', toSessionId: s2.id, expectedRevision: revision }));
        expect((await queued.poll()).status).toBe('failed');
        await expect(kernel.resources.revoke(pool.ref, { requestId: 'stale', toSessionId: s2.id, expectedRevision: revision })).rejects.toThrow('revision conflict');
        await result(kernel.resources.share(pool.ref, { requestId: 'share-again', toSessionId: s2.id, rights: ['execute'] }));
        await expect(t2.resources.acquire(h2, { requestId: 'old-handle', quantity: 1 })).rejects.toThrow('epoch revoked');
        const grant1 = await grantRevision(pool.ref.id, s1.id);
        await result(kernel.resources.revoke(pool.ref, { requestId: 'revoke1', toSessionId: s1.id, expectedRevision: grant1 }));
        expect((await kernel.resources.stat(pool.ref)).held).toBe(1);
        await expect(t1.resources.validate(held)).rejects.toThrow('not active');
        stopped = true;
        const release = await t1.resources.release(held, { requestId: 'cleanup-after-revoke' });
        expect((await release.wait({ timeoutMs: 1000 })).released).toBe(true);
        // Immutable acquire replay is historical, not a fresh active allocation.
        expect(await result(t1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }))).toEqual(held);
        expect((await kernel.resources.stat(pool.ref)).held).toBe(0);
    });

    it('preserves unrelated rights when partially revoking a grant', async () => {
        const shared = await result(kernel.resources.create({ requestId: 'shared', name: 'shared', kind: 'shared', value: 'value' }));
        const task = await s1.spawn(spec);
        await result(kernel.resources.share(shared.ref, { requestId: 'share', toSessionId: s1.id, rights: ['read', 'write'] }));
        const handle = await result(task.resources.open(shared.ref, { requestId: 'open', name: 'shared', rights: ['read', 'write'] }));
        await result(kernel.resources.revoke(shared.ref, { requestId: 'revoke', toSessionId: s1.id, rights: ['write'],
            expectedRevision: await grantRevision(shared.ref.id, s1.id) }));
        expect((await result(task.resources.read(handle, { requestId: 'read' }))).value).toBe('value');
        await result(kernel.resources.share(shared.ref, { requestId: 'reshare', toSessionId: s1.id, rights: ['write'] }));
        await expect(task.resources.write(handle, { requestId: 'write', expectedVersion: 1, value: 'changed' })).rejects.toThrow('epoch revoked');
    });

    it('destroys only after claims are reusable and physical deletion is confirmed', async () => {
        let stopped = false, deleted = false, deletes = 0;
        const adapter = deviceAdapter(async c => ({ operationId: c.operationId, epoch: c.epoch,
            status: stopped ? 'stopped' : 'pending', retryAfterMs: 25 }));
        adapter.destroy = async c => { deletes++; return { operationId: c.operationId, epoch: c.epoch,
            status: deleted ? 'stopped' : 'pending', retryAfterMs: 25 }; };
        const { pool, t1, t2, h1, h2 } = await physicalPool(adapter);
        await result(t1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const queued = await t2.resources.acquire(h2, { requestId: 'wait', quantity: 1 });
        const destroy = await kernel.resources.destroy(pool.ref, { requestId: 'destroy', expectedVersion: pool.version });
        expect((await destroy.poll()).status).toBe('pending');
        expect((await queued.poll()).status).toBe('failed');
        expect(deletes).toBe(0);
        await expect(kernel.resources.share(pool.ref, { requestId: 'late-share', toSessionId: s2.id, rights: ['read'] })).rejects.toThrow('closing');
        stopped = true;
        await eventually(async () => deletes > 0);
        expect((await kernel.resources.stat(pool.ref)).resource.state).toBe('closing');
        deleted = true;
        expect((await destroy.wait({ timeoutMs: 1000 })).state).toBe('tombstoned');
        expect((await kernel.resources.stat(pool.ref)).held).toBe(0);
        const fresh = await result(kernel.resources.create({ requestId: 'fresh', kind: 'pool', name: 'device', capacity: 1 }));
        expect(fresh.ref.id).not.toBe(pool.ref.id);
        expect((await result(kernel.resources.destroy(pool.ref, { requestId: 'destroy', expectedVersion: pool.version }))).ref).toEqual(pool.ref);
    });

    it('finishes a kernel-only destroy without any Session driving cleanup', async () => {
        await s1.close(); await s2.close();
        kernel.dispose(); await kernel.waitIdle();
        kernel = worker(); await kernel.initialize();
        let calls = 0;
        kernel.registerResourceAdapter({ ...deviceAdapter(async c => ({ operationId: c.operationId, epoch: c.epoch, status: 'stopped' })),
            async destroy(c) { calls++; return { operationId: c.operationId, epoch: c.epoch, status: 'stopped' }; } });
        const pool = await result(kernel.resources.create({ requestId: 'unused', kind: 'pool', name: 'unused', capacity: 1,
            physical: { kind: 'device', version: '1', externalId: 'unused' } }));
        await kernel.resources.destroy(pool.ref, { requestId: 'destroy-unused', expectedVersion: 1 });
        await eventually(async () => (await kernel.resources.stat(pool.ref)).resource.state === 'tombstoned');
        expect(calls).toBe(1);
    });

    it('queries authority records with live cursors and no unauthorized values or claims', async () => {
        const secret = await result(s1.resources.create({ requestId: 'secret', kind: 'shared', name: 'secret', value: 'private' }));
        const { pool, t1, h1 } = await poolHandles();
        await result(t1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const first = await kernel.resources.query({ kind: 'resources', limit: 1 });
        expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
        const second = await kernel.resources.query({ kind: 'resources', limit: 1, cursor: first.nextCursor });
        expect(second.items).toHaveLength(1);
        expect((first.items[0] as ManagedResource).ref.id).not.toBe((second.items[0] as ManagedResource).ref.id);
        await expect(kernel.resources.query({ kind: 'claims', cursor: first.nextCursor })).rejects.toThrow('cursor');
        const visible = (await s2.resources.query({ kind: 'resources' })).items as ManagedResource[];
        expect(visible.map(r => r.ref.id)).toContain(pool.ref.id);
        expect(visible.map(r => r.ref.id)).not.toContain(secret.ref.id);
        expect((await s2.resources.query({ kind: 'claims' })).items).toEqual([]);
        expect((await kernel.resources.query({ kind: 'claims', sessionId: s1.id, state: 'held' })).items).toHaveLength(1);
        expect((await s2.resources.query({ kind: 'grants', scope: 'kernel' })).items).toEqual([]);
    });

    it('migrates legacy grant arrays without allowing old handles to revive', async () => {
        const { pool, t1, h1 } = await poolHandles();
        const grantKey = `managed/access/${encodeURIComponent(JSON.stringify([pool.ref.id, s1.id]))}`;
        const handleKey = `managed/handle/${encodeURIComponent(h1.id)}`;
        await fs.meta.seq!.transaction!(async tx => {
            await tx.setEntry('/kernel/resources.seq', 'managed/schema', '1');
            await tx.setEntry('/kernel/resources.seq', grantKey, JSON.stringify(['execute']));
            const { grantEpochs: _epochs, ...legacy } = h1;
            await tx.setEntry('/s1/resources.seq', handleKey, JSON.stringify(legacy));
        });
        expect(await grantRevision(pool.ref.id, s1.id)).toBe(0);
        await result(kernel.resources.revoke(pool.ref, { requestId: 'legacy-revoke', toSessionId: s1.id, expectedRevision: 0 }));
        await result(kernel.resources.share(pool.ref, { requestId: 'legacy-reshare', toSessionId: s1.id, rights: ['execute'] }));
        await expect(t1.resources.acquire(h1, { requestId: 'legacy-use', quantity: 1 })).rejects.toThrow('epoch revoked');
        expect(await fs.meta.seq!.getEntry('/kernel/resources.seq', 'managed/schema')).toBe('2');
    });

    it('serializes revoke against acquisition and never leaves a revoked logical claim active', async () => {
        const { pool, t1, h1 } = await poolHandles();
        const revision = await grantRevision(pool.ref.id, s1.id);
        const outcomes = await Promise.allSettled([
            t1.resources.acquire(h1, { requestId: 'race-acquire', quantity: 1 }),
            kernel.resources.revoke(pool.ref, { requestId: 'race-revoke', toSessionId: s1.id, expectedRevision: revision }),
        ]);
        expect(outcomes[1].status).toBe('fulfilled');
        expect((await kernel.resources.stat(pool.ref)).held).toBe(0);
        const claims = (await kernel.resources.query({ kind: 'claims', scope: 'kernel' })).items as ResourceClaim[];
        expect(claims.every(c => c.released)).toBe(true);
        await expect(t1.resources.acquire(h1, { requestId: 'after-revoke', quantity: 1 })).rejects.toThrow('grant denied');
    });

    it('rolls back revoke and cleanup intent with the owning transaction', async () => {
        const { pool, t1, h1 } = await physicalPool();
        const held = await result(t1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const resources = new ManagedResourceStore({ fs, rootPath: '/kernel' }, async id => ({ fs, rootPath: `/${id}` }));
        const command = await resources.prepare({}, { type: 'revoke', ref: pool.ref, requestId: 'rollback-revoke',
            toSessionId: s1.id, expectedRevision: await grantRevision(pool.ref.id, s1.id) });
        await expect(fs.meta.seq!.transaction!(async tx => {
            await executeResourceTx(tx, command);
            throw new Error('reject Decision');
        })).rejects.toThrow('reject Decision');
        expect((await kernel.resources.query({ kind: 'cleanups' })).items).toEqual([]);
        expect(await t1.resources.validate(held)).toEqual(held);
        expect(await grantRevision(pool.ref.id, s1.id)).toBe(1);
    });

    it('resumes destruction with the original operation id after replacement', async () => {
        const ids: string[] = [];
        const adapter = deviceAdapter(async c => ({ operationId: c.operationId, epoch: c.epoch, status: 'stopped' }));
        adapter.destroy = async c => {
            ids.push(c.operationId);
            return { operationId: c.operationId, epoch: c.epoch, status: 'pending', retryAfterMs: 60_000 };
        };
        const { pool } = await physicalPool(adapter);
        const destroy = await kernel.resources.destroy(pool.ref, { requestId: 'destroy', expectedVersion: 1 });
        expect((await destroy.poll()).status).toBe('pending');
        expect(ids).toHaveLength(1);
        kernel.dispose(); await kernel.waitIdle();
        const replacement = worker();
        replacement.registerResourceAdapter({ ...adapter, async destroy(c) {
            ids.push(c.operationId);
            return { operationId: c.operationId, epoch: c.epoch, status: 'stopped' };
        } });
        await replacement.initialize(); await replacement.recover({ takeover: true });
        const receipt = await replacement.resources.request('kernel', 'destroy').wait({ timeoutMs: 1000 }) as ManagedResource;
        expect(receipt.state).toBe('tombstoned');
        expect(new Set(ids).size).toBe(1);
    });

    it('separates control, execution, statistics and legacy records', async () => {
        const task = await s1.spawn(spec);
        expect((await task.stat()).phase).toBe('created');
        await task.pause({ requestId: 'pause' });
        expect(await task.stat()).toMatchObject({ phase: 'waiting', control: { requested: 'pause', acknowledged: true }, blockedBy: 'task-control' });
        await task.resume({ requestId: 'resume' });
        expect((await task.status()).task.id).toBe(task.id);
        expect(await task.stats()).toMatchObject({ completedSteps: 0, attempts: 0 });
        await s1.suspend(); expect(await s1.stat()).toMatchObject({ phase: 'paused' });
    });
    it('runs the narrow core entry point with one isolated step function per Task', async () => {
        const initial = { count: 0 };
        const program = defineTask({ kind: 'simple', version: '1', state: initial,
            step(state, event) {
                return event.type === 'initialize' ? { state: { count: state.count + 1 }, next: { type: 'continue' } }
                    : { state, next: { type: 'complete', output: state.count } };
            },
        });
        initial.count = 99;
        const harness = createHarness({ catalog: { fs, rootPath: '/kernel' }, pollMs: 0 });
        harness.registerStorageResolver({ kind: 'local', async resolve(ref) { return { fs, rootPath: ref.locator as string }; } });
        harness.registerProgram(program);
        try {
            await harness.initialize();
            const session = await harness.openSession(s1.id);
            const a = await session.spawn({ program: program.manifest, input: null });
            const b = await session.spawn({ program: program.manifest, input: null });
            expect((await a.wait({ timeoutMs: 1000 })).output).toBe(1);
            expect((await b.wait({ timeoutMs: 1000 })).output).toBe(1);
        } finally { harness.dispose(); await harness.waitIdle(); }
    });
    it('arbitrates the last shared slot, persists FIFO wait, and wakes on release', async () => {
        const { pool, h1, h2 } = await poolHandles();
        const [a, b] = await Promise.all([
            s1.resources.acquire(h1, { requestId: 'take', quantity: 1 }),
            s2.resources.acquire(h2, { requestId: 'take', quantity: 1 }),
        ]);
        const first = await a.poll(), second = await b.poll();
        expect([first.status, second.status].sort()).toEqual(['pending', 'succeeded']);
        expect(await kernel.resources.stat(pool.ref)).toMatchObject({ held: 1, waiting: 1 });
        const granted = first.status === 'succeeded' ? first : second;
        const owner = first.status === 'succeeded' ? s1 : s2, waiter = first.status === 'pending' ? a : b;
        await result(owner.resources.release(granted.result as ResourceClaim, { requestId: 'release' }));
        expect((await waiter.wait({ timeoutMs: 500 })).released).toBe(false);
        expect(await kernel.resources.stat(pool.ref)).toMatchObject({ held: 1, waiting: 0 });
    });
    it('reconnects to durable requests without allocating twice and rejects conflicting reuse', async () => {
        const { pool, h1 } = await poolHandles();
        const claim = await result(s1.resources.acquire(h1, { requestId: 'once', quantity: 1 }));
        kernel.dispose(); await kernel.waitIdle();
        const replacement = worker(); await replacement.initialize(); await replacement.recover();
        const session = await replacement.openSession(s1.id);
        const same = await result(session.resources.acquire(h1, { requestId: 'once', quantity: 1 }));
        expect(same).toEqual(claim);
        expect((await session.resources.request('kernel', 'once').poll()).result).toEqual(claim);
        await expect(session.resources.acquire(h1, { requestId: 'once', quantity: 2 })).rejects.toThrow('identity conflict');
        expect((await replacement.resources.stat(pool.ref)).held).toBe(1);
    });
    it('does not cancel a durable request when a client wait times out', async () => {
        const { h1, h2 } = await poolHandles();
        const held = await result(s1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const queued = await s2.resources.acquire(h2, { requestId: 'queue', quantity: 1 });
        await expect(queued.wait({ timeoutMs: 1 })).rejects.toThrow('remains pending');
        expect((await queued.poll()).status).toBe('pending');
        await result(s1.resources.release(held, { requestId: 'free' }));
        expect((await queued.wait({ timeoutMs: 500 })).quantity).toBe(1);
    });
    it('persists cancellation tombstones before an acquire arrives', async () => {
        const { pool, h1 } = await poolHandles();
        await s1.resources.request('kernel', 'cancel-first').cancel();
        const request = await s1.resources.acquire(h1, { requestId: 'cancel-first', quantity: 1 });
        expect((await request.poll()).status).toBe('cancelled');
        expect((await kernel.resources.stat(pool.ref)).held).toBe(0);
    });
    it('expires queued requests and fences fabricated releases', async () => {
        const { h1, h2 } = await poolHandles();
        const held = await result(s1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const queued = await s2.resources.acquire(h2, { requestId: 'expired', quantity: 1, deadlineAt: Date.now() - 1 });
        expect((await queued.poll()).status).toBe('failed');
        await expect(s2.resources.release(held, { requestId: 'steal' })).rejects.toThrow('holder mismatch');
        await expect(s1.resources.release({ ...held, token: 'wrong' }, { requestId: 'forged' })).rejects.toThrow('token');
        await expect(s1.resources.close(h1, { requestId: 'close' })).rejects.toThrow('active claims');
        await result(s1.resources.release(held, { requestId: 'free' }));
        await expect(s1.resources.validate(held)).rejects.toThrow('not active');
    });
    it('keeps held capacity through pause and blocks Session close until explicit cleanup', async () => {
        const { pool, h1 } = await poolHandles();
        const held = await result(s1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        await s1.suspend();
        expect((await kernel.resources.stat(pool.ref)).held).toBe(1);
        await expect(s1.resources.validate(held)).rejects.toThrow('not running');
        await s1.close({ cancelRunning: true });
        expect(await s1.stat()).toMatchObject({ phase: 'closing', blockedBy: 'resource-claims' });
        await result(s1.resources.release(held, { requestId: 'cleanup' }));
        await eventually(async () => (await s1.stat()).phase === 'closed');
    });
    it('requires explicit grants and rejects another Task using a copied handle', async () => {
        const pool = await result(kernel.resources.create({ requestId: 'pool', kind: 'pool', name: 'pool', capacity: 1 }));
        const a = await s1.spawn(spec), b = await s1.spawn(spec);
        await expect(a.resources.open(pool.ref, { requestId: 'denied', name: 'pool', rights: ['execute'] })).rejects.toThrow('grant denied');
        await result(kernel.resources.share(pool.ref, { requestId: 'allow', toSessionId: s1.id, rights: ['execute'] }));
        const handle = await result(a.resources.open(pool.ref, { requestId: 'open', name: 'pool', rights: ['execute'] }));
        await expect(b.resources.acquire(handle, { requestId: 'stolen', quantity: 1 })).rejects.toThrow('holder mismatch');
        await expect(a.resources.open(pool.ref, { requestId: 'elevate', name: 'pool2', rights: ['admin'] })).rejects.toThrow('grant denied');
    });
    it('provides versioned shared values and immutable read receipts', async () => {
        const shared = await result(s1.resources.create({ requestId: 'shared', kind: 'shared', name: 'report', value: 'v1' }));
        const task = await s1.spawn(spec);
        const h = await result(s1.resources.open(shared.ref, { requestId: 'open', taskId: task.id, name: 'report', rights: ['read', 'write'] }));
        const read = await result(s1.resources.read(h, { requestId: 'read-v1' }));
        const writes = await Promise.allSettled([
            result(s1.resources.write(h, { requestId: 'a', expectedVersion: 1, value: 'a' })),
            result(s1.resources.write(h, { requestId: 'b', expectedVersion: 1, value: 'b' })),
        ]);
        expect(writes.filter(w => w.status === 'fulfilled')).toHaveLength(1);
        expect(await result(s1.resources.read(h, { requestId: 'read-v1' }))).toEqual(read);
        expect((await result(s1.resources.read(h, { requestId: 'latest' }))).version).toBe(2);
    });
    it('executes resource actions and waits as native durable Decisions', async () => {
        const program: DurableTaskProgram<any> = {
            manifest: { kind: 'resource-program', version: '1' },
            init() { return { state: {}, actions: [{ type: 'resource', command: { type: 'create', requestId: 'create', kind: 'pool', name: 'local', capacity: 1 } }], next: { type: 'wait', on: { type: 'resource', scope: 'session:s1', requestId: 'create' } } }; },
            reduce(state, event) {
                if (event.type !== 'resource-result') return { state, next: { type: 'wait', on: { type: 'resource', scope: 'session:s1', requestId: state.wait ?? 'create' } } };
                const r: any = event.receipt.result;
                if (event.receipt.id === 'release') return { state, next: { type: 'complete', output: r.released } };
                const command: any = event.receipt.id === 'create' ? { type: 'open', requestId: 'open', ref: r.ref, name: 'local', rights: ['execute'] }
                    : event.receipt.id === 'open' ? { type: 'acquire', requestId: 'acquire', handle: r, quantity: 1 }
                    : { type: 'release', requestId: 'release', claim: r };
                return { state: { wait: command.requestId }, actions: [{ type: 'resource', command }], next: { type: 'wait', on: { type: 'resource', scope: 'session:s1', requestId: command.requestId } } };
            },
        };
        const runner = worker(1); runner.registerProgram(program); await runner.initialize();
        const s = await runner.openSession(s1.id);
        const task = await s.spawn({ program: program.manifest, input: null });
        expect((await task.wait({ timeoutMs: 2000 })).output).toBe(true);
        expect((await task.stat()).phase).toBe('done');
        expect((await task.stats()).completedSteps).toBeGreaterThanOrEqual(5);
    });
    it('rolls back resource mutations together with a rejected Decision', async () => {
        const runner = worker(1);
        runner.registerProgram({ manifest: { kind: 'rollback', version: '1' }, init() {
            return { state: 'must-not-commit', actions: [
                { type: 'resource', command: { type: 'create', requestId: 'new', kind: 'pool', name: 'rolled-back', capacity: 1 } },
                { type: 'resource', command: { type: 'create', requestId: 'invalid', kind: 'pool', name: 'bad', capacity: 0 } },
            ], next: { type: 'continue' } };
        }, reduce() { throw new Error('unreachable'); } });
        await runner.initialize(); const s = await runner.openSession(s1.id);
        const task = await s.spawn({ program: { kind: 'rollback', version: '1' }, input: null, retry: { maxAttempts: 1 } });
        expect((await task.wait({ timeoutMs: 2000 })).status).toBe('failed');
        expect((await task.status()).task.state).toBeUndefined();
        await expect(task.resources.request('session:s1', 'new').poll()).rejects.toThrow('not found');
    });
    it('refuses a Decision resource write whose authority epoch was superseded', async () => {
        await s1.resources.claimAuthority('decision-authority', { ownerId: 'leader-a' });
        const runner = worker(1);
        runner.registerProgram({ manifest: { kind: 'fenced-write', version: '1' }, init() {
            return { state: 'must-not-commit', actions: [{ type: 'resource', command: { type: 'create', requestId: 'fenced', kind: 'pool',
                name: 'fenced', capacity: 1, authority: { authorityId: 'decision-authority', epoch: 1 } } }], next: { type: 'continue' } };
        }, reduce() { throw new Error('unreachable'); } });
        await runner.initialize();
        const s = await runner.openSession(s1.id);
        await s.resources.claimAuthority('decision-authority', { ownerId: 'leader-b', expectedEpoch: 1 });
        const task = await s.spawn({ program: { kind: 'fenced-write', version: '1' }, input: null, retry: { maxAttempts: 1 } });
        const settled = await task.wait({ timeoutMs: 2000 });
        expect(settled.status).toBe('failed');
        expect(settled.error?.message).toContain('Authority epoch conflict');
        await expect(task.resources.request('session:s1', 'fenced').poll()).rejects.toThrow('not found');
    });
    it('recovers a Task waiting for capacity and delivers its result once after replacement', async () => {
        const { pool, h1 } = await poolHandles();
        const held = await result(s1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const program: DurableTaskProgram<any> = {
            manifest: { kind: 'wait-for-pool', version: '1' },
            init() { return { state: { wait: 'open' }, actions: [{ type: 'resource', command: { type: 'open', requestId: 'open', ref: pool.ref, name: 'pool', rights: ['execute'] } }],
                next: { type: 'wait', on: { type: 'resource', scope: 'kernel', requestId: 'open' } } }; },
            reduce(state, event) {
                if (event.type !== 'resource-result') return { state, next: { type: 'wait', on: { type: 'resource', scope: 'kernel', requestId: state.wait } } };
                if (event.receipt.id === 'take') return { state, next: { type: 'complete', output: event.receipt.result } };
                return { state: { wait: 'take' }, actions: [{ type: 'resource', command: { type: 'acquire', requestId: 'take', handle: event.receipt.result as any, quantity: 1 } }],
                    next: { type: 'wait', on: { type: 'resource', scope: 'kernel', requestId: 'take' } } };
            },
        };
        const runner = worker(1); runner.registerProgram(program); await runner.initialize();
        const task = await (await runner.openSession(s2.id)).spawn({ program: program.manifest, input: null });
        await eventually(async () => { try { return (await task.resources.request('kernel', 'take').poll()).status === 'pending'; } catch { return false; } });
        runner.dispose(); await runner.waitIdle();
        const replacement = worker(1); replacement.registerProgram(program); await replacement.initialize(); await replacement.recover();
        const restored = await replacement.openTask(task.id);
        await result(s1.resources.release(held, { requestId: 'free' }));
        const exit = await restored.wait({ timeoutMs: 2000 });
        expect((exit.output as ResourceClaim).quantity).toBe(1);
        await restored.resources.request('kernel', 'take').poll();
        const events = await replacement.eventList(s2.id);
        expect(events.filter(e => e.type === 'resource.resolved' && e.taskId === task.id && (e.payload as any).requestId === 'take')).toHaveLength(1);
    });
    it('preserves queued requests across Session suspend/resume', async () => {
        const { h1, h2 } = await poolHandles();
        const held = await result(s1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const waiting = await s2.resources.acquire(h2, { requestId: 'wait', quantity: 1 });
        await s2.suspend(); await result(s1.resources.release(held, { requestId: 'free' }));
        expect((await waiting.poll()).status).toBe('pending');
        await s2.resume(); expect((await waiting.wait({ timeoutMs: 1000 })).quantity).toBe(1);
    });
    it('keeps paused Task requests pending until resume', async () => {
        const { h1, h2, t2 } = await poolHandles();
        const held = await result(s1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const waiting = await t2.resources.acquire(h2, { requestId: 'wait', quantity: 1 });
        await t2.pause({ requestId: 'pause' });
        await result(s1.resources.release(held, { requestId: 'free' }));
        expect((await waiting.poll()).status).toBe('pending');
        await t2.resume({ requestId: 'resume' });
        expect((await waiting.wait({ timeoutMs: 1000 })).quantity).toBe(1);
    });
    it('settles orphaned waiters without rolling back another holder release', async () => {
        const { pool, h1, h2, t2 } = await poolHandles();
        const held = await result(s1.resources.acquire(h1, { requestId: 'hold', quantity: 1 }));
        const waiting = await t2.resources.acquire(h2, { requestId: 'wait', quantity: 1 });
        await s2.suspend();
        await fs.meta.seq!.deleteEntry(`/s2/tasks/${t2.id}/task.seq`, 'record');
        await result(s1.resources.release(held, { requestId: 'free' }));
        expect(await waiting.poll()).toMatchObject({ status: 'failed', error: expect.stringContaining('missing or terminal') });
        expect(await kernel.resources.stat(pool.ref)).toMatchObject({ held: 0, waiting: 0 });
    });
    it('does not reuse cache versions after eviction or accept stale CAS', async () => {
        const task = await s1.spawn(spec);
        const cache = await task.createCache({ name: 'bounded', scope: 'session', maxEntries: 1 });
        const publish = (operationId: string, key: string, expectedVersion?: number) => task.publishCache({
            operationId, handleId: cache.handle.id, key, fingerprint: 'same', value: operationId,
            expectedGeneration: cache.namespace.generation, expectedVersion,
        });
        const first = await publish('first', 'x');
        await publish('evict', 'y');
        const second = await publish('second', 'x');
        expect(second.version).toBe(first.version + 1);
        await expect(publish('stale', 'x', first.version)).rejects.toThrow('version conflict');
        expect(await task.readCache({ operationId: 'stale-read', sources: [{
            handleId: cache.handle.id, key: 'x', fingerprint: 'same', expectedVersion: first.version,
        }] })).toMatchObject({ status: 'miss' });
        expect(await publish('first', 'x')).toEqual(first);
    });
    it('rejects cross-module sharing before registering a handle', async () => {
        const pool = await result(kernel.resources.create({ requestId: 'pool', kind: 'pool', name: 'pool', capacity: 1 }));
        // Even a wrapper with the same apparent module id cannot prove transaction identity.
        const alternate = Object.create(fs) as IFileSystem;
        kernel.registerStorageResolver({ kind: 'other', async resolve() { return { fs: alternate, rootPath: '/other' }; } });
        const other = await kernel.createSession({ id: 'other', storage: { kind: 'other', locator: null } });
        const task = await other.spawn(spec);
        await result(kernel.resources.share(pool.ref, { requestId: 'allow', toSessionId: other.id, rights: ['execute'] }));
        await expect(other.resources.open(pool.ref, { requestId: 'open', taskId: task.id, rights: ['execute'], name: 'pool' })).rejects.toThrow('Cross-backend');
        expect(await other.resources.list()).toEqual([]);
    });
    it('fences a superseded authority leader by the ownerEpoch it presents', async () => {
        const first = await kernel.resources.claimAuthority('browser-authority', { ownerId: 'leader-a' });
        expect(first).toMatchObject({ authorityId: 'browser-authority', ownerEpoch: 1, ownerId: 'leader-a', status: 'active' });
        const pool = await result(kernel.resources.create({ requestId: 'a-create', kind: 'pool', name: 'browser', capacity: 1,
            authority: { authorityId: 'browser-authority', epoch: 1 } }));
        expect(pool.ref.scope).toBe('kernel');

        await expect(kernel.resources.claimAuthority('browser-authority', { ownerId: 'leader-b', expectedEpoch: 7 }))
            .rejects.toThrow('Authority epoch conflict: browser-authority is owned by leader-a at epoch 1');
        const second = await kernel.resources.claimAuthority('browser-authority', { ownerId: 'leader-b', expectedEpoch: 1 });
        expect(second.ownerEpoch).toBe(2);

        // The superseded leader's new write is refused; the current leader's write succeeds.
        await expect(result(kernel.resources.create({ requestId: 'a-stale', kind: 'shared', name: 'stale',
            authority: { authorityId: 'browser-authority', epoch: 1 } })))
            .rejects.toThrow('Authority epoch conflict: browser-authority is owned by leader-b at epoch 2');
        await expect(result(kernel.resources.create({ requestId: 'b-unknown', kind: 'shared', name: 'unknown',
            authority: { authorityId: 'nobody', epoch: 1 } }))).rejects.toThrow('Unknown authority nobody');
        const shared = await result(kernel.resources.create({ requestId: 'b-create', kind: 'shared', name: 'current', value: 1,
            authority: { authorityId: 'browser-authority', epoch: 2 } }));
        expect(shared).toMatchObject({ kind: 'shared', name: 'current' });

        // An accepted request replays its recorded result instead of being re-fenced.
        const replay = await result(kernel.resources.create({ requestId: 'a-create', kind: 'pool', name: 'browser', capacity: 1,
            authority: { authorityId: 'browser-authority', epoch: 1 } }));
        expect(replay.ref).toEqual(pool.ref);
        expect(await kernel.resources.authority('browser-authority')).toMatchObject({ ownerEpoch: 2, ownerId: 'leader-b' });
    });

    it.each(['missing', 'substituted', 'stale'] as const)('rejects %s authority on bound resource mutations after reconstruction', async mode => {
        await s1.resources.claimAuthority('owner', {});
        await s1.resources.claimAuthority('other', {});
        const authority = { authorityId: 'owner', epoch: 1 };
        const resource = await result(s1.resources.create({ requestId: 'bound', kind: 'shared', name: 'bound', value: 0, authority }));
        const task = await s1.spawn(spec);
        const handle = await result(s1.resources.open(resource.ref, { requestId: 'open-bound', taskId: task.id, name: 'bound', rights: ['read', 'write'], authority }));
        const written = await result(s1.resources.write(handle, { requestId: 'accepted', expectedVersion: 1, value: 1, authority }));
        const reopened = worker(); await reopened.initialize();
        const session = await reopened.openSession('s1');
        await session.resources.claimAuthority('owner', { expectedEpoch: 1 });
        const fence = mode === 'missing' ? {} : { authority: { authorityId: mode === 'substituted' ? 'other' : 'owner', epoch: 1 } };
        const message = mode === 'stale' ? 'Authority epoch conflict' : 'Resource authority mismatch';
        await expect(result(session.resources.write(handle, { requestId: 'bad-write', expectedVersion: 2, value: 99, ...fence }))).rejects.toThrow(message);
        await expect(result(session.resources.share(resource.ref, { requestId: 'bad-share', toSessionId: 's2', rights: ['read'], ...fence }))).rejects.toThrow(message);
        await expect(result(session.resources.destroy(resource.ref, { requestId: 'bad-destroy', expectedVersion: 2, ...fence }))).rejects.toThrow(message);
        await expect(result(session.resources.close(handle, { requestId: 'bad-close', ...fence }))).rejects.toThrow(message);
        expect(await result(s1.resources.write(handle, { requestId: 'accepted', expectedVersion: 1, value: 1, authority }))).toEqual(written);
        expect(await result(session.resources.read(handle, { requestId: 'read-bound' }))).toMatchObject({ value: 1, version: 2 });
        expect(await result(session.resources.write(handle, { requestId: 'current', expectedVersion: 2, value: 2,
            authority: { authorityId: 'owner', epoch: 2 } }))).toMatchObject({ value: 2, version: 3, authorityId: 'owner' });
    });

    it('fences queued allocation after authority takeover without losing held capacity', async () => {
        await s1.resources.claimAuthority('pool-owner', {});
        const authority = { authorityId: 'pool-owner', epoch: 1 };
        const pool = await result(s1.resources.create({ requestId: 'bound-pool', kind: 'pool', name: 'pool', capacity: 1, authority }));
        const task = await s1.spawn(spec);
        await expect(result(s1.resources.open(pool.ref, { requestId: 'missing-open', taskId: task.id, name: 'bad', rights: ['execute'] })))
            .rejects.toThrow('Resource authority mismatch');
        const handle = await result(s1.resources.open(pool.ref, { requestId: 'pool-open', taskId: task.id, name: 'pool', rights: ['execute'], authority }));
        const held = await result(s1.resources.acquire(handle, { requestId: 'hold-bound', quantity: 1, authority }));
        const waiting = await s1.resources.acquire(handle, { requestId: 'wait-bound', quantity: 1, authority });
        expect((await waiting.poll()).status).toBe('pending');
        await s1.resources.claimAuthority('pool-owner', { expectedEpoch: 1 });
        await expect(result(s1.resources.release(held, { requestId: 'missing-release' }))).rejects.toThrow('Resource authority mismatch');
        await expect(result(s1.resources.acquire(handle, { requestId: 'missing-acquire', quantity: 1 }))).rejects.toThrow('Resource authority mismatch');
        await expect(result(s1.resources.revoke(pool.ref, { requestId: 'missing-revoke', toSessionId: 's2', expectedRevision: 0 })))
            .rejects.toThrow('Resource authority mismatch');
        const current = { authorityId: 'pool-owner', epoch: 2 };
        await result(s1.resources.release(held, { requestId: 'current-release', authority: current }));
        expect(await waiting.poll()).toMatchObject({ status: 'failed', error: expect.stringContaining('Authority epoch conflict') });
        expect(await result(s1.resources.acquire(handle, { requestId: 'current-acquire', quantity: 1, authority: current })))
            .toMatchObject({ quantity: 1, released: false });
    });

    it('upgrades authority stores to schema 3 and preserves the gate on ordinary writes', async () => {
        await result(s1.resources.create({ requestId: 'legacy', kind: 'shared', name: 'legacy' }));
        expect(await fs.meta.seq!.getEntry('/s1/resources.seq', 'managed/schema')).toBe('2');
        await s1.resources.claimAuthority('gated', {});
        expect(await fs.meta.seq!.getEntry('/s1/resources.seq', 'managed/schema')).toBe('3');
        await result(s1.resources.create({ requestId: 'ordinary', kind: 'shared', name: 'ordinary' }));
        expect(await fs.meta.seq!.getEntry('/s1/resources.seq', 'managed/schema')).toBe('3');
        const reopened = worker(); await reopened.initialize();
        expect(await (await reopened.openSession('s1')).resources.authority('gated')).toMatchObject({ ownerEpoch: 1 });
    });

    it('allows only one concurrent takeover of an observed authority epoch', async () => {
        await kernel.resources.claimAuthority('contended', {});
        const reopened = worker(); await reopened.initialize();
        const attempts = await Promise.allSettled([
            kernel.resources.claimAuthority('contended', { expectedEpoch: 1, ownerId: 'a' }),
            reopened.resources.claimAuthority('contended', { expectedEpoch: 1, ownerId: 'b' }),
        ]);
        expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
        expect(await reopened.resources.authority('contended')).toMatchObject({ ownerEpoch: 2 });
    });

    it('keeps the authority binding fixed to the first claim and survives Kernel reconstruction', async () => {
        expect(await kernel.resources.authority('shared-pool')).toBeUndefined();
        await kernel.resources.claimAuthority('shared-pool', { ownerId: 'leader-a', serviceEndpoint: 'unix:///run/pool' });
        expect(await kernel.resources.authority('shared-pool')).toMatchObject({ ownerEpoch: 1, serviceEndpoint: 'unix:///run/pool' });
        expect((await kernel.resources.authority('shared-pool'))!.binding).toBeTruthy();

        // A store that does not hold the record cannot take it over, and a takeover that
        // declares a different storage binding is refused: the first claim fixes the binding.
        await expect(s1.resources.claimAuthority('shared-pool', { ownerId: 'leader-b', expectedEpoch: 1 }))
            .rejects.toThrow('Unknown authority shared-pool');
        await expect(kernel.resources.claimAuthority('shared-pool', { ownerId: 'leader-b', expectedEpoch: 1, binding: 'other-store' }))
            .rejects.toThrow('bound to another storage binding');

        const reopened = worker(); await reopened.initialize();
        expect(await reopened.resources.authority('shared-pool')).toMatchObject({ ownerEpoch: 1, ownerId: 'leader-a' });
        const taken = await reopened.resources.claimAuthority('shared-pool', { ownerId: 'leader-b', expectedEpoch: 1 });
        expect(taken).toMatchObject({ ownerEpoch: 2, ownerId: 'leader-b', serviceEndpoint: 'unix:///run/pool' });
        await expect(kernel.resources.claimAuthority('shared-pool', { ownerId: 'leader-a', expectedEpoch: 1 }))
            .rejects.toThrow('Authority epoch conflict: shared-pool is owned by leader-b at epoch 2');
    });

    it('refuses Session authority takeover outside its own scope', async () => {
        await kernel.resources.claimAuthority('service', { ownerId: 'host' });
        await s2.resources.claimAuthority('service', { ownerId: 's2-host' });
        for (const scope of ['kernel', 'session:s2']) {
            await expect(s1.resources.claimAuthority('service', { scope, ownerId: 'intruder', expectedEpoch: 1 }))
                .rejects.toThrow('Authority scope denied');
        }
        expect(await kernel.resources.authority('service')).toMatchObject({ ownerId: 'host', ownerEpoch: 1 });
        expect(await s2.resources.authority('service')).toMatchObject({ ownerId: 's2-host', ownerEpoch: 1 });
    });

    it('refuses authority epoch overflow without changing the record', async () => {
        const initial = await kernel.resources.claimAuthority('limit', { ownerId: 'host' });
        const path = '/kernel/resources.seq', key = 'managed/authority/limit';
        const saved = { ...initial, ownerEpoch: Number.MAX_SAFE_INTEGER };
        await fs.meta.seq!.setEntry(path, key, JSON.stringify(saved));
        await expect(kernel.resources.claimAuthority('limit', { ownerId: 'next', expectedEpoch: Number.MAX_SAFE_INTEGER }))
            .rejects.toThrow('Authority epoch exhausted');
        expect(await kernel.resources.authority('limit')).toEqual(saved);
    });

    it('rejects invalid authority claims and epoch presentations', async () => {
        await expect(kernel.resources.claimAuthority('  ', { ownerId: 'a' })).rejects.toThrow('Resource identity/name is required');
        await expect(kernel.resources.claimAuthority('auth', { ownerId: '' })).rejects.toThrow('Resource identity/name is required');
        await expect(kernel.resources.claimAuthority('auth', { expectedEpoch: -1 })).rejects.toThrow('non-negative safe integer');
        await expect(kernel.resources.claimAuthority('auth', { expectedEpoch: 0 })).rejects.toThrow('the first claim takes no expected epoch');
        await expect(result(kernel.resources.create({ requestId: 'bad-epoch', kind: 'shared', name: 'x',
            authority: { authorityId: 'auth', epoch: 0 } }))).rejects.toThrow('positive safe integer');
        // A Session-scoped authority is owned by that Session's store, independently of the kernel.
        const session = await s1.resources.claimAuthority('session-authority', { ownerId: 's1-leader' });
        expect(session.ownerEpoch).toBe(1);
        expect(await s1.resources.authority('session-authority')).toMatchObject({ ownerEpoch: 1, ownerId: 's1-leader' });
        expect(await kernel.resources.authority('session-authority')).toBeUndefined();
    });
    it('keeps Session cache usable after the creator Task record is removed', async () => {
        const creator = await s1.spawn(spec), reader = await s1.spawn(spec);
        const cache = await creator.createCache({ name: 'session-cache', scope: 'session' });
        const grant = await s1.grantResource(cache.handle.id, reader.id, ['read']);
        await creator.publishCache({ operationId: 'fill', handleId: cache.handle.id, key: 'x', fingerprint: 'v1', value: 'kept', expectedGeneration: cache.namespace.generation });
        await creator.cancel();
        await fs.meta.seq!.deleteEntry(`/s1/tasks/${creator.id}/task.seq`, 'record');
        const receipt = await reader.readCache({ operationId: 'read', sources: [{ handleId: grant.id, key: 'x', fingerprint: 'v1' }] });
        expect(receipt.value).toBe('kept');
    });
});

async function eventually(test: () => Promise<boolean>) {
    const until = Date.now() + 1500;
    while (!await test()) { if (Date.now() >= until) throw new Error('Condition did not converge'); await new Promise(r => setTimeout(r, 10)); }
}
