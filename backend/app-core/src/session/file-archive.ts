import { FSError, type IFileSystem, type FSNode } from '@itookit/vfs-core';

export interface FileArchiveEntry {
    path: string; type: 'file' | 'directory' | 'seqfile'; base64?: string;
    metadata?: Record<string, unknown>; tags?: string[]; icon?: string; mimeType?: string; assets?: FileArchiveEntry[]; records?: Array<{ key: string; value: string }>;
}
export function archivePath(path: unknown): string {
    if (typeof path !== 'string' || !path || path.split('/').some(name => !name || ['.', '..'].includes(name) || /[\\\0]/.test(name)))
        throw new FSError('EINVAL', 'Invalid archive path');
    return path;
}
export function decodeArchiveBytes(value: unknown): ArrayBuffer {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        throw new FSError('EINVAL', 'Invalid archive binary content');
    return Uint8Array.from(atob(value), char => char.charCodeAt(0)).buffer as ArrayBuffer;
}
const encode = (bytes: ArrayBuffer): string => {
    let binary = ''; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte); return btoa(binary);
};
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** Export exactly the selected roots and retain their relative directory structure. */
export async function exportFileArchive(fs: IFileSystem, paths: string[]): Promise<FileArchiveEntry[]> {
    const roots = [...new Set(paths)].filter(path => !paths.some(other => other !== path && (other === '/' || path.startsWith(other + '/'))));
    let base = parent(roots[0] ?? '/');
    while (roots.some(path => path !== '/' && !path.startsWith(base === '/' ? '/' : base + '/'))) base = parent(base);
    const entries = new Map<string, FileArchiveEntry>();
    const queue = [...roots];
    while (queue.length) {
        const path = queue.shift()!, node = await fs.driver.getNode(path);
        if (!node) throw new FSError('ENOENT', 'Selected file no longer exists');
        if (path !== '/') {
            const relative = path.slice(base === '/' ? 1 : base.length + 1);
            addParents(entries, relative);
            entries.set(relative, await exportEntry(fs, node, relative));
        }
        if (node.type === 'directory') queue.push(...(await fs.driver.getChildren(path, { includeHidden: true })).map(item => item.path));
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function addParents(entries: Map<string, FileArchiveEntry>, path: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
        const name = parts.slice(0, i).join('/');
        if (!entries.has(name)) entries.set(name, { path: name, type: 'directory' });
    }
}
function portableMetadata(value?: FSNode['metadata']): Record<string, unknown> {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new FSError('EINVAL', 'Invalid archive metadata');
    return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) =>
        !key.startsWith('_') && !/^(vfs|mount|readonly|readOnly|__proto__|constructor|prototype)/.test(key)));
}
export function parseFileArchive(value: unknown): FileArchiveEntry[] {
    if (!Array.isArray(value)) throw new FSError('EINVAL', 'Archive files must be a list');
    const entries = value.map((item): FileArchiveEntry => {
        if (!item || !['file', 'directory', 'seqfile'].includes(item.type)) throw new FSError('EINVAL', 'Invalid archive file');
        archivePath(item.path); if (item.type !== 'directory') decodeArchiveBytes(item.base64);
        return { path: item.path, type: item.type, ...(item.type !== 'directory' ? { base64: item.base64, records: parseRecords(item.records) } : {}),
            metadata: portableMetadata(item.metadata), tags: Array.isArray(item.tags) ? item.tags.filter((tag: unknown) => typeof tag === 'string') : [],
            assets: item.assets === undefined ? undefined : parseFileArchive(item.assets), icon: typeof item.icon === 'string' ? item.icon : undefined, mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined };
    });
    const paths = new Map(entries.map(item => [item.path, item.type]));
    if (paths.size !== entries.length) throw new FSError('EINVAL', 'Duplicate archive path');
    for (const entry of entries) {
        const parts = entry.path.split('/');
        for (let i = 1; i < parts.length; i++) if (paths.get(parts.slice(0, i).join('/')) !== 'directory')
            throw new FSError('EINVAL', 'Archive parent directory is missing');
    }
    return entries;
}

/** Copies never overwrite existing files, including when the same archive is imported twice. */
export async function importFileArchive(fs: IFileSystem, target: string, entries: FileArchiveEntry[]): Promise<string[]> {
    entries = parseFileArchive(entries);
    const names = new Map<string, string>(), created: string[] = [];
    try {
        for (const entry of [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
            const parts = entry.path.split('/'), top = parts[0]!;
            if (!names.has(top)) names.set(top, await availableName(fs, target, top));
            parts[0] = names.get(top)!;
            const path = `${target === '/' ? '' : target}/${parts.join('/')}`;
            const node = entry.type === 'directory'
                ? await fs.driver.createDirectory({ parentPath: parent(path), name: parts.at(-1)!, icon: entry.icon })
                : await fs.driver.createFile({ parentPath: parent(path), name: parts.at(-1)!, content: decodeArchiveBytes(entry.base64), type: entry.type, icon: entry.icon });
            if (parts.length === 1) created.push(node.path);
            if (entry.metadata && Object.keys(entry.metadata).length) await fs.driver.updateMetadata(node.path, entry.metadata);
            await restoreRecords(fs, node.path, entry.records);
            if (entry.assets?.length) await importFileArchive(fs, await fs.meta.assets.ensureAssetDir(node.path), entry.assets);
            if (entry.tags?.length) await fs.meta.tags.setTags(node.path, entry.tags);
        }
        return created;
    } catch (error) {
        const failures = await Promise.allSettled(created.map(path => fs.driver.delete([path], { recursive: true })));
        const cleanup = failures.flatMap(item => item.status === 'rejected' ? [item.reason] : []);
        if (cleanup.length) throw new AggregateError([error, ...cleanup], 'File import and cleanup failed');
        throw error;
    }
}
async function availableName(fs: IFileSystem, target: string, name: string): Promise<string> {
    let result = name;
    for (let index = 2; await fs.driver.exists(`${target === '/' ? '' : target}/${result}`); index++) {
        const dot = name.lastIndexOf('.');
        result = dot > 0 ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`;
    }
    return result;
}

async function exportAssets(fs: IFileSystem, path: string): Promise<FileArchiveEntry[] | undefined> {
    if (!fs.capabilities.assets) return undefined;
    const directory = await fs.meta.assets.getAssetDirPath(path);
    if (!directory) return undefined;
    const entries = await exportFileArchive(fs, [directory]);
    const prefix = directory.split('/').pop()! + '/';
    return entries.filter(entry => entry.path.startsWith(prefix)).map(entry => ({ ...entry, path: entry.path.slice(prefix.length) }));
}

async function exportEntry(fs: IFileSystem, node: FSNode, path: string): Promise<FileArchiveEntry> {
    if (!['file', 'seqfile', 'directory'].includes(node.type)) throw new FSError('EINVAL', `Unsupported archive node: ${node.type}`);
    const entry: FileArchiveEntry = { path, type: node.type as FileArchiveEntry['type'],
        metadata: portableMetadata(node.metadata), tags: [...node.tags ?? []], icon: node.icon };
    if (node.type !== 'directory') {
        entry.base64 = node.type === 'seqfile' ? '' : encode(await fs.driver.readContent(node.path, { encoding: 'binary', representation: 'bytes' }));
        entry.mimeType = node.mimeType;
        entry.assets = await exportAssets(fs, node.path);
        if (fs.meta.seq) {
            const records: Array<{ key: string; value: string }> = [];
            await fs.meta.seq.walkEntries(node.path, record => { records.push({ key: record.key, value: record.value }); return true; });
            if (records.length) entry.records = records;
        }
    }
    return entry;
}
function parseRecords(value: unknown): FileArchiveEntry['records'] {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(item => !item || typeof item.key !== 'string' || typeof item.value !== 'string'))
        throw new FSError('EINVAL', 'Invalid archive records');
    if (new Set(value.map(item => item.key)).size !== value.length) throw new FSError('EINVAL', 'Duplicate archive record key');
    return value.map(item => ({ key: item.key, value: item.value }));
}
async function restoreRecords(fs: IFileSystem, path: string, records: FileArchiveEntry['records']): Promise<void> {
    if (!records?.length) return;
    if (!fs.meta.seq?.transaction) throw new FSError('EINVAL', 'Destination does not support archive records');
    await fs.meta.seq.transaction(async tx => { for (const entry of records) await tx.setEntry(path, entry.key, entry.value); });
}
