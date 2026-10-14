import { afterEach, expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { FileSearchService } from './FileSearchService';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it('filters suggestions before the result limit and includes ignored files on request', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ name: '.gitignore', parentPath: '/', content: 'hidden*.txt' });
    for (let i = 0; i < 25; i++) {
        await fs.driver.createFile({ name: `hidden${i}.txt`, parentPath: '/', content: '' });
    }
    await fs.driver.createFile({ name: 'visible.txt', parentPath: '/', content: '' });
    const service = new FileSearchService(fs);
    expect(await service.search('.txt')).toEqual([expect.objectContaining({ path: './visible.txt' })]);
    expect(await service.search('hidden')).toEqual([]);
    expect(await service.search('hidden', { includeIgnored: true })).toHaveLength(20);
    await fs.driver.writeContent('/.gitignore', '');
    expect(await service.search('hidden')).toHaveLength(20);
});
