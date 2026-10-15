import { FSError, normalizeVirtualPath, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import type { NavigationDirectory, NavigationView } from '@itookit/app-contracts/services';
import { readUiDocuments } from './ui-documents';

interface Entry { revision: number; time: number; valid: boolean; stop(): void; value: Promise<NavigationDirectory> }
const caches = new WeakMap<IVFSManager, Map<string, Entry>>();
const MAX_AGE = 15000;
function drop(cache: Map<string, Entry>, root: string, entry: Entry): void {
    if (cache.get(root) === entry) cache.delete(root);
    entry.stop();
}
function remember(cache: Map<string, Entry>, root: string, fs: IFileSystem): Entry {
    const entry: Entry = { revision: fs.revision, time: Date.now(), valid: true, stop: () => {},
        value: Promise.resolve().then(() => readDirectory(fs, fs.revision)) };
    const changed = () => { entry.valid = false; drop(cache, root, entry); };
    const stops = fs.onAny ? [fs.onAny(changed)]
        : (['node:created', 'node:updated', 'node:deleted', 'node:moved', 'node:renamed'] as const).map(type => fs.on(type, changed));
    entry.stop = () => stops.splice(0).forEach(stop => stop());
    cache.set(root, entry);
    while (cache.size > 8) { const first = cache.entries().next().value!; drop(cache, first[0], first[1]); }
    void entry.value.then(value => {
        if (value.nodes.length > 1000 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024) drop(cache, root, entry);
    }, () => drop(cache, root, entry));
    return entry;
}
/** Share bounded metadata across views; mutations invalidate independently of mount identity revisions. */
async function navigationDirectory(vfs: IVFSManager, root: string, copy = true) {
    if (typeof root !== 'string' || root !== normalizeVirtualPath(root)) throw new FSError('EINVAL', 'Invalid navigation root');
    const fs = await vfs.openFileSystem(root);
    let cache = caches.get(vfs); if (!cache) { cache = new Map(); caches.set(vfs, cache); }
    let entry = cache.get(root);
    if (entry && (entry.revision !== fs.revision || Date.now() - entry.time >= MAX_AGE)) { drop(cache, root, entry); entry = undefined; }
    entry ??= remember(cache, root, fs);
    const value = await entry.value, directory = copy ? structuredClone(value) : value;
    if (copy && !entry.valid) directory.stale = true;
    return { fs, directory, current: () => entry.valid && entry.revision === fs.revision && Date.now() - entry.time < MAX_AGE };
}
async function readDirectory(fs: IFileSystem, revision: number): Promise<NavigationDirectory> {
    const [node, nodes, ignore] = await Promise.all([fs.driver.getNode('/'), fs.driver.getChildren('/'), readIgnore(fs)]);
    return { revision, node, nodes, ignore };
}
async function readIgnore(fs: IFileSystem): Promise<NonNullable<NavigationDirectory['ignore']>> {
    const node = await fs.driver.getNode('/.gitignore');
    if (node?.type !== 'file') return { node };
    if ((node.size ?? 0) > 1024 * 1024) throw new FSError('EFBIG', 'Ignore file size limit exceeded');
    const raw = await fs.driver.readContent('/.gitignore', { encoding: 'utf-8' });
    return { node, content: typeof raw === 'string' ? raw : new TextDecoder().decode(raw) };
}
export async function navigationView(vfs: IVFSManager, options: { root: string; scope: string }): Promise<NavigationView> {
    const [snapshot, documents] = await Promise.all([navigationDirectory(vfs, options.root),
        readUiDocuments(vfs, [`${options.scope}.ui`, `${options.scope}.workbench`])]);
    if (!snapshot.current()) snapshot.directory.stale = true;
    return { files: { fs: snapshot.fs, cwd: '/' }, directory: snapshot.directory, documents };
}
export async function warmNavigation(vfs: IVFSManager, roots: string[]): Promise<void> {
    if (!Array.isArray(roots) || roots.length > 2) throw new FSError('EINVAL', 'Too many navigation roots');
    for (const root of roots) await navigationDirectory(vfs, root, false);
}
