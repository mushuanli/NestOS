import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, createFileSystemSource, MemoryBackend } from '@itookit/vfs-core';
import { SettingsService } from '@itookit/app-core';
import { LabelStore } from '@itookit/app-core';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    cleanup.push(() => manager.dispose());
    return { backend, manager, etc: await manager.openFileSystem('/etc'), files: await manager.openFileSystem('/home/admin/files') };
}

describe('NestOS label catalog', () => {
    it('reads legacy definitions without writing, then migrates once without losing unused definitions', async () => {
        const { etc } = await setup();
        await etc.driver.createFile({ name: 'tags.json', parentPath: '/', content: JSON.stringify([
            { id: 'unused', name: 'Unused', color: '#123456', count: 99 },
        ]) });
        const labels = new LabelStore(etc);
        expect((await labels.list())[0].name).toBe('Unused');
        expect(await etc.driver.exists('/label.seq')).toBe(false);
        await labels.save({ id: 'new', name: 'New', color: '#ffffff' });
        expect((await labels.list()).map(tag => tag.name).sort()).toEqual(['New', 'Unused']);
        expect((await labels.list()).every(tag => tag.count === undefined)).toBe(true);
        await labels.delete('unused');
        await labels.save({ id: 'third', name: 'Third', color: '#000000' });
        expect((await new LabelStore(etc).list()).map(tag => tag.id).sort()).toEqual(['new', 'third']);
    });

    it('does not scan on startup or file changes; settings uses only internal indexes', async () => {
        const { backend, manager, files } = await setup();
        await files.driver.createFile({ name: 'tagged.md', parentPath: '/', content: 'file' });
        await files.meta.tags.setTags('/tagged.md', ['work']);
        const host = await createFileSystemSource({ backend: new MemoryBackend(), viewId: 'host', tags: false });
        cleanup.push(() => host.dispose());
        const externalQuery = vi.fn(() => { throw new Error('External tag query forbidden'); });
        const externalFiles = Object.create(host.fs);
        externalFiles.meta = { ...host.fs.meta, tags: { getAllTags: externalQuery } };
        const list = vi.spyOn(backend, 'list').mockRejectedValue(new Error('File traversal forbidden'));
        const query = vi.spyOn(backend, 'listTagEntries');
        const settings = new SettingsService(manager, undefined, [
            { name: 'files', fs: files }, { name: 'home', fs: externalFiles },
        ]);
        cleanup.push(() => settings.dispose());
        await settings.init();
        expect(query).not.toHaveBeenCalled();
        vi.useFakeTimers();
        await files.driver.createFile({ name: 'another.md', parentPath: '/', content: '' });
        await vi.advanceTimersByTimeAsync(2100);
        expect(query).not.toHaveBeenCalled();
        await settings.syncTags();
        expect(settings.getTags()).toContainEqual(expect.objectContaining({ name: 'work', count: 1 }));
        expect(externalQuery).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        await settings.saveTag({ id: 'unused', name: 'Unused', color: '#ffffff' });
        await settings.syncTags();
        expect(settings.getTags()).toContainEqual(expect.objectContaining({ name: 'Unused', count: 0 }));
    });
});
