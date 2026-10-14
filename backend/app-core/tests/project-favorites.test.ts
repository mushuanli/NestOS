import { resolveBrowserTarget } from '../src/session/session-browser';
import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { ProjectFavorites, SeqProjectFavoriteStore } from '../src/projects/favorites';
it('persists project-scoped shortcuts and removes only the shortcut', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    try {
        const fs = await manager.openFileSystem('/'), favorites = new ProjectFavorites(new SeqProjectFavoriteStore(fs));
        await fs.driver.createFile({ name: 'note', parentPath: '/workspace', recursive: true, content: 'retained' });
        await favorites.toggle('p', { kind: 'file', path: '/workspace/note', nodeType: 'file' }, 'Note');
        await favorites.toggle('p', { kind: 'file', path: '/workspace', nodeType: 'directory' }, 'Directory');
        await favorites.toggle('p', { kind: 'session', sessionId: 'session-a' }, 'Conversation');
        expect(await new ProjectFavorites(new SeqProjectFavoriteStore(fs)).list('p')).toHaveLength(3);
        expect(await favorites.list('other')).toEqual([]);
        await favorites.toggle('p', { kind: 'file', path: '/workspace/note', nodeType: 'file' }, 'Note');
        expect(await favorites.list('p')).toHaveLength(2);
        expect(await fs.driver.readContent('/workspace/note', { encoding: 'utf-8' })).toBe('retained');
        await expect(favorites.toggle('p', { kind: 'file', path: '/workspace/../etc', nodeType: 'file' }, 'Invalid')).rejects.toThrow();
    } finally { await manager.dispose(); }
});
it('preserves concurrent changes from independent project views', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    try {
        const fs = await manager.openFileSystem('/');
        const a = new ProjectFavorites(new SeqProjectFavoriteStore(fs)), b = new ProjectFavorites(new SeqProjectFavoriteStore(fs));
        await Promise.all([a.toggle('p', { kind: 'session', sessionId: 'one' }, 'One'), b.toggle('p', { kind: 'session', sessionId: 'two' }, 'Two')]);
        expect(await a.list('p')).toHaveLength(2);
    } finally { await manager.dispose(); }
});

it('serializes delayed reads with writes so an old snapshot cannot clear favorite state', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    try {
        const fs = await manager.openFileSystem('/'), store = new SeqProjectFavoriteStore(fs);
        const favorites = new ProjectFavorites(store), target = { kind: 'session' as const, sessionId: 'new' };
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { started = resolve; });
        const original = store.read.bind(store);
        vi.spyOn(store, 'read').mockImplementationOnce(async id => {
            const snapshot = await original(id); started(); await gate; return snapshot;
        });
        const reading = favorites.list('p'); await ready;
        const writing = favorites.toggle('p', target, 'New');
        release(); await Promise.all([reading, writing]);
        expect(favorites.has('p', target)).toBe(true);
        expect(await favorites.list('p')).toHaveLength(1);
    } finally { await manager.dispose(); }
});

it('rejects invalid policy results before publishing storage changes', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    try {
        const fs = await manager.openFileSystem('/'), store = new SeqProjectFavoriteStore(fs);
        const favorites = new ProjectFavorites(store);
        await favorites.toggle('p', { kind: 'file', path: '/workspace/note', nodeType: 'file' }, 'Note');
        await expect(store.update('p', items => items.map(item => ({ ...item,
            target: { kind: 'file', path: '/etc/passwd', nodeType: 'file' } })))).rejects.toThrow();
        expect((await favorites.list('p'))[0].target).toMatchObject({ path: '/workspace/note' });
    } finally { await manager.dispose(); }
});

it('rejects favorite routes with malformed identities or trailing path segments', () => {
    expect(resolveBrowserTarget('/folder:Demo/@favorites/id')).toEqual({ kind: 'favorite', folder: '/Demo', favoriteId: 'id' });
    expect(() => resolveBrowserTarget('/folder:Demo/@favorites/id/extra')).toThrow();
    expect(() => resolveBrowserTarget('/folder:Demo/@favorites/bad%20id')).toThrow();
});

it('publishes the updated cache before notifying favorite subscribers', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    try {
        const fs = await manager.openFileSystem('/'), favorites = new ProjectFavorites(new SeqProjectFavoriteStore(fs));
        const target = { kind: 'session' as const, sessionId: 'one' };
        const observed: boolean[] = [];
        favorites.subscribe(() => observed.push(favorites.has('p', target)));
        await favorites.toggle('p', target, 'One');
        await favorites.toggle('p', target, 'One');
        expect(observed).toEqual([true, false]);
    } finally { await manager.dispose(); }
});

it('rejects missing favorite identities instead of accepting their string coercion', async () => {
    const { decodeFavorites } = await import('../src/projects/favorites/codec');
    expect(() => decodeFavorites(JSON.stringify([{ title: 'Missing ID', target: { kind: 'session', sessionId: 's' } }]))).toThrow();
    expect(() => decodeFavorites(JSON.stringify([{ id: 'f', title: 'Missing Session', target: { kind: 'session' } }]))).toThrow();
});

it('updates only the exact native favorite and preserves its stable shortcut identity', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), favorites = new ProjectFavorites(new SeqProjectFavoriteStore(fs));
        const target = {kind: 'remote-session' as const, connectionId: 'mcp', serverId: 'server', serverProjectId: 'native', profileId: 'codex', sessionId: 's'};
        await favorites.toggle('p', target, 'Before'); await favorites.toggle('p', {...target, serverId: 'other'}, 'Other');
        const id = (await favorites.list('p'))[0].id;
        await favorites.updateNativeSession('p', target, 'Renamed', true);
        expect(await favorites.list('p')).toEqual([expect.objectContaining({id, title: 'Renamed', target: {...target, archived: true}}), expect.objectContaining({title: 'Other'})]);
        await favorites.updateNativeSession('p', target, 'Renamed', false);
        expect((await favorites.list('p'))[0].target).toMatchObject({archived: false});
    } finally { await manager.dispose(); }
});
