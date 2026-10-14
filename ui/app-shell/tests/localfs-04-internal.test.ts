/** LocalFS preserves literal directory names; UI listing flags do not relocate data. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
    setupLocalVFS, diskExists, diskList, type LocalTestVFS,
} from './helpers-localfs';

const SUITE = 'internal';

// ── Storage location ───────────────────────────────────────────────────────────

describe('Literal paths (__config/) — storage location', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('__config/ directory is created in the source directory', async () => {
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        expect(await diskExists(vfs.moduleDir, '__config')).toBe(true);
    });

    it('file inside __config/ stays in the source directory', async () => {
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        await vfs.fs.driver.createFile({
            name: 'history.yaml', parentPath: '/__config', content: 'entries: []',
        });
        expect(await diskExists(vfs.moduleDir, '__config/history.yaml')).toBe(true);
    });

    it('file content is never redirected to metadata storage', async () => {
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        await vfs.fs.driver.createFile({
            name: 'history.yaml', parentPath: '/__config', content: 'entries: []',
        });
        const internalBase = join(vfs.sidecarDir, 'vfs-internal');
        expect(await diskExists(internalBase, 'module/test/__config/history.yaml')).toBe(false);
    });
});

// ── VFS access ─────────────────────────────────────────────────────────────────

describe('Internal paths (__config/) — VFS access', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('can readContent from __config/ path', async () => {
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        await vfs.fs.driver.createFile({
            name: 'settings.json', parentPath: '/__config', content: '{"key":"value"}',
        });
        const result = await vfs.fs.driver.readContent('/__config/settings.json', { encoding: 'utf-8' });
        expect(result).toBe('{"key":"value"}');
    });

    it('can writeContent to __config/ path', async () => {
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        await vfs.fs.driver.createFile({ name: 'cache.json', parentPath: '/__config', content: 'v1' });
        await vfs.fs.driver.writeContent('/__config/cache.json', 'v2');
        const result = await vfs.fs.driver.readContent('/__config/cache.json', { encoding: 'utf-8' });
        expect(result).toBe('v2');
    });

    it('can getNode for __config/ directory', async () => {
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        const node = await vfs.fs.driver.getNode('/__config');
        expect(node).not.toBeNull();
        expect(node!.type).toBe('directory');
    });
});

// ── Visibility ────────────────────────────────────────────────────────────────

describe('Internal paths (__config/) — visibility', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('__config/ is hidden from normal getChildren', async () => {
        await vfs.fs.driver.createFile({ name: 'visible.md', parentPath: null, content: 'hi' });
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        await vfs.fs.driver.createFile({ name: 'data.json', parentPath: '/__config', content: '{}' });

        const names = (await vfs.fs.driver.getChildren('/')).map(c => c.name);
        expect(names).toContain('visible.md');
        expect(names).not.toContain('__config');
    });

    it('all literal user directories remain on disk', async () => {
        await vfs.fs.driver.createFile({ name: 'user.md', parentPath: null, content: 'u' });
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });
        await vfs.fs.driver.createFile({ name: 'cfg.json', parentPath: '/__config', content: '{}' });

        const diskEntries = await diskList(vfs.moduleDir);
        expect(diskEntries).toContain('user.md');
        expect(diskEntries).toContain('__config');
    });
});

// ── Contrast: single _ vs double __ ───────────────────────────────────────────

describe('Asset directories and double-underscore directories on disk', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('both asset directories and double-underscore directories are real', async () => {
        await vfs.fs.driver.createFile({ name: 'doc.md', parentPath: null, content: '# Doc' });
        await vfs.fs.meta.assets!.putAsset('/doc.md', 'img.png', 'image');
        await vfs.fs.driver.createDirectory({ name: '__config', parentPath: null });

        const diskEntries = await diskList(vfs.moduleDir);
        expect(diskEntries).toContain('doc.md');
        expect(diskEntries).toContain('_doc.md');      // assetdir: REAL directory
        expect(diskEntries).toContain('__config'); // literal user directory
    });
});
