import { assertSync, decimal, validId, validPath, type SyncState } from '@itookit/vfs-sync';

export function validRoot(root: string): void {
    assertSync(root.startsWith('/') && root !== '/' && !root.endsWith('/') && root !== '/var/lib/sync' && !root.startsWith('/var/lib/sync/') && !'/var/lib/sync'.startsWith(root + '/'), 'INVALID_SYNC_ROOT');
    validPath(root.slice(1));
}
export function validateState(state: SyncState): void {
    assertSync(state && state.schemaVersion === 1 && state.binding && Array.isArray(state.baseline) && Array.isArray(state.history), 'SYNC_CONTROL_CORRUPT');
    const b = state.binding;
    assertSync(state.setupPending === undefined || typeof state.setupPending === 'boolean', 'SYNC_CONTROL_CORRUPT');
    if (b.connectionId !== undefined) validId(b.connectionId);
    for (const id of [b.bindingId, b.localProjectId, b.projectId, b.replicaId, b.datasetId, b.authorityId, b.namespaceId, b.historyEpoch]) validId(id);
    for (const revision of [b.bindingRevision, b.locatorRevision, b.scopeRevision, b.policyRevision, state.nextSeq]) decimal(revision);
    assertSync(['active', 'detaching', 'detached'].includes(b.state) && ['both', 'upload', 'download'].includes(b.direction));
    for (const entry of state.baseline) {
        validPath(entry.path);
        assertSync(['file', 'directory'].includes(entry.kind));
        if (entry.kind === 'file') { assertSync(/^[a-f0-9]{64}$/.test(entry.hash)); decimal(entry.size); }
    }
    validRoot(b.root);
}
// SeqFile values stay portable; IndexedDB structured cloning is not a file format.
export function encodePlan(value: unknown): string {
    return JSON.stringify(value, (_key, item) => item instanceof ArrayBuffer
        ? { $syncBytes: Array.from(new Uint8Array(item)) } : item);
}
export function decodePlan<T>(value: string): T {
    return JSON.parse(value, (_key, item) => item && typeof item === 'object' && Object.keys(item).length === 1
        && Array.isArray(item.$syncBytes) ? new Uint8Array(item.$syncBytes).buffer : item) as T;
}
