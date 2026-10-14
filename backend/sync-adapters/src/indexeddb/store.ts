import { SeqControl } from '../shared/control';
import { validRoot, validateState } from '../shared/records';
import { ensurePrivateParents, makeNode, type StoredNode } from './nodes';
import { IndexedDBLeaseGuard } from './lease';
import { assertBinding, assertSync, applyBaseline, sha256, validId, validPath,
    type CoordinationGuard, type FileAction, type Snapshot, type StateStore, type SyncState } from '@itookit/vfs-sync';
import { IDBRecordStore } from '@itookit/vfsdriver-indexeddb';
import type { IndexedDBStorageAccess } from '@itookit/vfsdriver-indexeddb';
import { req, txDone, STORE_NODES, STORE_RECORDS, STORE_TAGS } from '@itookit/vfsdriver-indexeddb';

export interface IndexedDBSyncSnapshot {
    scan: Snapshot;
    nodes: Record<string, StoredNode>;
    objects: Record<string, Uint8Array<ArrayBuffer>>;
}
export interface SyncFileEdit { path: string; expected?: StoredNode; output?: StoredNode }

/** A single database transaction commits file bytes, evidence and baseline together. */
export class IndexedDBSyncStore implements StateStore {
    private readonly controlPath: string;
    private readonly control: SeqControl;
    static async list(storage: IndexedDBStorageAccess): Promise<SyncState[]> {
        const tx = storage.transaction(STORE_RECORDS, 'readonly'), done = txDone(tx);
        const rows = await req<{ path: string; field: string; value: string }[]>(tx.objectStore(STORE_RECORDS)
            .getAll(IDBKeyRange.bound(['/var/lib/sync/', ''], ['/var/lib/sync0', ''], false, true)));
        await done;
        return rows.filter(row => row.field === 'state').map(row => {
            const state = JSON.parse(row.value) as SyncState; validateState(state);
            assertSync(row.path === `/var/lib/sync/${state.binding.bindingId}/state.seq`, 'SYNC_CONTROL_CORRUPT'); return state;
        });
    }
    constructor(private readonly storage: IndexedDBStorageAccess, private readonly bindingId: string, private readonly guards: IndexedDBLeaseGuard[] = []) {
        validId(bindingId); this.controlPath = `/var/lib/sync/${bindingId}/state.seq`;
        this.control = new SeqControl(this.controlPath, (mode, action) => mode === 'read'
            ? this.reading([STORE_RECORDS], tx => action(new IDBRecordStore(tx.objectStore(STORE_RECORDS))))
            : this.write(tx => action(new IDBRecordStore(tx.objectStore(STORE_RECORDS)))));
    }
    scoped(guard: CoordinationGuard): IndexedDBSyncStore {
        assertSync(guard instanceof IndexedDBLeaseGuard && guard.identity === this.storage.identity, 'COORDINATION_FENCING_UNAVAILABLE');
        return new IndexedDBSyncStore(this.storage, this.bindingId, [...this.guards, guard]);
    }
    private async verify(tx: IDBTransaction): Promise<void> {
        await Promise.all(this.guards.map(guard => guard.verify(tx)));
    }
    private async reading<T>(stores: string[], action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
        const tx = this.storage.transaction([...new Set([...stores, STORE_RECORDS])], 'readonly'), done = txDone(tx);
        try { await this.verify(tx); const result = await action(tx); await done; return result; }
        catch (error) { try { tx.abort(); } catch { /* Already finished. */ } await done.catch(() => {}); throw error; }
    }
    async initialize(state: SyncState): Promise<void> {
        validateState(state); assertSync(state.binding.bindingId === this.bindingId, 'BINDING_ID_MISMATCH');
        await this.write(async tx => {
            const store = tx.objectStore(STORE_RECORDS);
            const placeholder = req(tx.objectStore(STORE_NODES).get(this.controlPath));
            const previous = req(store.get([this.controlPath, 'state']));
            const rows = req<{ path: string; field: string; value: string }[]>(store.getAll());
            assertSync(!await previous && !await placeholder, 'BINDING_EXISTS');
            for (const row of await rows) {
                if (!row.path.startsWith('/var/lib/sync/') || row.field !== 'state') continue;
                const other = JSON.parse(row.value) as SyncState; validateState(other);
                const a = other.binding.root, b = state.binding.root;
                assertSync(other.binding.state === 'detached' || !(a === b || a.startsWith(b + '/') || b.startsWith(a + '/')), 'SYNC_ROOT_OVERLAP');
            }
            await ensurePrivateParents(tx, this.controlPath);
            tx.objectStore(STORE_NODES).put(makeNode(this.controlPath, 'file', new ArrayBuffer(0)));
            await this.save(tx, state);
        });
    }
    read(): Promise<SyncState> { return this.control.read(); }
    update(change: (current: SyncState) => SyncState): Promise<SyncState> { return this.control.update(change); }
    async capture(maxFileBytes = 32 * 1024 * 1024): Promise<IndexedDBSyncSnapshot> {
        const state = await this.read(), root = state.binding.root;
        validRoot(root);
        const [node, rows, records] = await this.reading([STORE_NODES], async tx => {
            const store = tx.objectStore(STORE_NODES);
            const recordsRead = req<{ path: string }[]>(tx.objectStore(STORE_RECORDS).getAll(IDBKeyRange.bound([root + '/', ''], [root + '0', ''], false, true)));
            const rootRead = req<StoredNode | undefined>(store.get(root));
            const rowsRead = req<StoredNode[]>(store.getAll(IDBKeyRange.bound(root + '/', root + '0', false, true)));
            return Promise.all([rootRead, rowsRead, recordsRead]);
        });
        assertSync(rows.length <= 10000, 'LOCAL_SCAN_BUDGET_EXCEEDED');
        assertSync(node?.type === 'directory', 'SYNC_ROOT_UNAVAILABLE');
        return snapshot(root, rows, maxFileBytes, new Set(records.map(r => r.path)));
    }
    async putObject(bytes: Uint8Array): Promise<string> {
        const hash = await sha256(bytes), path = this.objectPath(hash);
        await this.write(async tx => {
            await ensurePrivateParents(tx, path);
            tx.objectStore(STORE_NODES).put(makeNode(path, 'file', new Uint8Array(bytes).buffer));
        });
        return hash;
    }
    async object(hash: string): Promise<Uint8Array<ArrayBuffer>> {
        const node = await this.reading([STORE_NODES], tx => req<StoredNode | undefined>(tx.objectStore(STORE_NODES).get(this.objectPath(hash))));
        assertSync(node?.type === 'file', 'LOCAL_OBJECT_MISSING');
        const bytes = new Uint8Array(node.content);
        assertSync(await sha256(bytes) === hash, 'LOCAL_OBJECT_CORRUPT'); return bytes;
    }
    async apply(token: string, edits: SyncFileEdit[], confirmed: FileAction[], operationId: string): Promise<void> {
        await this.write(async tx => {
            const state = await this.load(tx); assertBinding(token, state.binding);
            assertSync(state.binding.state === 'active', 'BINDING_INACTIVE');
            if (await req(tx.objectStore(STORE_RECORDS).get([this.controlPath, 'apply:' + operationId]))) return;
            await validateEdits(tx, edits, state.binding.root);
            for (const edit of edits) {
                const nodes = tx.objectStore(STORE_NODES);
                if (edit.output) nodes.put(edit.output); else nodes.delete(edit.path);
            }
            await cleanDeletedTags(tx, edits);
            state.baseline = applyBaseline(state.baseline, confirmed);
            await this.save(tx, state);
            tx.objectStore(STORE_RECORDS).put({ path: this.controlPath, field: 'apply:' + operationId, value: token });
        });
    }
    persistPlan(key: string, value: unknown): Promise<void> { return this.control.persistPlan(key, value); }
    plan<T>(key: string): Promise<T | undefined> { return this.control.plan(key); }
    async applyCaptured(token: string, handle: unknown, actions: FileAction[], id: string): Promise<void> {
        const capture = handle as IndexedDBSyncSnapshot, state = await this.read();
        assertSync(capture?.nodes && capture.scan, 'INVALID_LOCAL_SNAPSHOT');
        const confirmed = actions.filter(a => a.side === 'upload' || a.side === 'confirm');
        // Published P is confirmed even when the user has already produced P2.
        await this.apply(token, [], confirmed, id + '-published');
        const downloads = actions.filter(a => a.side === 'download' || a.side === 'merge');
        const edits = await Promise.all(downloads.map(async a => makeSyncEdit(state.binding.root, a.path, Object.hasOwn(capture.nodes, a.path) ? capture.nodes[a.path] : undefined,
            a.output, a.output?.kind === 'file' ? await this.object(a.output.hash) : undefined)));
        await this.apply(token, edits, downloads, id + '-downloaded');
    }
    private load(tx: IDBTransaction): Promise<SyncState> {
        return this.control.load(new IDBRecordStore(tx.objectStore(STORE_RECORDS)));
    }
    private save(tx: IDBTransaction, state: SyncState): Promise<void> {
        return this.control.save(new IDBRecordStore(tx.objectStore(STORE_RECORDS)), state);
    }
    private objectPath(hash: string): string {
        assertSync(/^[a-f0-9]{64}$/.test(hash)); return this.controlPath.slice(0, -10) + '/objects/' + hash;
    }
    private async write<T>(action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
        const tx = this.storage.transaction([STORE_NODES, STORE_RECORDS, STORE_TAGS], 'readwrite', { durability: 'strict' });
        const done = txDone(tx);
        try { await this.verify(tx); const result = await action(tx); await done; return result; }
        catch (error) { try { tx.abort(); } catch { /* The transaction may have auto-aborted. */ } await done.catch(() => {}); throw error; }
    }
}
function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    return x.length === y.length && x.every((byte, i) => byte === y[i]);
}
async function validateEdits(tx: IDBTransaction, edits: SyncFileEdit[], root: string): Promise<void> {
    const nodes = tx.objectStore(STORE_NODES);
    const recordRead = req<{ path: string }[]>(tx.objectStore(STORE_RECORDS).getAll(IDBKeyRange.bound([root + '/', ''], [root + '0', ''], false, true)));
    const rootRead = req<StoredNode | undefined>(nodes.get(root));
    const reads = edits.map(edit => req<StoredNode | undefined>(nodes.get(edit.path)));
    const allRead = req<StoredNode[]>(nodes.getAll(IDBKeyRange.bound(root + '/', root + '0', false, true)));
    const [current, all, rootNode, recordFiles] = await Promise.all([Promise.all(reads), allRead, rootRead, recordRead]);
    assertSync(rootNode?.type === 'directory', 'SYNC_ROOT_UNAVAILABLE');
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i], node = current[i], expected = edit.expected;
        assertSync(!recordFiles.some(r => r.path === edit.path), 'RECORD_FILE_REQUIRES_DOMAIN_SYNC');
        assertSync(edit.path.startsWith(root + '/') && (!edit.output || edit.output.path === edit.path), 'INVALID_SYNC_TARGET');
        validPath(edit.path.slice(root.length + 1));
        assertSync(!node === !expected && (!node || (node.type === expected!.type && node.metadata === expected!.metadata && JSON.stringify(node.tags) === JSON.stringify(expected!.tags) && node.icon === expected!.icon
            && node.version === expected!.version && bytesEqual(node.content, expected!.content))), 'LOCAL_CHANGED');
        if (node?.type === 'directory' && edit.output?.type !== 'directory') {
            assertSync(all.filter(n => n.path.startsWith(edit.path + '/')).every(n => edits.some(e => e.path === n.path && !e.output)), 'DIRECTORY_GROUP_BLOCKED');
        }
        const parent = edit.path.slice(0, edit.path.lastIndexOf('/'));
        assertSync(!edit.output || parent === root || all.some(n => n.path === parent && n.type === 'directory')
            || edits.some(e => e.path === parent && e.output?.type === 'directory'), 'INVALID_SYNC_PARENT');
    }
}
async function cleanDeletedTags(tx: IDBTransaction, edits: SyncFileEdit[]): Promise<void> {
    const deleted = new Set(edits.filter(e => !e.output).map(e => e.path));
    if (!deleted.size) return;
    const tags = tx.objectStore(STORE_TAGS);
    const rows = await req<{ id: number; path: string }[]>(tags.getAll());
    for (const tag of rows) if (deleted.has(tag.path)) tags.delete(tag.id);
}
async function snapshot(root: string, rows: StoredNode[], maxBytes: number, recordFiles: Set<string>): Promise<IndexedDBSyncSnapshot> {
    const scan: Snapshot = { entries: Object.create(null), completeDirectories: [''] };
    const nodes: Record<string, StoredNode> = Object.create(null), objects: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (const node of rows) {
        const path = node.path.slice(root.length + 1); nodes[path] = node;
        if (node.type === 'directory') {
            scan.entries[path] = { state: 'present', entry: { kind: 'directory', path }, executable: 'unavailable' };
            scan.completeDirectories.push(path); continue;
        }
        if (!(node.content instanceof ArrayBuffer) || node.size !== node.content.byteLength) {
            scan.entries[path] = { state: 'unknown', code: 'STORED_FILE_INCONSISTENT' }; continue;
        }
        if (recordFiles.has(node.path)) { scan.entries[path] = { state: 'unsupported', code: 'RECORD_FILE_REQUIRES_DOMAIN_SYNC' }; continue; }
        if (node.size > maxBytes) { scan.entries[path] = { state: 'unsupported', code: 'OBJECT_TOO_LARGE' }; continue; }
        const bytes = new Uint8Array(node.content), hash = await sha256(bytes); objects[hash] = bytes;
        scan.entries[path] = { state: 'present', entry: { kind: 'file', path, hash, size: String(bytes.length) }, executable: 'unavailable' };
    }
    return { scan, nodes, objects };
}
export function makeSyncEdit(root: string, path: string, expected: StoredNode | undefined, output: FileAction['output'], bytes?: Uint8Array): SyncFileEdit {
    validPath(path); validRoot(root);
    return { path: root + '/' + path, expected, output: output ? makeNode(root + '/' + path,
        output.kind === 'file' ? 'file' : 'directory', new Uint8Array(bytes ?? []).buffer, expected) : undefined };
}
