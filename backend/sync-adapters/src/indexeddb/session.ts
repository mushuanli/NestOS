import { IndexedDBSyncStore } from './store';
import { FileSync, randomId, type Coordinator, type FileRemote, type Scope } from '@itookit/vfs-sync';
import type { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { IndexedDBFileLocal } from './local';
import { IndexedDBSyncCoordinator } from './lease-coordinator';

export function createIndexedDBSyncSession(backend: IndexedDBBackend, bindingId: string, remote: FileRemote,
    options: { scope: Scope; coordinator?: Coordinator; newId?: () => string }): FileSync {
    const store = new IndexedDBSyncStore(backend.storageAccess(), bindingId);
    return new FileSync(store, new IndexedDBFileLocal(store), remote,
        options.coordinator ?? new IndexedDBSyncCoordinator(backend.storageAccess()),
        options.newId ?? randomId,
        options.scope);
}
