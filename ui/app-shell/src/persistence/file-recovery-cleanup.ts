import {createModuleLogger, randomUUID} from '@itookit/common';
import type {FileRecovery} from './file-recovery-store';

const log = createModuleLogger('file-recovery'), retentionMs = 2 * 24 * 60 * 60 * 1000;
const isBackup = (key: unknown): key is string => typeof key === 'string'
    && key.startsWith('mindos.file-recovery.v1:') && key.endsWith(':reload-backup');

/** Unknown legacy ages get a retention start, never a fabricated backup timestamp. */
function expired(value: FileRecovery, now: number): boolean {
    const time = ageOf(value);
    return time !== undefined && time < now - retentionMs;
}
function ageOf(value: FileRecovery): number | undefined {
    return [value.savedAt, value.retentionStartedAt].find(time => typeof time === 'number' && Number.isFinite(time) && time > 0);
}
function cleanSession(now: number): {removed: number; migrated: number} {
    const result = {removed: 0, migrated: 0}, storage = globalThis.sessionStorage;
    for (const key of Object.keys(storage).filter(isBackup)) {
        let value: FileRecovery;
        try {value = JSON.parse(storage.getItem(key) ?? 'null');} catch {continue;}
        if (!value || typeof value.text !== 'string' || typeof value.base !== 'string') continue;
        if (expired(value, now)) {storage.removeItem(key); result.removed++;}
        else if (ageOf(value) === undefined) {storage.setItem(key, JSON.stringify({...value, retentionStartedAt: now})); result.migrated++;}
    }
    return result;
}
function cleanDatabase(now: number): Promise<{removed: number; migrated: number}> {
    if (!globalThis.indexedDB) return Promise.resolve({removed: 0, migrated: 0});
    return new Promise((resolve, reject) => {
        const opening = indexedDB.open('mindos-file-recovery', 1); let blocked = false;
        opening.onupgradeneeded = () => opening.result.createObjectStore('drafts');
        opening.onerror = () => reject(opening.error);
        opening.onblocked = () => {blocked = true; reject(Object.assign(new Error('Recovery database blocked'), {code: 'RECOVERY_DB_BLOCKED'}));};
        opening.onsuccess = () => {
            const db = opening.result; if (blocked) {db.close(); return;}
            const transaction = db.transaction('drafts', 'readwrite');
            const result = cleanRecords(transaction.objectStore('drafts'), now);
            transaction.oncomplete = () => {db.close(); resolve(result);};
            transaction.onabort = transaction.onerror = () => {db.close(); reject(transaction.error);};
        };
    });
}

function cleanRecords(store: IDBObjectStore, now: number): {removed: number; migrated: number} {
    const result = {removed: 0, migrated: 0}, keys = store.openKeyCursor();
    keys.onsuccess = () => {
        const cursor = keys.result; if (!cursor) return;
        if (!isBackup(cursor.key)) {cursor.continue(); return;}
        const read = store.get(cursor.key);
        read.onsuccess = () => {
            const value = read.result as FileRecovery | undefined;
            if (value && typeof value.text === 'string' && typeof value.base === 'string') {
                if (expired(value, now)) {store.delete(cursor.key); result.removed++;}
                else if (ageOf(value) === undefined) {store.put({...value, retentionStartedAt: now}, cursor.key); result.migrated++;}
            }
            cursor.continue();
        };
    };
    return result;
}

/** Sweep only refresh backups across tabs/scopes; ordinary unsaved drafts are never expired here. */
export async function cleanupFileRefreshBackups(): Promise<void> {
    const operationId = randomUUID(), now = Date.now();
    for (const [stage, clean] of [['session-storage', () => cleanSession(now)], ['indexed-db', () => cleanDatabase(now)]] as const) {
        const started = Date.now();
        try {const counts = await clean(); log.info('file.backup.cleanup', {operation: 'file.backup.cleanup', operationId, stage,
            result: 'success', durationMs: Date.now() - started, ...counts});}
        catch (error) {const code = (error as {code?: unknown})?.code;
            log.warn('file.backup.cleanup', {operation: 'file.backup.cleanup', operationId, stage, result: 'failure',
                durationMs: Date.now() - started, code: code === 'RECOVERY_DB_BLOCKED' ? code : 'RECOVERY_STORAGE_UNAVAILABLE'});}
    }
}
