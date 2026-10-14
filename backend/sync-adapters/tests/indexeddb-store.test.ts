import { afterEach, describe, it, expect } from 'vitest';
import { bindingToken, sha256, type SyncState, type FileAction } from '@itookit/vfs-sync';
import { makeSyncEdit, IndexedDBFileLocal, IndexedDBSyncStore } from '../src';
import { freshIDB } from './helpers/indexeddb';
import { ALL_STORES, IDBRecordStore, STORE_RECORDS, txDone } from '@itookit/vfsdriver-indexeddb';
const encoder = new TextEncoder();
const backends: ReturnType<typeof freshIDB>[] = [];
afterEach(async () => { await Promise.all(backends.splice(0).map(b => b.close())); });
async function setup() {
    const backend = freshIDB('sync'); backends.push(backend); await backend.init(); await backend.mkdir('/work');
    const state: SyncState = { schemaVersion: 1, binding: { bindingId: 'b', bindingRevision: '1', locatorRevision: '1', policyRevision: '1', scopeRevision: '1',
        state: 'active', authorityId: 'a', namespaceId: 'personal', historyEpoch: 'e', projectId: 'p', localProjectId: 'l',
        replicaId: 'r', sourceId: 'idb', root: '/work', datasetId: 'files', direction: 'both' }, nextSeq: '1', baseline: [], history: [] };
    const store = new IndexedDBSyncStore(backend.storageAccess(), 'b'); await store.initialize(state); return { backend, store, state };
}
async function file(path: string, text: string) { return { kind: 'file' as const, path, hash: await sha256(encoder.encode(text)), size: String(text.length) }; }
describe('native IndexedDB sync application', () => {
    it('uses the existing SeqFile record store without adding database tables', async () => {
        const { backend, store, state } = await setup();
        const tx = backend.storageAccess().transaction(STORE_RECORDS, 'readonly'), done = txDone(tx);
        expect(Array.from(tx.db.objectStoreNames).sort()).toEqual([...ALL_STORES].sort());
        const records = new IDBRecordStore(tx.objectStore(STORE_RECORDS));
        expect(JSON.parse(await records.getRecordField('/var/lib/sync/b/state.seq', 'state') as string)).toEqual(state);
        await done;
        expect(await IndexedDBSyncStore.list(backend.storageAccess())).toEqual([state]);
        await store.persistPlan('portable', { bytes: new Uint8Array([0, 128, 255]).buffer });
        expect(new Uint8Array((await store.plan<{ bytes: ArrayBuffer }>('portable'))!.bytes)).toEqual(new Uint8Array([0, 128, 255]));
    });
    it('commits bytes and baseline in one transaction', async () => {
        const { backend, store, state } = await setup(); await backend.write('/work/a', encoder.encode('0'));
        const capture = await store.capture(), output = await file('a', '1');
        await store.apply(bindingToken(state.binding), [makeSyncEdit('/work', 'a', capture.nodes.a, output, encoder.encode('1'))],
            [{ path: 'a', output, side: 'download' }], 'apply');
        expect(new TextDecoder().decode(await backend.read('/work/a'))).toBe('1'); expect((await store.read()).baseline).toEqual([output]);
    });
    it('rejects changed input and does not partially replace another file', async () => {
        const { backend, store, state } = await setup();
        await backend.write('/work/a', encoder.encode('0')); await backend.write('/work/b', encoder.encode('0'));
        const capture = await store.capture(); await backend.write('/work/b', encoder.encode('user'));
        const actions: FileAction[] = [{ path: 'a', output: await file('a', '1'), side: 'download' }, { path: 'b', output: await file('b', '1'), side: 'download' }];
        await expect(store.apply(bindingToken(state.binding), actions.map(a => makeSyncEdit('/work', a.path, capture.nodes[a.path], a.output, encoder.encode('1'))), actions, 'apply')).rejects.toThrow('LOCAL_CHANGED');
        expect(new TextDecoder().decode(await backend.read('/work/a'))).toBe('0'); expect((await store.read()).baseline).toEqual([]);
    });
    it('does not apply an old plan after rebinding', async () => {
        const { store, state } = await setup();
        await store.update(s => ({ ...s, binding: { ...s.binding, root: '/new', locatorRevision: '2' } }));
        await expect(store.apply(bindingToken(state.binding), [], [], 'old')).rejects.toThrow('PLAN_BINDING_CHANGED');
    });
    it('refuses parent deletion when an unselected child still exists', async () => {
        const { backend, store, state } = await setup(); await backend.mkdir('/work/dir'); await backend.write('/work/dir/secret', encoder.encode('keep'));
        const capture = await store.capture();
        await expect(store.apply(bindingToken(state.binding), [makeSyncEdit('/work', 'dir', capture.nodes.dir, undefined)], [], 'delete')).rejects.toThrow('DIRECTORY_GROUP_BLOCKED');
        expect(await backend.stat('/work/dir/secret')).not.toBeNull();
    });
    it('confirms uploaded P and retains a later local edit P2', async () => {
        const { backend, store, state } = await setup(); await backend.write('/work/a', encoder.encode('P'));
        const local = new IndexedDBFileLocal(store), captured = await local.capture(), output = await file('a', 'P');
        await backend.write('/work/a', encoder.encode('P2'));
        await local.apply(bindingToken(state.binding), captured.handle, [{ path: 'a', output, side: 'upload' }], 'publish');
        expect((await store.read()).baseline).toEqual([output]); expect(new TextDecoder().decode(await backend.read('/work/a'))).toBe('P2');
    });
    it('repeated application is idempotent and preserves an edit after application', async () => {
        const { backend, store, state } = await setup(); await backend.write('/work/a', encoder.encode('0'));
        const capture = await store.capture(), output = await file('a', '1'), edits = [makeSyncEdit('/work', 'a', capture.nodes.a, output, encoder.encode('1'))];
        const actions: FileAction[] = [{ path: 'a', output, side: 'download' }];
        await store.apply(bindingToken(state.binding), edits, actions, 'same'); await backend.write('/work/a', encoder.encode('new'));
        await store.apply(bindingToken(state.binding), edits, actions, 'same');
        expect(new TextDecoder().decode(await backend.read('/work/a'))).toBe('new');
    });
    it('installs cache objects with a valid filesystem parent tree', async () => {
        const { backend, store } = await setup(); await store.putObject(encoder.encode('cached'));
        expect((await backend.verify()).orphanNodes).toEqual([]);
    });
    it('captures valid names beyond a naive Unicode sentinel and prototype keys', async () => {
        const { backend, store } = await setup();
        for (const path of ['\uffffa', '__proto__', 'constructor']) await backend.write('/work/' + path, encoder.encode('x'));
        const capture = await store.capture();
        for (const path of ['\uffffa', '__proto__', 'constructor']) expect(Object.hasOwn(capture.scan.entries, path)).toBe(true);
    });
    it('blocks record-backed files instead of treating their placeholder bytes as content', async () => {
        const { backend, store } = await setup(); await backend.write('/work/a', encoder.encode('placeholder'));
        await backend.records.setRecordField('/work/a', 'content', 'real domain data');
        expect((await store.capture()).scan.entries.a.state).toBe('unsupported');
    });
    it('persists opaque file snapshots without losing ArrayBuffer data', async () => {
        const { backend, store } = await setup(); await backend.write('/work/a', encoder.encode('0'));
        const capture = await store.capture(); await store.persistPlan('plan', capture);
        const restored = await store.plan<typeof capture>('plan'); expect(restored!.nodes.a.content).toBeInstanceOf(ArrayBuffer);
    });
});
