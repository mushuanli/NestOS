import { assertSync } from '@itookit/vfs-sync';
import { req, STORE_NODES } from '@itookit/vfsdriver-indexeddb';

export interface StoredNode {
    path: string; type: 'file' | 'directory'; content: ArrayBuffer; size: number;
    parentPath?: string | null; version: number; createdAt: number; modifiedAt: number;
    tags: string[]; metadata: string; icon?: string;
}
export function makeNode(path: string, type: StoredNode['type'], content: ArrayBuffer, previous?: StoredNode): StoredNode {
    const now = Date.now();
    return { path, parentPath: path.slice(0, path.lastIndexOf('/')) || '/', type, content, size: content.byteLength,
        version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, modifiedAt: now,
        tags: previous?.tags ?? [], icon: previous?.icon, metadata: previous?.metadata ?? '{}' };
}
export async function ensurePrivateParents(tx: IDBTransaction, path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean), paths: string[] = [];
    for (let i = 1; i < parts.length; i++) paths.push('/' + parts.slice(0, i).join('/'));
    const nodes = tx.objectStore(STORE_NODES), rows = await Promise.all(paths.map(p => req<StoredNode | undefined>(nodes.get(p))));
    for (let i = 0; i < paths.length; i++) {
        assertSync(!rows[i] || rows[i]?.type === 'directory', 'SYNC_CONTROL_PATH_COLLISION');
        if (!rows[i]) nodes.put(makeNode(paths[i], 'directory', new ArrayBuffer(0)));
    }
}
