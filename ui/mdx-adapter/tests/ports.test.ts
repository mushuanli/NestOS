// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import type { EditorOptions } from '@itookit/ui-common';
import { adaptEditorOptions } from '../src/factory';
import { createAssetProvider } from '../src/assets';

it('rejects mismatched namespace and session contexts before touching storage', () => {
    const fs = { viewId: 'granted', driver: new Proxy({}, { get() { throw new Error('storage touched'); } }) };
    for (const target of [{ kind: 'file', path: '/note.md', namespaceId: 'other' },
        { kind: 'file', path: '/note.md', sessionId: 'other' }]) {
        expect(() => adaptEditorOptions({ target, files: { fs, sessionId: 'granted' } } as EditorOptions)).toThrow(/does not match/);
    }
});

it('uses the moved document for save, assets and metadata stores', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({ parentPath: '/', name: 'old.md', content: 'old' });
    const save = vi.fn(async () => {});
    const config = adaptEditorOptions({ target: { kind: 'file', path: '/old.md' }, files: { fs },
        hostContext: { saveContent: save, toggleSidebar() {}, navigate: async () => {} } });
    try {
        await fs.driver.rename('/old.md', 'new.md'); config.onDocumentPathChange!('/new.md');
        await config.onSave!('new'); expect(save).toHaveBeenCalledWith('/new.md', 'new');
        const binary = new Uint8Array([1, 2, 3]).buffer;
        await config.assets!.upload!('image.png', binary);
        expect(new Uint8Array((await config.assets!.read('image.png'))!)).toEqual(new Uint8Array(binary));
        const store = config.storeFactory!('test', 'id', '/new.md');
        await store.set('fold', true);
        await vi.waitFor(async () => expect((await fs.driver.getNode('/new.md'))!.metadata?._mdx_plugin_test).toEqual({ fold: true }));
        store.destroy?.(); expect(await fs.driver.exists('/old.md')).toBe(false);
    } finally { await manager.dispose(); }
});

it('rejects attachment traversal without accessing the granted view', async () => {
    const read = vi.fn(); const createFile = vi.fn();
    const provider = createAssetProvider(undefined, () => undefined, { driver: { readContent: read, createFile } } as any)!;
    for (const name of ['../secret', '/secret', 'nested/../secret', 'a\\b']) {
        expect(() => provider.read(name)).toThrow('Invalid attachment name');
        await expect(provider.upload!(name, new ArrayBuffer(0))).rejects.toThrow('Invalid attachment name');
    }
    expect(read).not.toHaveBeenCalled(); expect(createFile).not.toHaveBeenCalled();
});
