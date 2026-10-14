import { afterEach, expect, it, vi } from 'vitest';
import { bindingToken, OperationManager, randomId, type CoordinationGuard, type SyncState } from '@itookit/vfs-sync';
import { IndexedDBSyncCoordinator, IndexedDBSyncStore } from '../src';
import { IndexedDBLeaseGuard } from '../src/indexeddb/lease';
import { IndexedDBBackend, ALL_STORES, STORE_RECORDS, txDone } from '@itookit/vfsdriver-indexeddb';
const backends: IndexedDBBackend[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(backends.splice(0).map(b => b.close())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function setup() {
    const backend = new IndexedDBBackend({ dbName: 'lease-' + randomId() }); backends.push(backend); await backend.init(); await backend.mkdir('/work');
    const state: SyncState = { schemaVersion: 1, binding: { bindingId: 'b', bindingRevision: '1', locatorRevision: '1', policyRevision: '1', scopeRevision: '1',
        state: 'active', authorityId: 'a', namespaceId: 'personal', historyEpoch: 'e', projectId: 'p', localProjectId: 'l',
        replicaId: 'r', sourceId: backend.storageAccess().identity, root: '/work', datasetId: 'files', direction: 'both' }, nextSeq: '1', baseline: [], history: [] };
    const store = new IndexedDBSyncStore(backend.storageAccess(), 'b'); await store.initialize(state); return { backend, store, state };
}
it('serializes separate coordinators in one database without Web Locks or new tables', async () => {
    vi.stubGlobal('navigator', {});
    const { backend } = await setup(), access = backend.storageAccess();
    const a = new IndexedDBSyncCoordinator(access, { retryMs: 1 }), b = new IndexedDBSyncCoordinator(access, { retryMs: 1 });
    const entered = deferred<void>(), release = deferred<void>(), events: string[] = [];
    const first = a.exclusive('same', async () => { events.push('a'); entered.resolve(); await release.promise; events.push('a-end'); });
    await entered.promise;
    const second = b.exclusive('same', async () => { events.push('b'); });
    await b.exclusive('other', async () => { events.push('other'); });
    expect(events).toEqual(['a', 'other']); release.resolve(); await Promise.all([first, second]);
    expect(events).toEqual(['a', 'other', 'a-end', 'b']);
    const tx = access.transaction(STORE_RECORDS, 'readonly'), done = txDone(tx);
    expect(Array.from(tx.db.objectStoreNames).sort()).toEqual([...ALL_STORES].sort()); await done;
    expect(await backend.stat('/var/lib/sync/coordination.seq')).not.toBeNull();
});
it('fences all stale local mutations after takeover and keeps the new owner intact', async () => {
    const { backend, store, state } = await setup(); let now = 0;
    const options = { now: () => now, leaseMs: 20000, heartbeatMs: 10000, retryMs: 1 };
    const a = new IndexedDBSyncCoordinator(backend.storageAccess(), options), b = new IndexedDBSyncCoordinator(backend.storageAccess(), options);
    const entered = deferred<CoordinationGuard>(), release = deferred<void>();
    const first = a.exclusive('b', async guard => { entered.resolve(guard!); await release.promise; });
    const rejected = expect(first).rejects.toThrow('SYNC_COORDINATION_LOST');
    const old = await entered.promise, stale = store.scoped(old); now = 20001;
    await b.exclusive('b', async guard => {
        expect(BigInt((guard as IndexedDBLeaseGuard).lease.fence)).toBe(BigInt((old as IndexedDBLeaseGuard).lease.fence) + 1n);
        await expect(stale.update(s => ({ ...s, nextSeq: '999' }))).rejects.toThrow('SYNC_COORDINATION_LOST');
        await expect(stale.persistPlan('stale', {})).rejects.toThrow('SYNC_COORDINATION_LOST');
        await expect(stale.putObject(new Uint8Array([1]))).rejects.toThrow('SYNC_COORDINATION_LOST');
        await expect(stale.apply(bindingToken(state.binding), [], [], 'stale')).rejects.toThrow('SYNC_COORDINATION_LOST');
        await expect(stale.initialize(state)).rejects.toThrow('SYNC_COORDINATION_LOST');
        await expect(stale.capture()).rejects.toThrow('SYNC_COORDINATION_LOST');
        release.resolve(); await rejected;
        await guard!.check(); await store.scoped(guard!).update(s => ({ ...s, nextSeq: '2' }));
    });
    expect((await store.read()).nextSeq).toBe('2'); expect(await store.plan('stale')).toBeUndefined();
    await expect(store.scoped(old).read()).rejects.toThrow('SYNC_COORDINATION_LOST');
});
it('recovers the same pending cloud command when an old response returns after takeover', async () => {
    const { backend, store } = await setup(); let now = 0;
    const options = { now: () => now, leaseMs: 20000, heartbeatMs: 10000, retryMs: 1 };
    const a = new IndexedDBSyncCoordinator(backend.storageAccess(), options), b = new IndexedDBSyncCoordinator(backend.storageAccess(), options);
    const sent = deferred<void>(), response = deferred<void>();
    let committed: import('@itookit/vfs-sync').Receipt;
    const remote = { execute: vi.fn(async (command: import('@itookit/vfs-sync').Command) => {
        committed = { operation: command.body, outcome: 'committed' } as typeof committed;
        sent.resolve(); await response.promise; return committed;
    }), operation: vi.fn(async () => committed), cancel: vi.fn(), replica: vi.fn() };
    const first = new OperationManager(store, remote, a, randomId).execute('publish', {});
    const rejected = expect(first).rejects.toThrow('SYNC_COORDINATION_LOST');
    await sent.promise; const pending = (await store.read()).pending!.command; now = 20001;
    await new OperationManager(store, remote, b, randomId).recover();
    response.resolve(); await rejected;
    const result = await store.read(); expect(result.pending).toBeUndefined(); expect(result.nextSeq).toBe('2');
    expect(result.history.map(p => p.command)).toEqual([pending]); expect(remote.execute).toHaveBeenCalledTimes(1);
});
it('reports contention without stealing a live lease', async () => {
    const { backend } = await setup(), a = new IndexedDBSyncCoordinator(backend.storageAccess());
    await a.exclusive('busy', async guard => {
        const b = new IndexedDBSyncCoordinator(backend.storageAccess(), { retryMs: 1, timeoutMs: 5 });
        await expect(b.exclusive('busy', async () => {})).rejects.toMatchObject({ code: 'SYNC_COORDINATION_BUSY' });
        await guard!.check();
    });
});
it('renews a live lease before its original expiry', async () => {
    const { backend } = await setup(); let now = 0, heartbeat!: () => void;
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
        heartbeat = callback as () => void; return 0 as unknown as ReturnType<typeof setInterval>;
    });
    try {
        const coordinator = new IndexedDBSyncCoordinator(backend.storageAccess(), { now: () => now, leaseMs: 20000, heartbeatMs: 10000 });
        await coordinator.exclusive('renew', async guard => {
            now = 15000; heartbeat(); await guard!.check();
            now = 20001; await guard!.check();
        });
    } finally { timer.mockRestore(); }
});
it('retains the outer binding guard inside a nested sequence scope', async () => {
    const { backend, store } = await setup(); let now = 0;
    const options = { now: () => now, leaseMs: 20000, heartbeatMs: 10000 };
    const a = new IndexedDBSyncCoordinator(backend.storageAccess(), options), b = new IndexedDBSyncCoordinator(backend.storageAccess(), options);
    const entered = deferred<CoordinationGuard>(), release = deferred<void>();
    const first = a.exclusive('binding', async guard => { entered.resolve(guard!); await release.promise; });
    const rejected = expect(first).rejects.toThrow('SYNC_COORDINATION_LOST');
    const outer = await entered.promise; now = 20001;
    await b.exclusive('binding', async () => {
        await a.exclusive('sequence', async inner => {
            const scoped = store.scoped(outer).scoped(inner!);
            await expect(scoped.update(s => ({ ...s, nextSeq: '5' }))).rejects.toThrow('SYNC_COORDINATION_LOST');
        });
    });
    release.resolve(); await rejected; expect((await store.read()).nextSeq).toBe('1');
});
