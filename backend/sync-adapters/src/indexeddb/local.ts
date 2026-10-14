import { CachedFileLocal } from '../shared/local';
import type { IndexedDBSyncStore } from './store';

export class IndexedDBFileLocal extends CachedFileLocal {
    constructor(store: IndexedDBSyncStore) { super(store); }
}
