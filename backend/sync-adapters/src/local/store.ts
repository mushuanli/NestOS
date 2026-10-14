import { readdir, readFile } from 'node:fs/promises';
import { assertBinding, assertSync, applyBaseline, sha256, validId, validPath,
    type CoordinationGuard, type FileAction, type StateStore, type SyncState } from '@itookit/vfs-sync';
import type { ISidecarDb, LocalStorageAccess } from '@itookit/vfsdriver-local';
import { SeqControl } from '../shared/control';
import { validRoot, validateState } from '../shared/records';
import { LocalLeaseGuard } from './coordinator';
import { ensureSeqFile, installObject, nativePath, stat } from './files';
import { scanLocal, type LocalSnapshot } from './scan';
import { finishJournal, prepareJournal } from './journal';

export class LocalSyncStore implements StateStore {
    readonly controlPath: string;
    private readonly control: SeqControl;
    constructor(readonly storage: LocalStorageAccess, private readonly bindingId: string, private readonly guards: LocalLeaseGuard[] = []) {
        validId(bindingId); assertSync(storage.durability === 'full', 'LOCAL_SYNC_DURABILITY_REQUIRED');
        assertSync(process.platform !== 'win32', 'LOCAL_SYNC_PLATFORM_UNSUPPORTED');
        this.controlPath = `/var/lib/sync/${bindingId}/state.seq`;
        this.control = new SeqControl(this.controlPath, (_mode, action) => this.transaction(db => action(db)));
    }
    scoped(guard: CoordinationGuard): LocalSyncStore {
        assertSync(guard instanceof LocalLeaseGuard && guard.identity === this.storage.identity, 'COORDINATION_FENCING_UNAVAILABLE');
        return new LocalSyncStore(this.storage, this.bindingId, [...this.guards, guard]);
    }
    transaction<T>(action: (db: ISidecarDb) => Promise<T>): Promise<T> {
        return this.storage.transaction(async db => { for (const guard of this.guards) await guard.verify(db); return action(db); });
    }
    static list(storage: LocalStorageAccess): Promise<SyncState[]> { return storage.transaction(db => listBindings(storage, db)); }
    async initialize(state: SyncState): Promise<void> {
        validateState(state); assertSync(state.binding.bindingId === this.bindingId, 'BINDING_ID_MISMATCH');
        await this.transaction(async db => {
            assertSync(await db.getRecordField(this.controlPath, 'state') === undefined, 'BINDING_EXISTS');
            for (const other of await listBindings(this.storage, db)) {
                const a = other.binding.root, b = state.binding.root;
                assertSync(other.binding.state === 'detached' || !(a === b || a.startsWith(b + '/') || b.startsWith(a + '/')), 'SYNC_ROOT_OVERLAP');
            }
            await ensureSeqFile(await nativePath(this.storage, this.controlPath)); await this.save(db, state);
        });
    }
    read(): Promise<SyncState> { return this.control.read(); }
    update(change: (state: SyncState) => SyncState): Promise<SyncState> { return this.control.update(change); }
    load(db: ISidecarDb): Promise<SyncState> { return this.control.load(db); }
    save(db: ISidecarDb, state: SyncState): Promise<void> { return this.control.save(db, state); }
    persistPlan(key: string, plan: unknown): Promise<void> { return this.control.persistPlan(key, plan); }
    plan<T>(key: string): Promise<T | undefined> { return this.control.plan(key); }
    capture(maxBytes = 32 * 1024 * 1024): Promise<LocalSnapshot> {
        return this.transaction(async db => {
            assertSync(!await db.getRecordField(this.controlPath, 'applyPending'), 'LOCAL_APPLY_PENDING');
            const root = (await this.load(db)).binding.root; validRoot(root);
            const physical = await nativePath(this.storage, root);
            assertSync(this.storage.sidecarDir !== physical && !this.storage.sidecarDir.startsWith(physical + '/'), 'SYNC_SIDECAR_OVERLAP');
            return scanLocal(this.storage, db, root, maxBytes);
        });
    }
    async putObject(bytes: Uint8Array): Promise<string> {
        const hash = await sha256(bytes);
        await this.transaction(async () => installObject(await nativePath(this.storage, this.objectPath(hash)), bytes, hash)); return hash;
    }
    object(hash: string): Promise<Uint8Array<ArrayBuffer>> {
        return this.transaction(async () => {
            const path = await nativePath(this.storage, this.objectPath(hash)); assertSync((await stat(path))?.isFile(), 'LOCAL_OBJECT_MISSING');
            const bytes = new Uint8Array(await readFile(path)); assertSync(await sha256(bytes) === hash, 'LOCAL_OBJECT_CORRUPT'); return bytes;
        });
    }
    async applyCaptured(token: string, handle: unknown, actions: FileAction[], id: string): Promise<void> {
        validId(id); for (const action of actions) validPath(action.path);
        const capture = handle as LocalSnapshot; assertSync(capture?.nodes && capture.scan, 'INVALID_LOCAL_SNAPSHOT');
        await this.confirm(token, actions.filter(a => a.side === 'upload' || a.side === 'confirm'), id + '-published');
        const downloads = actions.filter(a => a.side === 'download' || a.side === 'merge');
        await prepareJournal(this, token, capture, downloads, id + '-downloaded');
        await finishJournal(this, token, id + '-downloaded');
    }
    private confirm(token: string, actions: FileAction[], id: string): Promise<void> {
        return this.transaction(async db => {
            const state = await this.load(db); assertBinding(token, state.binding); assertSync(state.binding.state === 'active', 'BINDING_INACTIVE');
            if (await db.getRecordField(this.controlPath, 'apply:' + id)) return;
            state.baseline = applyBaseline(state.baseline, actions); await this.save(db, state);
            await db.setRecordField(this.controlPath, 'apply:' + id, token);
        });
    }
    private objectPath(hash: string): string {
        assertSync(/^[a-f0-9]{64}$/.test(hash)); return this.controlPath.slice(0, -10) + '/objects/' + hash;
    }
}
async function listBindings(storage: LocalStorageAccess, db: ISidecarDb): Promise<SyncState[]> {
    const directory = await nativePath(storage, '/var/lib/sync'), result: SyncState[] = [];
    if (!await stat(directory)) return result;
    for (const node of await readdir(directory, { withFileTypes: true })) {
        if (!node.isDirectory()) continue; validId(node.name);
        const path = `/var/lib/sync/${node.name}/state.seq`, raw = await db.getRecordField(path, 'state');
        if (raw === undefined) continue; assertSync(typeof raw === 'string', 'SYNC_CONTROL_CORRUPT');
        const state = JSON.parse(raw) as SyncState; validateState(state);
        assertSync(state.binding.bindingId === node.name, 'SYNC_CONTROL_CORRUPT'); result.push(state);
    }
    return result;
}
