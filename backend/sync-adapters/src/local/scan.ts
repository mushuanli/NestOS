import { readdir, readFile } from 'node:fs/promises';
import { assertSync, sha256, type Snapshot } from '@itookit/vfs-sync';
import type { ISidecarDb, LocalStorageAccess } from '@itookit/vfsdriver-local';
import { nativePath, stat } from './files';
export interface LocalNode { kind: 'file' | 'directory'; dev: string; ino: string; mtime: number; mode: number; hash?: string; size?: number; metadata: string }
export interface LocalSnapshot { root: { dev: string; ino: string }; scan: Snapshot; nodes: Record<string, LocalNode>; objects: Record<string, Uint8Array<ArrayBuffer>> }
export async function inspectNode(path: string, db: ISidecarDb, virtual: string, maxBytes = 32 * 1024 * 1024): Promise<{ node: LocalNode; bytes?: Uint8Array<ArrayBuffer> } | undefined> {
    const before = await stat(path); if (!before) return undefined;
    assertSync(!before.isSymbolicLink() && (before.isDirectory() || before.isFile()), 'LOCAL_FILE_TYPE_UNSUPPORTED');
    assertSync(before.isDirectory() || before.size <= maxBytes, 'OBJECT_TOO_LARGE');
    const bytes = before.isFile() ? new Uint8Array(await readFile(path)) : undefined;
    const after = await stat(path);
    assertSync(after && before.ino === after.ino && before.dev === after.dev && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs && before.size === after.size && before.mode === after.mode, 'LOCAL_CHANGED');
    return { node: { kind: before.isDirectory() ? 'directory' : 'file', dev: String(before.dev), ino: String(before.ino),
        mtime: before.mtimeMs, mode: before.mode, hash: bytes ? await sha256(bytes) : undefined,
        size: bytes?.length, metadata: JSON.stringify(await db.getMetaExt(virtual)) }, bytes };
}
export async function scanLocal(storage: LocalStorageAccess, db: ISidecarDb, root: string, maxBytes = 32 * 1024 * 1024): Promise<LocalSnapshot> {
    const physical = await nativePath(storage, root), node = await stat(physical); assertSync(node && node.isDirectory(), 'SYNC_ROOT_UNAVAILABLE');
    const result: LocalSnapshot = { root: { dev: String(node.dev), ino: String(node.ino) },
        scan: { entries: Object.create(null), completeDirectories: [] }, nodes: Object.create(null), objects: {} };
    await scanDirectory(storage, db, root, '', result, maxBytes, { remaining: 10000 });
    const after = await stat(physical); assertSync(after?.dev === node.dev && after.ino === node.ino, 'SYNC_ROOT_CHANGED'); return result;
}
async function scanDirectory(storage: LocalStorageAccess, db: ISidecarDb, root: string, relative: string, result: LocalSnapshot, maxBytes: number, budget: { remaining: number }): Promise<void> {
    const virtual = root + (relative ? '/' + relative : ''), physical = await nativePath(storage, virtual);
    try {
        const before = await stat(physical); assertSync(before && before.isDirectory(), 'LOCAL_CHANGED');
        const entries = await readdir(physical);
        for (const name of entries) {
            assertSync(budget.remaining-- > 0, 'LOCAL_SCAN_BUDGET_EXCEEDED');
            const child = relative ? relative + '/' + name : name;
            await scanEntry(storage, db, root, child, result, maxBytes, budget);
        }
        const after = await stat(physical);
        assertSync(after?.ino === before.ino && after.dev === before.dev && after.mtimeMs === before.mtimeMs, 'LOCAL_CHANGED');
        result.scan.completeDirectories.push(relative);
    } catch (error) { if (relative) result.scan.entries[relative] = { state: 'unknown', code: errorCode(error) }; }
}
async function scanEntry(storage: LocalStorageAccess, db: ISidecarDb, root: string, relative: string, result: LocalSnapshot, maxBytes: number, budget: { remaining: number }): Promise<void> {
    try {
        const virtual = root + '/' + relative, physical = await nativePath(storage, virtual);
        const inspected = await inspectNode(physical, db, virtual, maxBytes); assertSync(inspected, 'LOCAL_CHANGED');
        const { node, bytes } = inspected; result.nodes[relative] = node;
        if (node.kind === 'directory') {
            result.scan.entries[relative] = { state: 'present', entry: { kind: 'directory', path: relative }, executable: 'unavailable' };
            await scanDirectory(storage, db, root, relative, result, maxBytes, budget); return;
        }
        if ((await db.listRecordFields(virtual)).length) { result.scan.entries[relative] = { state: 'unsupported', code: 'RECORD_FILE_REQUIRES_DOMAIN_SYNC' }; return; }
        result.objects[node.hash!] = bytes!;
        result.scan.entries[relative] = { state: 'present', entry: { kind: 'file', path: relative, hash: node.hash!, size: String(node.size!), executable: !!(node.mode & 0o111) }, executable: 'known' };
    } catch (error) { result.scan.entries[relative] = { state: 'unknown', code: errorCode(error) }; }
}
function errorCode(error: unknown): string { return (error as { code?: string }).code ?? 'LOCAL_SCAN_FAILED'; }
