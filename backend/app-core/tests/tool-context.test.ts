import { afterEach, describe, expect, it } from 'vitest';
import { createVFS, createFileSystemView, MemoryBackend, type IFileSystem } from '@itookit/vfs-core';
import { createVFSToolContext } from '../src/vfs/tool-context';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function openFs(): Promise<IFileSystem> {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanup.push(() => manager.dispose());
    return manager.openFileSystem('/');
}

describe('createVFSToolContext.stat', () => {
    it('rejects oversized search reads before loading contents and allows explicit unbounded reads', async () => {
        const fs = await openFs();
        await fs.driver.createFile({ name: 'large', parentPath: '/', content: '12345' });
        const context = createVFSToolContext({ fs, cwd: '/' });
        await expect(context.readFile('/large', { maxBytes: 4 })).rejects.toMatchObject({ code: 'SEARCH_FILE_TOO_LARGE' });
        expect(await context.readFile('/large', { maxBytes: 5 })).toBe('12345');
        expect(await context.readFile('/large')).toBe('12345');
    });
    it('yields early files without visiting the rest of the tree', async () => {
        const fs = await openFs();
        await fs.driver.createFile({ name: 'early.txt', parentPath: '/work', recursive: true, content: 'mdx' });
        await fs.driver.createFile({ name: 'later.txt', parentPath: '/work/slow', recursive: true, content: 'mdx' });
        const context = createVFSToolContext({ fs, cwd: '/work' });
        const children = fs.driver.getChildren.bind(fs.driver);
        fs.driver.getChildren = async (path, options) => {
            if (path === '/work/slow') throw new Error('Unneeded directory was visited');
            return children(path, options as { fields?: 'full' });
        };
        for await (const file of context.walkFiles!('.')) {
            expect(file).toBe('/work/early.txt');
            break;
        }
    });
    it('prunes excluded directories before traversal and observes cancellation', async () => {
        const fs = await openFs();
        await fs.driver.createFile({ name: 'main.ts', parentPath: '/work/src', recursive: true, content: 'mdx' });
        await fs.driver.createFile({ name: 'dep.ts', parentPath: '/work/node_modules', recursive: true, content: 'mdx' });
        const context = createVFSToolContext({ fs, cwd: '/work', sessionId: 's1' });
        const children = fs.driver.getChildren.bind(fs.driver);
        fs.driver.getChildren = async path => {
            if (path.includes('node_modules')) throw new Error('Excluded directory was traversed');
            return children(path);
        };
        expect(await context.listFiles('.', { excludeDirectories: ['node_modules'] })).toEqual(['/work/src/main.ts']);
        const abort = new AbortController(); abort.abort();
        await expect(context.listFiles('.', { signal: abort.signal })).rejects.toThrow();
    });
    it('reports the node type without walking the subtree', async () => {
        const fs = await openFs();
        await fs.driver.createFile({ name: 'notes.md', parentPath: '/', content: 'hello' });
        await fs.driver.createDirectory({ name: 'work', parentPath: '/' });
        const context = createVFSToolContext({ fs, cwd: '/', sessionId: 's1' });

        expect(await context.stat?.('/notes.md')).toBe('file');
        expect(await context.stat?.('/work')).toBe('directory');
        expect(await context.stat?.('/missing')).toBeNull();

        // The guard exists for existence checks; a recursive listFiles() on a large
        // tree is exactly the cost it must avoid.
        const children = fs.driver.getChildren;
        fs.driver.getChildren = async () => { throw new Error('stat must not enumerate children'); };
        try {
            expect(await context.stat?.('/work')).toBe('directory');
        } finally { fs.driver.getChildren = children; }
    });

    it('resolves relative paths against cwd', async () => {
        const fs = await openFs();
        await fs.driver.createFile({ name: 'child.yml', parentPath: '/work', recursive: true, content: 'x' });
        const context = createVFSToolContext({ fs, cwd: '/work', sessionId: 's1' });

        expect(await context.stat?.('child.yml')).toBe('file');
        expect(await context.stat?.('/work/child.yml')).toBe('file');
    });
});


describe('workspace mount namespace', () => {
    it('resolves sibling paths while preserving mount permissions and source confinement', async () => {
        const source = await openFs();
        await source.driver.createFile({ name: 'main.txt', parentPath: '/project', recursive: true, content: 'project' });
        await source.driver.createFile({ name: 'guide.txt', parentPath: '/reference', recursive: true, content: 'reference' });
        await source.driver.createFile({ name: 'secret', parentPath: '/', content: 'private' });
        const fs = createFileSystemView({ viewId: 'test-workspace', mounts: [
            { mountId: 'workspace', at: '/workspace', fs: source, root: '/project', access: 'rw' },
            { mountId: 'reference', at: '/reference', fs: source, root: '/reference', access: 'ro' },
        ] });
        cleanup.push(() => fs.dispose());
        const tools = createVFSToolContext({ fs, cwd: '/workspace' });
        expect(await tools.readFile('./main.txt')).toBe('project');
        expect(await tools.readFile('../reference/guide.txt')).toBe(await tools.readFile('/reference/guide.txt'));
        await tools.writeFile('./main.txt', 'updated');
        expect(await source.driver.readContent('/project/main.txt', { encoding: 'utf-8' })).toBe('updated');
        await expect(tools.writeFile('../reference/guide.txt', 'denied')).rejects.toThrow();
        await expect(tools.readFile('../../secret')).rejects.toThrow();
        await expect(tools.readFile('file:///secret')).rejects.toThrow();
        expect(await source.driver.readContent('/reference/guide.txt', { encoding: 'utf-8' })).toBe('reference');
    });
});
