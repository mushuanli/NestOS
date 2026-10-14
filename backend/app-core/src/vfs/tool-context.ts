import type { ToolVFSContext } from '@itookit/tools/contracts';
import { createVFSFileDiscoverySource, discoverFiles, normalizeVirtualPath, pathUtils, type FileSystemContext } from '@itookit/vfs-core';

/** One exact-path adapter per authorized view. Never resolves a basename globally. */
export function createVFSToolContext(context: FileSystemContext): ToolVFSContext {
    const revisions = new Map<string, string | undefined>();
    const resolve = (path: string) => {
        if (/[\\\0]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
            throw new Error('Invalid virtual file path');
        }
        return normalizeVirtualPath(pathUtils.normalize(path.startsWith('/') ? path : `${context.cwd}/${path}`));
    };
    const walkFiles: NonNullable<ToolVFSContext['walkFiles']> = async function* (path, options) {
        const source = createVFSFileDiscoverySource(context.fs, options);
        for await (const node of discoverFiles(source, resolve(path ?? context.cwd), options)) yield node.path;
    };
    return {
        walkFiles,
        async readFile(path, options) {
            const target = resolve(path), maxBytes = options?.maxBytes;
            if (maxBytes === undefined) return context.fs.driver.readContent(target, { encoding: 'utf-8', onRevision: value => { revisions.set(target, value); } });
            const node = await context.fs.driver.getNode(target);
            const tooLarge = () => Object.assign(new Error(`Search file exceeds ${maxBytes} bytes: ${target}`), { code: 'SEARCH_FILE_TOO_LARGE' });
            if (node && 'size' in node && (node.size ?? 0) > maxBytes) throw tooLarge();
            const bytes = await context.fs.driver.readContent(target, { encoding: 'binary', offset: 0, length: maxBytes + 1, onRevision: value => { revisions.set(target, value); } });
            if (bytes.byteLength > maxBytes) throw tooLarge();
            return new TextDecoder().decode(bytes);
        },
        async writeFile(path, content) {
            const target = resolve(path);
            if (await context.fs.driver.exists(target)) await context.fs.driver.writeContent(target, content, { ifRevision: revisions.get(target), onRevision: value => { revisions.set(target, value); } });
            else await context.fs.driver.createFile({ name: pathUtils.basename(target), parentPath: pathUtils.dirname(target), content, recursive: true });
        },
        async listFiles(path, options) {
            const files: string[] = [];
            for await (const file of walkFiles(path, options)) files.push(file);
            return files;
        },
        async stat(path) {
            const node = await context.fs.driver.getNode(resolve(path));
            return node?.type ?? null;
        },
    };
}
