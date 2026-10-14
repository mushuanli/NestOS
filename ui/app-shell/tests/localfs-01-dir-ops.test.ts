/**
 * LocalFS integration — Directory operations
 *
 * Each test writes to tests/test_vfsroot/dir-ops/<NNN>/ on the real filesystem.
 * Inspect those directories after a run to verify the exact disk layout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import {
    setupLocalVFS, diskExists, diskList, diskStat, type LocalTestVFS,
} from './helpers-localfs';

const SUITE = 'dir-ops';

describe('Directory — create', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('creates a real directory on disk', async () => {
        await vfs.fs.driver.createDirectory({ name: 'docs', parentPath: null });

        const stat = await diskStat(vfs.moduleDir, 'docs');
        expect(stat?.isDirectory()).toBe(true);
    });

    it('appears in getChildren after creation', async () => {
        await vfs.fs.driver.createDirectory({ name: 'projects', parentPath: null });

        const children = await vfs.fs.driver.getChildren('/');
        expect(children.map(c => c.name)).toContain('projects');
    });

    it('creates nested directories (recursive path)', async () => {
        await vfs.fs.driver.createFile({
            name:           'note.md',
            parentPath: '/a/b/c',
            content:        'deep',
            recursive:      true,
        });

        expect(await diskExists(vfs.moduleDir, 'a/b/c/note.md')).toBe(true);
        expect(await diskStat(vfs.moduleDir, 'a/b')).not.toBeNull();
    });

    it('createDirectory is idempotent (existing dir)', async () => {
        await vfs.fs.driver.createDirectory({ name: 'dup', parentPath: null });
        // Second call should not throw
        await expect(
            vfs.fs.driver.createDirectory({ name: 'dup', parentPath: null })
        ).resolves.not.toThrow();
    });
});

describe('Directory — list', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('getChildren lists pre-existing disk files and dirs', async () => {
        // Write directly to disk before VFS sees them
        await fsp.writeFile(join(vfs.moduleDir, 'pre.md'), 'hello');
        await fsp.mkdir(join(vfs.moduleDir, 'pre-dir'), { recursive: true });

        const children = await vfs.fs.driver.getChildren('/');
        const names = children.map(c => c.name);
        expect(names).toContain('pre.md');
        expect(names).toContain('pre-dir');
    });

    it('getChildren is lazy — subdirectory contents not pre-loaded', async () => {
        await vfs.fs.driver.createDirectory({ name: 'sub', parentPath: null });
        await vfs.fs.driver.createFile({ name: 'child.txt', parentPath: '/sub', content: 'x' });

        const children = await vfs.fs.driver.getChildren('/');
        const sub = children.find(n => n.name === 'sub');
        expect(sub?.children).toBeUndefined();  // lazy sentinel

        // Expand sub explicitly
        const subChildren = await vfs.fs.driver.getChildren(sub!.path);
        expect(subChildren.map(c => c.name)).toContain('child.txt');
    });

    it('getChildren returns type=directory for directories', async () => {
        await vfs.fs.driver.createDirectory({ name: 'mydir', parentPath: null });
        const children = await vfs.fs.driver.getChildren('/');
        const dir = children.find(n => n.name === 'mydir');
        expect(dir?.type).toBe('directory');
    });
});

describe('Directory — delete', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('delete removes empty directory from disk', async () => {
        await vfs.fs.driver.createDirectory({ name: 'empty', parentPath: null });
        const node = await vfs.fs.driver.getNode('/empty');

        await vfs.fs.driver.delete([node!.path]);

        expect(await diskExists(vfs.moduleDir, 'empty')).toBe(false);
        expect(await vfs.fs.driver.exists('/empty')).toBe(false);
    });

    it('delete with recursive removes directory tree from disk', async () => {
        await vfs.fs.driver.createDirectory({ name: 'tree', parentPath: null });
        await vfs.fs.driver.createFile({ name: 'file.md', parentPath: '/tree', content: 'c' });
        await vfs.fs.driver.createDirectory({ name: 'sub', parentPath: '/tree' });

        const node = await vfs.fs.driver.getNode('/tree');
        await vfs.fs.driver.delete([node!.path], { recursive: true });

        expect(await diskExists(vfs.moduleDir, 'tree')).toBe(false);
    });
});

describe('Directory — rename / move', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('rename renames directory on disk', async () => {
        await vfs.fs.driver.createDirectory({ name: 'alpha', parentPath: null });
        await vfs.fs.driver.rename('/alpha', 'beta');

        expect(await diskExists(vfs.moduleDir, 'alpha')).toBe(false);
        expect(await diskExists(vfs.moduleDir, 'beta')).toBe(true);
        expect((await diskStat(vfs.moduleDir, 'beta'))?.isDirectory()).toBe(true);
    });

    it('rename preserves directory contents', async () => {
        await vfs.fs.driver.createDirectory({ name: 'src', parentPath: null });
        await vfs.fs.driver.createFile({ name: 'index.ts', parentPath: '/src', content: 'export {}' });

        await vfs.fs.driver.rename('/src', 'lib');

        expect(await diskExists(vfs.moduleDir, 'lib/index.ts')).toBe(true);
        expect(await diskRead(vfs.moduleDir, 'lib/index.ts')).toBe('export {}');
    });

    it('move directory into another directory', async () => {
        await vfs.fs.driver.createDirectory({ name: 'target', parentPath: null });
        await vfs.fs.driver.createDirectory({ name: 'movable', parentPath: null });

        const node = await vfs.fs.driver.getNode('/movable');
        await vfs.fs.driver.move([node!.path], '/target');

        expect(await diskExists(vfs.moduleDir, 'movable')).toBe(false);
        expect(await diskExists(vfs.moduleDir, 'target/movable')).toBe(true);
    });
});

// ── helper re-export for this file's assertions ────────────────────────────────

async function diskRead(rootDir: string, rel: string): Promise<string> {
    return fsp.readFile(join(rootDir, rel), 'utf-8');
}
