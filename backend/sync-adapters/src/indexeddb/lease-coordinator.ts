import { assertSync } from '@itookit/vfs-sync';
import { req, txDone, STORE_NODES, STORE_RECORDS, type IndexedDBStorageAccess } from '@itookit/vfsdriver-indexeddb';
import { ensurePrivateParents, makeNode } from './nodes';
import { IndexedDBLeaseGuard } from './lease';
import { decodeLease, LEASE_PATH, type LeaseAccess } from '../shared/lease';
import { LeaseCoordinator, type LeaseOptions } from '../shared/coordinator';
export type { LeaseOptions } from '../shared/coordinator';

export class IndexedDBSyncCoordinator extends LeaseCoordinator {
    constructor(storage: IndexedDBStorageAccess, options: LeaseOptions = {}) { super(access(storage), options); }
}
function access(storage: IndexedDBStorageAccess): LeaseAccess {
    return { guard: (field, lease, now) => new IndexedDBLeaseGuard(storage, field, lease, now),
        transaction: async action => {
            const tx = storage.transaction([STORE_NODES, STORE_RECORDS], 'readwrite', { durability: 'strict' }), done = txDone(tx);
            const records = tx.objectStore(STORE_RECORDS);
            try {
                const result = await action({ read: async field => decodeLease((await req<{ value: string } | undefined>(records.get([LEASE_PATH, field])))?.value),
                    write: async (field, lease) => {
                        await ensurePrivateParents(tx, LEASE_PATH);
                        const node = await req<{ type: string } | undefined>(tx.objectStore(STORE_NODES).get(LEASE_PATH));
                        assertSync(!node || node.type === 'file', 'SYNC_CONTROL_PATH_COLLISION');
                        if (!node) tx.objectStore(STORE_NODES).put(makeNode(LEASE_PATH, 'file', new ArrayBuffer(0)));
                        records.put({ path: LEASE_PATH, field, value: JSON.stringify(lease) });
                    } });
                await done; return result;
            } catch (error) { try { tx.abort(); } catch { /* Already finished. */ } await done.catch(() => {}); throw error; }
        } };
}
