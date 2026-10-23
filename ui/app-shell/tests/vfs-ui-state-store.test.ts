import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { VfsUIPersistence } from '../src/persistence/vfs-ui-state-store';
import { VfsJsonStore } from '../src/persistence/vfs-json-store';
import { bindApplicationBackend } from '@itookit/app-core/host';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';

const SCOPE = 'session-browser:v1:admin';
const PATH = '/ui/session-browser_v1_admin.ui.json';
const snapshot = { version: 1 as const, activeId: '/abc', expandedFolderIds: ['/abc'], selectedItemIds: [],
    uiSettings: { sortBy: 'title' as const, density: 'comfortable' as const, showSummary: true, showTags: true, showBadges: true },
    isSidebarCollapsed: false };
const text = (raw: unknown): string => typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);

it('persists a scope under etc:/ui and restores it through a synchronous port', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const etc = await manager.openFileSystem('/etc');
    try {
        const store = new VfsUIPersistence(new VfsJsonStore(bindApplicationBackend({ vfs: manager } as LocalApplicationServices)));
        expect(await store.load(SCOPE)).toBeUndefined();
        const port = await store.port(SCOPE);
        expect(port.load?.()).toBeUndefined();

        port.save(snapshot);
        await store.flush();
        expect(await etc.driver.exists(PATH)).toBe(true);
        expect(JSON.parse(text(await etc.driver.readContent(PATH)))).toMatchObject({ version: 1, activeId: '/abc' });

        // A later browser restores from the same file, not from webview storage.
        const port2 = await new VfsUIPersistence(new VfsJsonStore(bindApplicationBackend({ vfs: manager } as LocalApplicationServices))).port(SCOPE);
        expect(port2.load?.()).toMatchObject({ activeId: '/abc', expandedFolderIds: ['/abc'] });
    } finally { await manager.dispose(); }
});

it('drops corrupt or outdated records instead of half-applying them', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const etc = await manager.openFileSystem('/etc');
    try {
        await etc.driver.createFile({ name: 'session-browser_v1_admin.ui.json', parentPath: '/ui', content: '{ not json', recursive: true });
        expect(await new VfsUIPersistence(new VfsJsonStore(bindApplicationBackend({ vfs: manager } as LocalApplicationServices))).load(SCOPE)).toBeUndefined();
        await etc.driver.writeContent(PATH, JSON.stringify({ version: 99, activeId: '/abc' }));
        expect(await new VfsUIPersistence(new VfsJsonStore(bindApplicationBackend({ vfs: manager } as LocalApplicationServices))).load(SCOPE)).toBeUndefined();
        await etc.driver.writeContent(PATH, JSON.stringify({ version: 1, activeId: 7 }));
        expect(await new VfsUIPersistence(new VfsJsonStore(bindApplicationBackend({ vfs: manager } as LocalApplicationServices))).load(SCOPE)).toBeUndefined();
    } finally { await manager.dispose(); }
});

it('serializes writes per store so a burst of changes cannot interleave', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const etc = await manager.openFileSystem('/etc');
    try {
        const store = new VfsUIPersistence(new VfsJsonStore(bindApplicationBackend({ vfs: manager } as LocalApplicationServices)));
        const port = await store.port(SCOPE);
        for (const activeId of ['/one', '/two', '/three']) port.save({ ...snapshot, activeId });
        await store.flush();
        expect(await new VfsUIPersistence(new VfsJsonStore(bindApplicationBackend({ vfs: manager } as LocalApplicationServices))).load(SCOPE)).toMatchObject({ activeId: '/three' });
    } finally { await manager.dispose(); }
});

it('batches reads and writes, skips unchanged state and retains a failed batch for retry', async () => {
    const readUiDocuments = vi.fn(async () => ({ a: { selected: 'old' } }));
    const writeUiDocuments = vi.fn(async (_documents: Record<string, unknown>) => {});
    const store = new VfsJsonStore({ readUiDocuments, writeUiDocuments });
    await Promise.all([store.read('a'), store.read('b')]);
    expect(readUiDocuments).toHaveBeenCalledOnce(); expect(readUiDocuments).toHaveBeenCalledWith(['a', 'b']);
    store.write('a', { selected: 'old' }); await store.flush(); expect(writeUiDocuments).not.toHaveBeenCalled();
    store.write('a', { selected: 'one' }); store.write('a', { selected: 'two' }); store.write('b', { expanded: true });
    await store.flush(); expect(writeUiDocuments).toHaveBeenCalledOnce();
    expect(writeUiDocuments).toHaveBeenLastCalledWith({ a: { selected: 'two' }, b: { expanded: true } });
    writeUiDocuments.mockRejectedValueOnce(new Error('offline'));
    store.write('a', { selected: 'three' }); await expect(store.flush()).rejects.toThrow('offline');
    await store.flush(); expect(writeUiDocuments).toHaveBeenLastCalledWith({ a: { selected: 'three' } });
});

it('consumes navigation preferences locally without replacing a more recent local write', async () => {
    const readUiDocuments = vi.fn(async () => ({})), writeUiDocuments = vi.fn(async () => {});
    const store = new VfsJsonStore({ readUiDocuments, writeUiDocuments });
    store.seed({ missing: undefined, data: { selected: 'old' } });
    expect(await store.read('missing')).toBeUndefined(); expect(await store.read('data')).toEqual({ selected: 'old' });
    store.write('data', { selected: 'new' }); store.seed({ data: { selected: 'old' } });
    expect(await store.read('data')).toEqual({ selected: 'new' });
    expect(readUiDocuments).not.toHaveBeenCalled(); await store.flush();
});

it('batches staged startup reads once and does not reuse a preload after a newer write', async () => {
    const readUiDocuments = vi.fn(async () => ({theme: {mode: 'dark'}, layout: {width: 300}}));
    const store = new VfsJsonStore({readUiDocuments, writeUiDocuments: async () => {}});
    store.prefetch(['theme', 'layout', 'missing']);
    expect(await store.read('theme')).toEqual({mode: 'dark'});
    expect(await store.read('layout')).toEqual({width: 300});
    expect(await store.read('missing')).toBeUndefined();
    expect(readUiDocuments).toHaveBeenCalledOnce();
    store.prefetch(['layout']); await Promise.resolve();
    store.write('layout', {width: 500}); await store.flush();
    readUiDocuments.mockResolvedValueOnce({theme: {mode: 'dark'}, layout: {width: 500}});
    expect(await store.read('layout')).toEqual({width: 500});
});

it('never retries failed presentation writes after suspending an expired view', async () => {
    const writeUiDocuments = vi.fn(async () => {throw new Error('expired');});
    const store = new VfsJsonStore({readUiDocuments: async () => ({}), writeUiDocuments});
    store.write('layout', {selected: 'draft'}); await expect(store.flush()).rejects.toThrow('expired');
    store.suspend(); store.write('layout', {selected: 'closing'}); await store.flush();
    expect(writeUiDocuments).toHaveBeenCalledOnce();
});
