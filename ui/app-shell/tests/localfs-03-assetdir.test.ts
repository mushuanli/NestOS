/**
 * LocalFS integration — AssetDir operations
 *
 * Key behavior verified here:
 *   - _report.md/ is a REAL directory on disk (not DB-only like before our fix)
 *   - Asset files inside it are real files on disk
 *   - Rename owner → assetdir follows on disk
 *   - Delete owner → assetdir deleted from disk
 *
 * After running, inspect tests/test_vfsroot/assetdir/<NNN>/ to see:
 *   report.md
 *   _report.md/          ← real directory!
 *     thumb.png          ← real file
 *     diagram.svg        ← real file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import {
    setupLocalVFS, diskExists, diskList, diskStat, text, type LocalTestVFS,
} from './helpers-localfs';

const SUITE = 'assetdir';

// ── Setup helper ───────────────────────────────────────────────────────────────

async function withOwner(vfs: LocalTestVFS, ownerName = 'report.md') {
    await vfs.fs.driver.createFile({ name: ownerName, parentPath: null, content: '# Report' });
    return `/${ownerName}`;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AssetDir — putAsset creates real directory on disk', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('putAsset creates _report.md/ as a real directory', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'thumb.png', 'fake-png-bytes');

        // The assetdir must exist as a REAL directory on disk
        const stat = await diskStat(vfs.moduleDir, '_report.md');
        expect(stat).not.toBeNull();
        expect(stat!.isDirectory()).toBe(true);
    });

    it('asset file inside assetdir is a real file on disk', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'thumb.png', 'fake-png-bytes');

        expect(await diskExists(vfs.moduleDir, '_report.md/thumb.png')).toBe(true);
        const content = await fsp.readFile(join(vfs.moduleDir, '_report.md/thumb.png'), 'utf-8');
        expect(content).toBe('fake-png-bytes');
    });

    it('multiple assets all appear as real files', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'img1.png',   'data1');
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'img2.png',   'data2');
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'diagram.svg', '<svg/>');

        const diskFiles = await diskList(vfs.moduleDir, '_report.md');
        expect(diskFiles).toContain('img1.png');
        expect(diskFiles).toContain('img2.png');
        expect(diskFiles).toContain('diagram.svg');
    });

    it('putAsset with binary ArrayBuffer content', async () => {
        const ownerPath = await withOwner(vfs);
        const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG magic
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'photo.jpg', bytes.buffer as ArrayBuffer);

        const raw = await fsp.readFile(join(vfs.moduleDir, '_report.md/photo.jpg'));
        expect(new Uint8Array(raw)).toEqual(bytes);
    });
});

describe('AssetDir — read operations', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('getAsset returns asset content', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'data.txt', 'hello asset');

        const result = await vfs.fs.meta.assets!.getAsset(ownerPath, 'data.txt');
        expect(new TextDecoder().decode(result as ArrayBuffer)).toBe('hello asset');
    });

    it('getAsset returns null for missing asset', async () => {
        const ownerPath = await withOwner(vfs);
        expect(await vfs.fs.meta.assets!.getAsset(ownerPath, 'missing.png')).toBeNull();
    });

    it('hasAssetDir is false before first putAsset', async () => {
        const ownerPath = await withOwner(vfs);
        expect(await vfs.fs.meta.assets!.hasAssetDir(ownerPath)).toBe(false);
        // And no directory on disk either
        expect(await diskExists(vfs.moduleDir, '_report.md')).toBe(false);
    });

    it('hasAssetDir is true after putAsset', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'x.txt', 'x');
        expect(await vfs.fs.meta.assets!.hasAssetDir(ownerPath)).toBe(true);
    });

    it('listAssets returns all uploaded assets', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'a.png', 'a');
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'b.png', 'b');

        const list = await vfs.fs.meta.assets!.listAssets(ownerPath);
        const names = list.map(a => a.name ?? a);
        expect(names).toContain('a.png');
        expect(names).toContain('b.png');
    });

    it('ensureAssetDir returns stable id across calls', async () => {
        const ownerPath = await withOwner(vfs);
        const id1 = await vfs.fs.meta.assets!.ensureAssetDir(ownerPath);
        const id2 = await vfs.fs.meta.assets!.ensureAssetDir(ownerPath);
        expect(id1).toBe(id2);
    });

    it('putAsset is idempotent — overwrites existing asset', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'file.txt', 'v1');
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'file.txt', 'v2');

        const result = await vfs.fs.meta.assets!.getAsset(ownerPath, 'file.txt');
        expect(new TextDecoder().decode(result as ArrayBuffer)).toBe('v2');
        // Disk also shows v2
        const diskContent = await fsp.readFile(join(vfs.moduleDir, '_report.md/file.txt'), 'utf-8');
        expect(diskContent).toBe('v2');
    });
});

describe('AssetDir — deleteAsset', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('deleteAsset removes the real file from disk', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'del.png', 'data');

        expect(await diskExists(vfs.moduleDir, '_report.md/del.png')).toBe(true);
        await vfs.fs.meta.assets!.deleteAsset(ownerPath, 'del.png');
        expect(await diskExists(vfs.moduleDir, '_report.md/del.png')).toBe(false);
    });

    it('deleteAsset on last asset leaves assetdir empty (dir remains)', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'only.txt', 'x');
        await vfs.fs.meta.assets!.deleteAsset(ownerPath, 'only.txt');

        // assetdir directory itself still exists (empty)
        expect(await diskExists(vfs.moduleDir, '_report.md')).toBe(true);
        expect(await diskList(vfs.moduleDir, '_report.md')).toHaveLength(0);
    });
});

describe('AssetDir — owner rename cascades to assetdir on disk', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('renaming owner renames assetdir on disk', async () => {
        const ownerPath = await withOwner(vfs, 'original.md');
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'img.png', 'image');

        // Before rename: _original.md/ exists
        expect(await diskExists(vfs.moduleDir, '_original.md')).toBe(true);

        await vfs.fs.driver.rename('/original.md', 'renamed.md');

        // After rename: _original.md/ gone, _renamed.md/ appears with asset intact
        expect(await diskExists(vfs.moduleDir, '_original.md')).toBe(false);
        expect(await diskExists(vfs.moduleDir, '_renamed.md')).toBe(true);
        expect(await diskExists(vfs.moduleDir, '_renamed.md/img.png')).toBe(true);
    });
});

describe('AssetDir — owner delete cascades to assetdir on disk', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('deleting owner removes assetdir from disk', async () => {
        const ownerPath = await withOwner(vfs, 'deleteme.md');
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'asset.png', 'data');

        expect(await diskExists(vfs.moduleDir, '_deleteme.md')).toBe(true);

        const node = await vfs.fs.driver.getNode(ownerPath);
        await vfs.fs.driver.delete([node!.path], { recursive: true });

        expect(await diskExists(vfs.moduleDir, 'deleteme.md')).toBe(false);
        expect(await diskExists(vfs.moduleDir, '_deleteme.md')).toBe(false);
    });
});

describe('AssetDir — assetdir not visible in getChildren', () => {
    let vfs: LocalTestVFS;
    beforeEach(async () => { vfs = await setupLocalVFS(SUITE); });
    afterEach(async  () => { await vfs.dispose(); });

    it('_report.md/ is hidden from normal getChildren listing', async () => {
        const ownerPath = await withOwner(vfs);
        await vfs.fs.meta.assets!.putAsset(ownerPath, 'x.png', 'x');

        const children = await vfs.fs.driver.getChildren('/');
        const names = children.map(c => c.name);

        // Owner is visible
        expect(names).toContain('report.md');
        // But assetdir is hidden from normal listing
        expect(names).not.toContain('_report.md');
    });
});
