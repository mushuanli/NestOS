import { FSError, type IVFSManager } from '@itookit/vfs-core';

const queues = new WeakMap<IVFSManager, Promise<void>>();
function fileName(name: string): string {
    if (!name || name.length > 200) throw new FSError('EINVAL', 'Invalid UI document name');
    return `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

export async function readUiDocuments(vfs: IVFSManager, names: string[]): Promise<Record<string, unknown>> {
    if (names.length > 32) throw new FSError('EINVAL', 'Too many UI documents');
    const files = names.map(name => [name, fileName(name)] as const);
    await queues.get(vfs);
    const fs = await vfs.openFileSystem('/etc');
    return Object.fromEntries(await Promise.all(files.map(async ([name, file]) => {
        try {
            const content = await fs.driver.readContent(`/ui/${file}`);
            return [name, JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content))];
        } catch { return [name, undefined]; }
    })));
}

/** Keep upsert and cross-client ordering beside storage, without interpreting UI schemas. */
export function writeUiDocuments(vfs: IVFSManager, documents: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(documents);
    if (entries.length > 32) return Promise.reject(new FSError('EINVAL', 'Too many UI documents'));
    const files = entries.map(([name, value]) => ({ file: fileName(name), content: JSON.stringify(value, null, 2) }));
    const pending = (queues.get(vfs) ?? Promise.resolve()).then(async () => {
        const fs = await vfs.openFileSystem('/etc');
        for (const { file, content } of files) {
            const path = `/ui/${file}`;
            if (await fs.driver.exists(path)) {
                if (await fs.driver.readContent(path, { encoding: 'utf-8' }) !== content) await fs.driver.writeContent(path, content);
            } else await fs.driver.createFile({ name: file, parentPath: '/ui', content, recursive: true });
        }
    });
    queues.set(vfs, pending.catch(() => {}));
    return pending;
}
