import { FileSync, randomId, type Coordinator, type FileRemote, type Scope } from '@itookit/vfs-sync';
import type { LocalFSBackend } from '@itookit/vfsdriver-local';
import { CachedFileLocal } from '../shared/local';
import { LocalSyncCoordinator } from './coordinator';
import { LocalSyncStore } from './store';
export { LocalSyncCoordinator, LocalSyncStore };
export type { LocalSnapshot, LocalNode } from './scan';
export type { LeaseOptions } from '../shared/coordinator';
export class LocalFileLocal extends CachedFileLocal {
    constructor(store: LocalSyncStore) { super(store); }
}
/** Node/POSIX entry; importing the browser root never loads native filesystem modules. */
export function createLocalSyncSession(backend: LocalFSBackend, bindingId: string, remote: FileRemote,
    options: { scope: Scope; coordinator?: Coordinator; newId?: () => string }): FileSync {
    const storage = backend.storageAccess(), store = new LocalSyncStore(storage, bindingId);
    return new FileSync(store, new LocalFileLocal(store), remote, options.coordinator ?? new LocalSyncCoordinator(storage), options.newId ?? randomId, options.scope);
}
