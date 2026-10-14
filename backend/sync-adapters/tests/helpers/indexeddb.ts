import { IndexedDBBackend } from '@itookit/vfsdriver-indexeddb';

let sequence = 0;
export function freshIDB(prefix = 'sync-test'): IndexedDBBackend {
    return new IndexedDBBackend({ dbName: `${prefix}_${Date.now()}_${++sequence}` });
}
