import { SyncError, type Coordinator } from '@itookit/vfs-sync';

/** Web Locks span tabs; native application transactions still validate inputs. */
export class WebSyncCoordinator implements Coordinator {
    constructor(private readonly databaseIdentity: string) {}
    async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
        if (!globalThis.navigator?.locks) return Promise.reject(new SyncError('SYNC_COORDINATION_UNAVAILABLE'));
        return await globalThis.navigator.locks.request('itookit-sync:' + this.databaseIdentity + ':' + key,
            { mode: 'exclusive' }, action);
    }
}
export async function browserSyncStorageStatus(requestPersistence = false): Promise<{ persistent: boolean; usage?: number; quota?: number }> {
    const storage = globalThis.navigator?.storage;
    if (!storage) return { persistent: false };
    const persistent = await storage.persisted() || (requestPersistence && await storage.persist());
    const estimate = await storage.estimate(); return { persistent, usage: estimate.usage, quota: estimate.quota };
}
