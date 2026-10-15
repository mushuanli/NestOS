import { FileIgnoreFilter, createVFSFileDiscoverySource, type FSNode, type IFileSystem } from '@itookit/vfs-core';

/** Per-read rules: parallel ancestors, no stale cache after external edits. */
export async function filterDirectoryFiles(fs: IFileSystem, nodes: FSNode[], signal?: AbortSignal): Promise<FSNode[]> {
    const source = createVFSFileDiscoverySource(fs, {signal});
    const reads = new Map<string, Promise<string | null>>();
    source.readIgnoreFile = path => {
        let pending = reads.get(path);
        if (!pending) {
            pending = readIgnoreFile(fs, path, signal); reads.set(path, pending);
            // Speculative rules in ignored descendants need not be consumed by the filter.
            void pending.catch(() => {});
        }
        return pending;
    };
    for (const node of nodes) prefetchRules(source, node);
    const filter = new FileIgnoreFilter(source, signal, {files: ['.gitignore'], defaults: []});
    try {
        const flags = await Promise.all(nodes.map(node => filter.accepts(node.path, node.type === 'directory')));
        return nodes.filter((_, index) => flags[index]);
    } finally {
        // Do not release a caller-owned source while a speculative read is still running.
        await Promise.allSettled(reads.values());
    }
}

function prefetchRules(source: ReturnType<typeof createVFSFileDiscoverySource>, node: FSNode): void {
    const root = source.rootFor(node.path);
    if (node.type === 'directory' && node.path === root) return;
    let directory = node.path.slice(0, node.path.lastIndexOf('/')) || '/';
    while (directory === root || directory.startsWith(root === '/' ? '/' : root + '/')) {
        void source.readIgnoreFile(`${directory === '/' ? '' : directory}/.gitignore`);
        if (directory === root) break;
        directory = directory.slice(0, directory.lastIndexOf('/')) || '/';
    }
}

async function readIgnoreFile(fs: IFileSystem, path: string, signal?: AbortSignal): Promise<string | null> {
    const node = await fs.driver.getNode(path, {signal});
    if (node?.type !== 'file') return null;
    if ((node.size ?? 0) > 1024 * 1024) throw new Error('Ignore file size limit exceeded');
    return fs.driver.readContent(path, {signal, representation: 'bytes', encoding: 'utf-8'});
}
