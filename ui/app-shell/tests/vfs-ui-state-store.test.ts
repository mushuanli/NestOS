import { expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { VfsUIPersistence } from '../src/persistence/vfs-ui-state-store';
import { VfsJsonStore } from '../src/persistence/vfs-json-store';

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
        const store = new VfsUIPersistence(new VfsJsonStore(etc));
        expect(await store.load(SCOPE)).toBeUndefined();
        const port = await store.port(SCOPE);
        expect(port.load?.()).toBeUndefined();

        port.save(snapshot);
        await store.flush();
        expect(await etc.driver.exists(PATH)).toBe(true);
        expect(JSON.parse(text(await etc.driver.readContent(PATH)))).toMatchObject({ version: 1, activeId: '/abc' });

        // A later browser restores from the same file, not from webview storage.
        const port2 = await new VfsUIPersistence(new VfsJsonStore(etc)).port(SCOPE);
        expect(port2.load?.()).toMatchObject({ activeId: '/abc', expandedFolderIds: ['/abc'] });
    } finally { await manager.dispose(); }
});

it('drops corrupt or outdated records instead of half-applying them', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const etc = await manager.openFileSystem('/etc');
    try {
        await etc.driver.createFile({ name: 'session-browser_v1_admin.ui.json', parentPath: '/ui', content: '{ not json', recursive: true });
        expect(await new VfsUIPersistence(new VfsJsonStore(etc)).load(SCOPE)).toBeUndefined();
        await etc.driver.writeContent(PATH, JSON.stringify({ version: 99, activeId: '/abc' }));
        expect(await new VfsUIPersistence(new VfsJsonStore(etc)).load(SCOPE)).toBeUndefined();
        await etc.driver.writeContent(PATH, JSON.stringify({ version: 1, activeId: 7 }));
        expect(await new VfsUIPersistence(new VfsJsonStore(etc)).load(SCOPE)).toBeUndefined();
    } finally { await manager.dispose(); }
});

it('serializes writes per store so a burst of changes cannot interleave', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const etc = await manager.openFileSystem('/etc');
    try {
        const store = new VfsUIPersistence(new VfsJsonStore(etc));
        const port = await store.port(SCOPE);
        for (const activeId of ['/one', '/two', '/three']) port.save({ ...snapshot, activeId });
        await store.flush();
        expect(await new VfsUIPersistence(new VfsJsonStore(etc)).load(SCOPE)).toMatchObject({ activeId: '/three' });
    } finally { await manager.dispose(); }
});
