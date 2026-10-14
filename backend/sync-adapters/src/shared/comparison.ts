import { assertSync, bindingToken, type StoredFilePlan, type StateStore, type FileEntry } from '@itookit/vfs-sync';
import type { LocalApplicationStore } from './local';

export interface FileContentPreview {
    kind: 'missing' | 'file' | 'directory'; hash?: string; size?: number;
    content?: { text?: string; reason?: 'binary' | 'too-large' | 'unavailable' };
}
export interface FileSyncComparison { path: string; baseline: FileContentPreview; local: FileContentPreview; remote: FileContentPreview }
/** Compare immutable captured objects; never substitute a later working file. */
export async function compareSyncConflict(store: StateStore & Pick<LocalApplicationStore, 'plan' | 'object'>,
    planId: string, path: string): Promise<FileSyncComparison> {
    const stored = await store.plan<StoredFilePlan>(planId), state = await store.read();
    assertSync(stored && stored.bindingToken === bindingToken(state.binding) && stored.phase === 'prepared', 'PLAN_STALE');
    const conflict = stored.plan.conflicts.find(c => c.path === path); assertSync(conflict, 'INVALID_CONFLICT_PATH');
    const [baseline, local, remote] = await Promise.all([conflict.baseline, conflict.local, conflict.remote].map(e => preview(e, hash => store.object(hash))));
    return { path, baseline, local, remote };
}
async function preview(entry: FileEntry | undefined, read: (hash: string) => Promise<Uint8Array>): Promise<FileContentPreview> {
    if (!entry) return { kind: 'missing' };
    if (entry.kind === 'directory') return { kind: 'directory' };
    const result: FileContentPreview = { kind: 'file', hash: entry.hash };
    if (BigInt(entry.size) > 256n * 1024n) return { ...result, content: { reason: 'too-large' } };
    let bytes: Uint8Array;
    try { bytes = await read(entry.hash); }
    catch (error) {
        if ((error as {code?: string}).code !== 'LOCAL_OBJECT_MISSING') throw error;
        return { ...result, content: { reason: 'unavailable' } };
    }
    result.size = bytes.byteLength;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        result.content = text.includes('\0') ? { reason: 'binary' } : { text };
    } catch { result.content = { reason: 'binary' }; }
    return result;
}
