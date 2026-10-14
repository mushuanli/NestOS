import { lstat, mkdir, open, link, unlink, readFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { assertSync, randomId, sha256, validPath } from '@itookit/vfs-sync';
import type { LocalStorageAccess } from '@itookit/vfsdriver-local';
export async function stat(path: string) {
    try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function nativePath(storage: LocalStorageAccess, path: string): Promise<string> {
    assertSync(path.startsWith('/') && resolve(storage.rootDir) === await realpath(storage.rootDir), 'INVALID_LOCAL_STORAGE_ROOT');
    const parts = path.slice(1).split('/').filter(Boolean); if (parts.length) validPath(parts.join('/'));
    let current = storage.rootDir;
    for (const part of parts) {
        current = join(current, part); assertSync(!(await stat(current))?.isSymbolicLink(), 'LOCAL_SYMLINK_UNSUPPORTED');
    }
    return current;
}
export async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function ensureDirectory(path: string): Promise<void> {
    if (await stat(path)) return;
    await ensureDirectory(dirname(path));
    try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assertSync((await stat(path))?.isDirectory(), 'SYNC_CONTROL_PATH_COLLISION');
    await syncDirectory(dirname(path));
}
export async function createDurable(path: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
    await ensureDirectory(dirname(path)); const handle = await open(path, 'wx', mode);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(dirname(path));
}
export async function ensureSeqFile(path: string): Promise<void> {
    const node = await stat(path); assertSync(!node || node.isFile(), 'SYNC_CONTROL_PATH_COLLISION');
    if (!node) {
        try { await createDurable(path, new Uint8Array()); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
}
export async function installObject(path: string, bytes: Uint8Array, hash: string): Promise<void> {
    if (await stat(path)) { assertSync(await sha256(await readFile(path)) === hash, 'LOCAL_OBJECT_CORRUPT'); return; }
    const temp = path + '.' + randomId(); await createDurable(temp, bytes);
    try {
        try { await link(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        assertSync(await sha256(await readFile(path)) === hash, 'LOCAL_OBJECT_CORRUPT'); await syncDirectory(dirname(path));
    } finally { await unlink(temp); await syncDirectory(dirname(path)); }
}
