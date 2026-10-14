import { it, expect } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { ProjectDraftStore } from '../src/projects/drafts/store';

it('persists drafts independently per project, keeps send identity and clears only explicitly', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    try {
        const a = new ProjectDraftStore(fs, 'a'); await a.load();
        await a.saveData('text and settings');
        const intent = await a.begin('date-time');
        expect(await new ProjectDraftStore(fs, 'a').load()).toMatchObject({ data: 'text and settings', sessionId: intent.sessionId, state: 'submitting', title: 'date-time' });
        expect(await new ProjectDraftStore(fs, 'b').load()).toMatchObject({ data: '', state: 'draft' });
        expect(await fs.driver.exists('/var/lib/sessions')).toBe(false);
        await a.reset();
        expect(await new ProjectDraftStore(fs, 'a').load()).toMatchObject({ data: '', state: 'draft' });
    } finally { await manager.dispose(); }
});
it('rejects stale writers instead of overwriting or clearing another window draft', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    try {
        const first = new ProjectDraftStore(fs, 'a'); await first.load(); await first.saveData('original');
        const stale = new ProjectDraftStore(fs, 'a'); await stale.load();
        await first.saveData('new');
        await expect(stale.reset()).rejects.toMatchObject({ code: 'ECONFLICT' });
        expect((await new ProjectDraftStore(fs, 'a').load()).data).toBe('new');
    } finally { await manager.dispose(); }
});

it('migrates legacy data once and rejects corrupt state instead of inventing a new draft', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    try {
        const store = new ProjectDraftStore(fs, 'a'); await store.load();
        const path = '/var/lib/projects/a/draft.seq';
        await fs.meta.seq!.setEntry(path, 'draft', JSON.stringify({ data: 'legacy', sessionId: 'reserved', title: 'old' }));
        const migrated = await store.load();
        expect(migrated).toMatchObject({ version: 1, data: 'legacy', sessionId: 'reserved', state: 'submitting' });
        expect((await new ProjectDraftStore(fs, 'a').load()).id).toBe(migrated.id);
        await fs.meta.seq!.setEntry(path, 'draft', JSON.stringify({ version: 1, id: migrated.id, state: 'promoted', data: 'bad' }));
        await expect(new ProjectDraftStore(fs, 'a').load()).rejects.toMatchObject({ code: 'EINVAL' });
    } finally { await manager.dispose(); }
});

it('reading a valid record does not rewrite JSON or invalidate an existing writer cursor', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    try {
        const writer = new ProjectDraftStore(fs, 'a'); await writer.load(); await writer.begin('Title');
        const path = '/var/lib/projects/a/draft.seq', before = await fs.meta.seq!.getEntry(path, 'draft');
        await new ProjectDraftStore(fs, 'a').load();
        expect(await fs.meta.seq!.getEntry(path, 'draft')).toBe(before);
        await expect(writer.saveData('still owns cursor')).resolves.toBeUndefined();
    } finally { await manager.dispose(); }
});

it('stores binary bytes separately, isolates projects and retires attachments on reset/promotion', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    try {
        const store = new ProjectDraftStore(fs, 'a'), record = await store.load();
        const bytes = new Uint8Array([0, 255, 128, 13, 10]);
        const id = await store.putAttachment(bytes.buffer);
        await store.saveData(JSON.stringify({ attachment: id }));
        const reopened = new ProjectDraftStore(fs, 'a'); await reopened.load();
        expect(new Uint8Array(await reopened.readAttachment(id))).toEqual(bytes);
        const other = new ProjectDraftStore(fs, 'b'); await other.load();
        await expect(other.readAttachment(id)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(() => other.readAttachment('../draft.seq')).toThrow();
        await store.reset();
        expect(await fs.driver.exists(`/var/lib/projects/a/draft-attachments/${record.id}`)).toBe(false);
        await expect(reopened.putAttachment(bytes.buffer)).rejects.toMatchObject({ code: 'ECONFLICT' });
        const current = await store.load();
        await store.putAttachment(bytes.buffer); await store.begin('title'); await store.promote();
        expect(await fs.driver.exists(`/var/lib/projects/a/draft-attachments/${current.id}`)).toBe(false);
    } finally { await manager.dispose(); }
});

it('recovers cleanup interrupted after draft replacement without deleting current bytes', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/');
    try {
        const store = new ProjectDraftStore(fs, 'a'), old = await store.load();
        await store.putAttachment(new Uint8Array([1]).buffer);
        await fs.meta.seq!.setEntry('/var/lib/projects/a/draft.seq', 'draft', JSON.stringify({
            version: 1, id: 'successor', state: 'draft', data: '',
        }));
        await fs.driver.createFile({ parentPath: '/var/lib/projects/a/draft-attachments/successor', name: 'current',
            content: new Uint8Array([2]).buffer, recursive: true });
        await new ProjectDraftStore(fs, 'a').load();
        expect(await fs.driver.exists(`/var/lib/projects/a/draft-attachments/${old.id}`)).toBe(false);
        expect(new Uint8Array(await fs.driver.readContent('/var/lib/projects/a/draft-attachments/successor/current', { encoding: 'binary' }))).toEqual(new Uint8Array([2]));
    } finally { await manager.dispose(); }
});
