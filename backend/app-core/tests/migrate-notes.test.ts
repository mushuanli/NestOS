import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {migrateNotes} from '../src/runtime/migrate-notes';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    return manager.openFileSystem('/');
}
it('merges directories without losing content or metadata and is restartable', async () => {
    const fs = await fixture();
    await fs.driver.createFile({parentPath: '/minds/essay', name: 'require.md', content: 'requirements', metadata: {title: 'Original'}, recursive: true});
    await fs.driver.createFile({parentPath: '/notes/essay', name: 'existing.md', content: 'keep', recursive: true});
    await migrateNotes(fs); await migrateNotes(fs);
    expect(await fs.driver.exists('/minds')).toBe(false);
    expect(await fs.driver.readContent('/notes/essay/require.md', {encoding: 'utf-8'})).toBe('requirements');
    expect((await fs.driver.getNode('/notes/essay/require.md'))?.metadata.title).toBe('Original');
    expect(await fs.driver.readContent('/notes/essay/existing.md', {encoding: 'utf-8'})).toBe('keep');
});
it('rejects conflicts before moving any source', async () => {
    const fs = await fixture();
    for (const [parentPath, content] of [['/minds', 'old'], ['/notes', 'new']])
        await fs.driver.createFile({parentPath, name: 'same.md', content, recursive: true});
    await fs.driver.createFile({parentPath: '/minds', name: 'other.md', content: 'untouched'});
    await expect(migrateNotes(fs)).rejects.toMatchObject({code: 'EEXIST'});
    expect(await fs.driver.exists('/minds/other.md')).toBe(true);
    expect(await fs.driver.readContent('/notes/same.md', {encoding: 'utf-8'})).toBe('new');
});
