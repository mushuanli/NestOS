import {randomUUID} from '@itookit/common';

export interface FileRecovery { base: string; text: string; savedAt?: number; retentionStartedAt?: number; }

/** Per-tab small drafts are synchronous; larger documents use browser storage without an RPC. */
export class FileRecoveryStore {
    private readonly key: string;
    private available = true;
    constructor(scope: string, path: string, slot?: 'reload-backup') {
        let tab = 'unavailable';
        try {
            const existing = sessionStorage.getItem('mindos.file-recovery.tab');
            tab = existing ?? randomUUID();
            if (!existing) sessionStorage.setItem('mindos.file-recovery.tab', tab);
        } catch { this.available = false; }
        this.key = 'mindos.file-recovery.v1:' + JSON.stringify([tab, scope, path]) + (slot ? ':' + slot : '');
    }
    async read(): Promise<FileRecovery | undefined> {
        if (!this.available) throw new Error('Recovery tab identity unavailable');
        let value: unknown;
        try { const text = sessionStorage.getItem(this.key); if (text) value = JSON.parse(text); } catch { /* Try the large-document store. */ }
        value ??= await this.database('readonly', store => store.get(this.key));
        const draft = value as FileRecovery | undefined;
        return draft && typeof draft.base === 'string' && typeof draft.text === 'string' ? draft : undefined;
    }
    write(value: FileRecovery): Promise<void> {
        if (!this.available) return Promise.reject(new Error('Recovery tab identity unavailable'));
        if (value.text.length < 512 * 1024) {
            try { sessionStorage.setItem(this.key, JSON.stringify(value)); return Promise.resolve(); } catch { /* Quota or disabled session storage. */ }
        }
        return this.database('readwrite', store => store.put(value, this.key)).then(() => {
            try { sessionStorage.removeItem(this.key); } catch { /* IndexedDB now owns the draft. */ }
        });
    }
    async clear(): Promise<void> {
        try { sessionStorage.removeItem(this.key); } catch { /* Also clear the large-document store. */ }
        if (globalThis.indexedDB) await this.database('readwrite', store => store.delete(this.key));
    }
    private database(mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
        if (!globalThis.indexedDB) return mode === 'readonly' ? Promise.resolve(undefined) : Promise.reject(new Error('Recovery storage unavailable'));
        return new Promise((resolve, reject) => {
            const opening = indexedDB.open('mindos-file-recovery', 1);
            opening.onupgradeneeded = () => opening.result.createObjectStore('drafts');
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
                const db = opening.result, transaction = db.transaction('drafts', mode), operation = request(transaction.objectStore('drafts'));
                transaction.oncomplete = () => { db.close(); resolve(operation.result); };
                transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error ?? operation.error); };
            };
        });
    }
}
