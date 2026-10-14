import { assertSync, type CoordinationGuard } from '@itookit/vfs-sync';
import type { ISidecarDb, LocalStorageAccess } from '@itookit/vfsdriver-local';
import { LeaseCoordinator, type LeaseOptions } from '../shared/coordinator';
import { assertLease, decodeLease, LEASE_PATH, type Lease } from '../shared/lease';
import { ensureSeqFile, nativePath } from './files';

export class LocalLeaseGuard implements CoordinationGuard {
    readonly identity: string;
    constructor(private readonly storage: LocalStorageAccess, readonly field: string,
        readonly lease: Lease, private readonly now: () => number) { this.identity = storage.identity; }
    async verify(db: ISidecarDb): Promise<void> {
        assertLease(decodeLease(await db.getRecordField(LEASE_PATH, this.field)), this.lease, this.now());
    }
    check(): Promise<void> { return this.storage.transaction(db => this.verify(db)); }
}
export class LocalSyncCoordinator extends LeaseCoordinator {
    constructor(storage: LocalStorageAccess, options: LeaseOptions = {}) {
        assertSync(storage.durability === 'full', 'LOCAL_SYNC_DURABILITY_REQUIRED');
        super({ guard: (field, lease, now) => new LocalLeaseGuard(storage, field, lease, now),
            transaction: action => storage.transaction(db => action({
                read: async field => decodeLease(await db.getRecordField(LEASE_PATH, field)),
                write: async (field, lease) => {
                    await ensureSeqFile(await nativePath(storage, LEASE_PATH));
                    await db.setRecordField(LEASE_PATH, field, JSON.stringify(lease));
                },
            })) }, options);
    }
}
