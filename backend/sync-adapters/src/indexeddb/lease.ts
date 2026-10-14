import { type CoordinationGuard } from '@itookit/vfs-sync';
import { req, txDone, STORE_RECORDS, type IndexedDBStorageAccess } from '@itookit/vfsdriver-indexeddb';

export { LEASE_PATH, type Lease } from '../shared/lease';
import { LEASE_PATH, decodeLease, assertLease, type Lease } from '../shared/lease';

/** Ownership is checked in the same transaction as each protected mutation. */
export class IndexedDBLeaseGuard implements CoordinationGuard {
    readonly identity: string;
    constructor(private readonly storage: IndexedDBStorageAccess, readonly field: string,
        readonly lease: Lease, private readonly now: () => number) { this.identity = storage.identity; }
    async verify(tx: IDBTransaction): Promise<void> {
        const row = await req<{ value: string } | undefined>(tx.objectStore(STORE_RECORDS).get([LEASE_PATH, this.field]));
        const lease = decodeLease(row?.value);
        assertLease(lease, this.lease, this.now());
    }
    async check(): Promise<void> {
        const tx = this.storage.transaction(STORE_RECORDS, 'readonly'), done = txDone(tx);
        try { await this.verify(tx); await done; }
        catch (error) { try { tx.abort(); } catch { /* Already finished. */ } await done.catch(() => {}); throw error; }
    }
}
