import { readWorkbenchSnapshot, type WorkbenchStatePort } from '../workbench/state';
/**
 * @file app-shell/persistence/vfs-ui-state-store.ts
 * @desc Host storage for browser UI snapshots (`etc:/ui/<scope>.ui.json`).
 *
 * Browsers restore synchronously while they are being constructed, so a scope is
 * read once up front and the port then answers from cache.
 */
import { readUISnapshot, type RestoredUISnapshot, type UIPersistencePort } from '@itookit/vfs-ui';
import type { VfsJsonStore } from './vfs-json-store';

/** Document name for a browser scope; the file is `<sanitized-scope>.ui.json`. */
const docName = (scopeId: string): string => `${scopeId}.ui`;

export class VfsUIPersistence {
    private readonly snapshots = new Map<string, RestoredUISnapshot | undefined>();
    constructor(private readonly store: VfsJsonStore) {}

    /** Read a scope once; later calls answer from the cache. */
    async load(scopeId: string): Promise<RestoredUISnapshot | undefined> {
        if (!this.snapshots.has(scopeId)) this.snapshots.set(scopeId, readUISnapshot(await this.store.read(docName(scopeId))));
        return this.snapshots.get(scopeId);
    }
    /** Prefetch, then hand the browser a port whose `load` is synchronous. */
    async port(scopeId: string): Promise<UIPersistencePort> {
        await this.load(scopeId);
        return { load: () => this.snapshots.get(scopeId), save: snapshot => this.store.write(docName(scopeId), snapshot) };
    }
    async workbenchPort(scopeId: string): Promise<WorkbenchStatePort> {
        let snapshot = readWorkbenchSnapshot(await this.store.read(`${scopeId}.workbench`));
        return { load: () => snapshot, save: value => { snapshot = value; this.store.write(`${scopeId}.workbench`, value); } };
    }
    /** Wait for already-queued writes (shutdown and tests). */
    async flush(): Promise<void> { await this.store.flush(); }
}
