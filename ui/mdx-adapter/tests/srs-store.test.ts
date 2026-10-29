// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { CLOZE_SRS_PATH, clozeDocumentPrefix } from '@itookit/app-contracts';
import { SeqFileStore, createAdapterStore } from '../src/srs-store';
import { EngineMetadataStore } from '../src/metadata-store';

async function openFileSystem() {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    for (const name of ['a.md', 'b.md']) await fs.driver.createFile({ parentPath: '/', name, content: '--alpha--' });
    return { manager, fs };
}

it('never creates a seqfile on read, enumeration, reset or path changes', async () => {
    const { manager, fs } = await openFileSystem();
    const store = new SeqFileStore(fs, '/a.md');
    try {
        expect(await store.get('card:x')).toBeUndefined();
        expect(await store.entries('card:')).toEqual([]);
        await store.remove('card:x'); await store.remove('_mdx_srs');
        store.updateDocumentPath('/b.md');
        expect(await store.entries()).toEqual([]);
        expect(await fs.driver.exists(CLOZE_SRS_PATH)).toBe(false);
    } finally { store.destroy(); await manager.dispose(); }
});

it('isolates document scopes and writes only changed cards in one shared seqfile', async () => {
    const { manager, fs } = await openFileSystem();
    const a = new SeqFileStore(fs, '/a.md'), b = new SeqFileStore(fs, '/b.md');
    try {
        await a.set('card:x', { interval: 4 }); await b.set('card:x', { interval: 9 });
        expect(await a.entries('card:')).toEqual([['card:x', { interval: 4 }]]);
        expect(await b.get('card:x')).toEqual({ interval: 9 });
        expect(await fs.meta.seq!.getEntry(CLOZE_SRS_PATH, clozeDocumentPrefix('/a.md') + 'card:x')).toBeTruthy();
        await a.remove('card:x');
        expect(await a.entries()).toEqual([]);
        expect(await b.get('card:x')).toEqual({ interval: 9 });
    } finally { a.destroy(); b.destroy(); await manager.dispose(); }
});

it('reads legacy metadata without eager migration and durably removes it on reset', async () => {
    const { manager, fs } = await openFileSystem();
    const legacy = new EngineMetadataStore(fs, '/a.md', 'cloze:memory');
    await legacy.set('_mdx_srs', { 'auto-0': { reviewCount: 2 } }); await legacy.flush();
    const store = new SeqFileStore(fs, '/a.md');
    try {
        expect(await store.get('_mdx_srs')).toEqual({ 'auto-0': { reviewCount: 2 } });
        expect(await store.entries()).toEqual([]);
        expect(await fs.driver.exists(CLOZE_SRS_PATH)).toBe(false);
        await store.remove('_mdx_srs'); store.destroy();
        expect(await legacy.get('_mdx_srs')).toBeUndefined();
    } finally { store.destroy(); legacy.destroy(); await manager.dispose(); }
});

it('includes pending entries even when the persisted plugin object does not exist', async () => {
    const { manager, fs } = await openFileSystem();
    const store = new EngineMetadataStore(fs, '/a.md', 'cloze:memory');
    try {
        await store.set('card:x', 1);
        expect(await store.entries('card:')).toEqual([['card:x', 1]]);
        await store.remove('card:x');
        expect(await store.entries()).toEqual([]);
    } finally { store.destroy(); await manager.dispose(); }
});

it('rejects late writes for deleted documents without creating records', async () => {
    const { manager, fs } = await openFileSystem();
    const store = new SeqFileStore(fs, '/a.md');
    try {
        await fs.driver.delete(['/a.md']);
        await expect(store.set('card:x', 1)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.driver.exists(CLOZE_SRS_PATH)).toBe(false);
    } finally { store.destroy(); await manager.dispose(); }
});

it('reports create failures and allows a later retry', async () => {
    const { manager, fs } = await openFileSystem();
    const store = new SeqFileStore(fs, '/a.md');
    const create = vi.spyOn(fs.driver, 'createFile');
    create.mockRejectedValueOnce(Object.assign(new Error('private details'), { code: 'EACCES' }));
    try {
        await expect(store.set('card:x', 1)).rejects.toMatchObject({ code: 'EACCES' });
        await store.set('card:x', 2);
        expect(await store.get('card:x')).toBe(2);
    } finally { create.mockRestore(); store.destroy(); await manager.dispose(); }
});

it('keeps metadata fallback for backends without seqfiles and for other plugins', () => {
    const fs = { capabilities: { seqFiles: false } } as never;
    expect(createAdapterStore(fs, '/a.md', 'cloze:memory')).toBeInstanceOf(EngineMetadataStore);
    const withSeq = { capabilities: { seqFiles: true } } as never;
    expect(createAdapterStore(withSeq, '/a.md', 'cloze:memory')).toBeInstanceOf(SeqFileStore);
    expect(createAdapterStore(withSeq, '/a.md', 'other')).toBeInstanceOf(EngineMetadataStore);
});
