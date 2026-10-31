import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { CLOZE_SRS_PATH, clozeDocumentPrefix } from '@itookit/app-contracts';
import { trackNotesCloze, updateClozeRecords } from '../src/vfs/cloze-lifecycle';

const path = CLOZE_SRS_PATH;
const key = (document: string) => clozeDocumentPrefix(document) + 'card:auto-x';
async function setup(active = true) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const home = await manager.openFileSystem('/home/admin/notes');
    await home.driver.createFile({ parentPath: '/dir', name: 'a.md', content: 'x', recursive: true });
    await home.driver.createFile({ parentPath: '/directory', name: 'b.md', content: 'x', recursive: true });
    if (active) {
        await home.driver.createFile({ parentPath: '/.nestos', name: 'cloze-srs.seq', type: 'seqfile', recursive: true });
        await home.meta.seq!.setEntry(path, key('/dir/a.md'), 'progress');
        await home.meta.seq!.setEntry(path, key('/directory/b.md'), 'other');
    }
    return { manager, home };
}

it('tracks real rename, directory move and deletion while no editor exists', async () => {
    const { manager, home } = await setup(); const stop = trackNotesCloze(home);
    try {
        await home.driver.rename('/dir/a.md', 'renamed.md');
        await vi.waitFor(async () => expect(await home.meta.seq!.getEntry(path, key('/dir/renamed.md'))).toBe('progress'));
        expect(await home.meta.seq!.getEntry(path, key('/dir/a.md'))).toBeNull();
        await home.driver.createFile({ parentPath: '/', name: 'target', type: 'directory' });
        await home.driver.move(['/dir'], '/target');
        await vi.waitFor(async () => expect(await home.meta.seq!.getEntry(path, key('/target/dir/renamed.md'))).toBe('progress'));
        await home.driver.delete(['/target'], { recursive: true });
        await vi.waitFor(async () => expect(await home.meta.seq!.getEntry(path, key('/target/dir/renamed.md'))).toBeNull());
        expect(await home.meta.seq!.getEntry(path, key('/directory/b.md'))).toBe('other');
    } finally { await stop(); await manager.dispose(); }
});

it('does not allocate storage for inactive files during file operations', async () => {
    const { manager, home } = await setup(false); const stop = trackNotesCloze(home);
    try {
        await home.driver.rename('/dir', 'renamed');
        await home.driver.delete(['/renamed'], { recursive: true });
        await stop();
        expect(await home.driver.exists(path)).toBe(false);
    } finally { await manager.dispose(); }
});

it('rolls back a key migration when the destination already has state', async () => {
    const { manager, home } = await setup();
    await home.meta.seq!.setEntry(path, key('/new/a.md'), 'newer');
    try {
        await expect(updateClozeRecords(home, [{ oldPath: '/dir', newPath: '/new' }], []))
            .rejects.toThrow('CLOZE_RECORD_TARGET_EXISTS');
        expect(await home.meta.seq!.getEntry(path, key('/dir/a.md'))).toBe('progress');
        expect(await home.meta.seq!.getEntry(path, key('/new/a.md'))).toBe('newer');
    } finally { await manager.dispose(); }
});

it('encodes paths containing delimiters without mixing document scopes', () => {
    expect(clozeDocumentPrefix('/dir/a#%.md')).toBe('%2Fdir%2Fa%23%25.md#');
});

it('preserves embedded review history across a directory move and removes it on deletion', async () => {
    const {manager, home} = await setup(), stop = trackNotesCloze(home);
    const payload = JSON.stringify({v:1, reviewCount:1, history:{v:1, events:[{id:'review-1', at:1, grade:3, total:2, before:0, learned:1, signature:'set-1'}]}});
    try {
        await home.meta.seq!.setEntry(path, key('/dir/a.md'), payload);
        await home.driver.rename('/dir', 'renamed');
        await vi.waitFor(async () => expect(await home.meta.seq!.getEntry(path, key('/renamed/a.md'))).toBe(payload));
        expect(await home.meta.seq!.getEntry(path, key('/dir/a.md'))).toBeNull();
        await home.driver.delete(['/renamed'], {recursive:true});
        await vi.waitFor(async () => expect(await home.meta.seq!.getEntry(path, key('/renamed/a.md'))).toBeNull());
    } finally {await stop(); await manager.dispose();}
});
