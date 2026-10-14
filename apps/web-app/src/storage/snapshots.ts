/**
 * @file app-settings/services/SnapshotService.ts
 * @desc IndexedDB-level snapshot management (clone, restore, delete).
 *
 * Operates below the VFS abstraction — snapshots are raw database clones,
 * not VFS backups. For VFS-level backup/restore use vfs.maintenance.*.
 */
import type { IVFSManager } from '@itookit/vfs-core';

const SNAPSHOT_PREFIX = 'snapshot_';

import type { LocalSnapshot, SnapshotPort } from '@itookit/app-contracts/settings';
export class SnapshotService implements SnapshotPort {
    constructor(
        private readonly vfs: IVFSManager,
        private readonly dbName: string,
    ) {}

    async estimate() {
        return navigator.storage?.estimate ? navigator.storage.estimate() : null;
    }

    /** List snapshots by scanning IndexedDB database names. */
    async listLocalSnapshots(): Promise<LocalSnapshot[]> {
        if (!window.indexedDB.databases) return [];

        const dbs = await window.indexedDB.databases();
        const snapshots: LocalSnapshot[] = [];

        for (const db of dbs) {
            if (!db.name?.startsWith(SNAPSHOT_PREFIX)) continue;
            const parts = db.name.split('_');
            const timestamp = parseInt(parts[1]);
            if (!isNaN(timestamp)) {
                snapshots.push({
                    name: db.name,
                    displayName: new Date(timestamp).toLocaleString(),
                    createdAt: timestamp,
                    size: 0,
                    description: '',
                });
            }
        }

        return snapshots.sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Clone the current database into a timestamped snapshot. */
    async createSnapshot(): Promise<void> {
        await this.copyDatabase(this.dbName, `${SNAPSHOT_PREFIX}${Date.now()}`);
    }

    /**
     * Restore a snapshot over the current database.
     * Disposes the VFS before overwriting — caller must re-initialize VFS afterwards.
     */
    async restoreSnapshot(snapshotName: string): Promise<void> {
        await this.vfs.dispose();
        await this.copyDatabase(snapshotName, this.dbName);
    }

    /** Permanently delete a snapshot database. */
    async deleteSnapshot(snapshotName: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const req = window.indexedDB.deleteDatabase(snapshotName);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => console.warn(`Delete ${snapshotName} blocked`);
        });
    }

    async factoryReset(): Promise<void> {
        await this.vfs.dispose();
        await this.deleteSnapshot(this.dbName);
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private async copyDatabase(sourceName: string, targetName: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const openReq = indexedDB.open(sourceName);
            openReq.onerror = () => reject(openReq.error);

            openReq.onsuccess = () => {
                const sourceDb = openReq.result;
                const storeNames = Array.from(sourceDb.objectStoreNames);

                const deleteReq = indexedDB.deleteDatabase(targetName);
                deleteReq.onsuccess = deleteReq.onerror = () => {
                    const createReq = indexedDB.open(targetName, sourceDb.version);

                    createReq.onupgradeneeded = (event) => {
                        const targetDb = (event.target as IDBOpenDBRequest).result;
                        for (const storeName of storeNames) {
                            const sourceTx = sourceDb.transaction(storeName, 'readonly');
                            const sourceStore = sourceTx.objectStore(storeName);
                            const targetStore = targetDb.createObjectStore(storeName, {
                                keyPath: sourceStore.keyPath as string | string[],
                                autoIncrement: sourceStore.autoIncrement,
                            });
                            for (const indexName of Array.from(sourceStore.indexNames)) {
                                const idx = sourceStore.index(indexName);
                                targetStore.createIndex(indexName, idx.keyPath as string | string[], {
                                    unique: idx.unique,
                                    multiEntry: idx.multiEntry,
                                });
                            }
                        }
                    };

                    createReq.onsuccess = async () => {
                        const targetDb = createReq.result;
                        try {
                            for (const storeName of storeNames) {
                                await this.copyStoreData(sourceDb, targetDb, storeName);
                            }
                            resolve();
                        } catch (e) {
                            reject(e);
                        } finally {
                            sourceDb.close();
                            targetDb.close();
                        }
                    };

                    createReq.onerror = () => {
                        sourceDb.close();
                        reject(createReq.error);
                    };
                };
            };
        });
    }

    private copyStoreData(
        sourceDb: IDBDatabase,
        targetDb: IDBDatabase,
        storeName: string,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const getAllReq = sourceDb
                .transaction(storeName, 'readonly')
                .objectStore(storeName)
                .getAll();

            getAllReq.onsuccess = () => {
                const data = getAllReq.result;
                if (data.length === 0) { resolve(); return; }

                const targetStore = targetDb
                    .transaction(storeName, 'readwrite')
                    .objectStore(storeName);

                let completed = 0;
                for (const item of data) {
                    const putReq = targetStore.put(item);
                    putReq.onsuccess = () => { if (++completed === data.length) resolve(); };
                    putReq.onerror = () => reject(putReq.error);
                }
            };

            getAllReq.onerror = () => reject(getAllReq.error);
        });
    }
}
