import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager, type IFileSystem } from '@itookit/vfs-core';
import { SessionRepository } from '../src/persistence/session-repository';

let manager: IVFSManager, fs: IFileSystem, repo: SessionRepository;
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    fs = await manager.openFileSystem('/'); repo = new SessionRepository(fs); await repo.init();
    await repo.createFolder('/P', { id: 'p', directory: '/projects/p' });
    await repo.createFolder('/P/a'); await repo.createFolder('/P/b');
    await repo.createFolder('/Q', { id: 'q', directory: '/projects/q' });
});
afterEach(async () => { vi.restoreAllMocks(); await repo.dispose(); await manager.dispose(); });
const create = (title: string, parent?: string) => repo.createSession(title, '/P/a', parent);

it('persists independent child history and drafts without changing physical paths', async () => {
    const a = await create('A');
    await repo.writeDocument(a, 'round-a.json', '{"text":"parent"}');
    await repo.updateUIState(a, { branchDrafts: { main: { inputText: 'parent draft' } } });
    const b = await create('B', a), c = await create('C', b);
    const reopened = new SessionRepository(fs); await reopened.init();
    expect((await reopened.getManifest(c)).parentSessionId).toBe(b);
    expect((await reopened.getManifest(b)).folder).toBe('/P/a');
    expect(await reopened.readDocument(b, 'round-a.json')).toBeNull();
    expect(await reopened.getUIState(b)).toBeNull();
    expect(await fs.driver.exists(`/var/lib/sessions/${c}/session.seq`)).toBe(true);
    expect(JSON.parse((await fs.meta.seq!.getEntry(`/var/lib/sessions/${b}/history.seq`, 'index'))!)).not.toHaveProperty('parentSessionId');
    await reopened.dispose();
});
it('rejects self, cycles and cross-project moves, and moves a whole subtree between folders', async () => {
    const a = await create('A'), b = await create('B', a), c = await create('C', b);
    const q = await repo.createSession('Q', '/Q'), destination = await repo.createSession('Destination', '/P/b');
    await expect(repo.updateManifest(a, { parentSessionId: c })).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(repo.updateManifest(b, { parentSessionId: b })).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(repo.updateManifest(b, { parentSessionId: q })).rejects.toMatchObject({ code: 'EACCES' });
    await repo.updateManifest(b, { parentSessionId: destination });
    expect((await repo.getManifest(c)).folder).toBe('/P/b');
    expect((await repo.getManifest(c)).parentSessionId).toBe(b);
    await repo.updateManifest(b, { parentSessionId: null });
    expect((await repo.getManifest(b)).parentSessionId).toBeNull();
    expect((await repo.getManifest(c)).parentSessionId).toBe(b);
});
it('promotes direct children on deletion and preserves deeper descendants and their data', async () => {
    const a = await create('A'), b = await create('B', a), c = await create('C', b), d = await create('D', c);
    await repo.writeDocument(c, 'note.json', '{}');
    await repo.deleteSession(b);
    expect((await repo.getManifest(c)).parentSessionId).toBe(a);
    expect((await repo.getManifest(d)).parentSessionId).toBe(c);
    expect(await repo.readDocument(c, 'note.json')).toBe('{}');
    expect(await repo.pendingSessionDeletions()).toEqual([]);
});
it('moves a subtree to another project folder, detaches its old parent and preserves history', async () => {
    const a = await create('A'), b = await create('B', a), c = await create('C', b);
    await repo.writeDocument(c, 'note.json', '{"text":"keep"}');
    await repo.updateManifest(b, { folder: '/Q' });
    expect((await repo.getManifest(b)).parentSessionId).toBeNull();
    expect((await repo.getManifest(a)).folder).toBe('/P/a');
    expect((await repo.getManifest(c)).parentSessionId).toBe(b);
    expect((await repo.getManifest(c)).folder).toBe('/Q');
    expect(await repo.readDocument(c, 'note.json')).toBe('{"text":"keep"}');
});
it('keeps children reachable after a delete failure and retries after reopening', async () => {
    const a = await create('A'), b = await create('B', a);
    const original = fs.driver.delete.bind(fs.driver);
    vi.spyOn(fs.driver, 'delete').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(repo.deleteSession(a)).rejects.toThrow('disk unavailable');
    expect((await repo.getManifest(b)).parentSessionId).toBeNull();
    await expect(create('Blocked', a)).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(repo.updateManifest(b, { parentSessionId: a })).rejects.toMatchObject({ code: 'EBUSY' });
    vi.mocked(fs.driver.delete).mockImplementation(original);
    const reopened = new SessionRepository(fs); await reopened.init();
    expect(await reopened.pendingSessionDeletions()).toHaveLength(1);
    await reopened.deleteSession(a);
    expect(await reopened.pendingSessionDeletions()).toEqual([]);
    expect((await reopened.getManifest(b)).parentSessionId).toBeNull();
    await reopened.dispose();
});
it('serializes concurrent reparent operations without introducing a cycle', async () => {
    const a = await create('A'), b = await create('B');
    const results = await Promise.allSettled([repo.updateManifest(a, { parentSessionId: b }), repo.updateManifest(b, { parentSessionId: a })]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const manifests = await repo.list();
    expect(manifests.filter(item => item.parentSessionId)).toHaveLength(1);
});

it('finishes a pending delete even if the process stopped after removing the physical directory', async () => {
    const a = await create('A'), b = await create('B', a);
    await repo.prepareSessionDeletion(a);
    await fs.driver.delete([`/var/lib/sessions/${a}`], { recursive: true });
    const reopened = new SessionRepository(fs); await reopened.init();
    await reopened.deleteSession(a);
    expect(await reopened.pendingSessionDeletions()).toEqual([]);
    expect((await reopened.getManifest(b)).parentSessionId).toBeNull();
    await reopened.dispose();
});
it('either admits a concurrent new child before promotion or rejects it after deletion is prepared', async () => {
    const a = await create('A');
    const results = await Promise.allSettled([create('B', a), repo.prepareSessionDeletion(a)]);
    expect(results[1].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled') expect((await repo.getManifest(results[0].value)).parentSessionId).toBeNull();
    else expect(results[0].reason).toMatchObject({ code: 'EBUSY' });
});
it('checks write ownership for the entire moved subtree before changing any relation', async () => {
    const a = await create('A'), b = await create('B', a), c = await create('C');
    const guard = vi.fn(async (ids: string[]) => { if (ids.includes(b)) throw new Error('Owned by another host'); });
    repo.setStructuralWriteGuard(guard);
    await expect(repo.updateManifest(a, { parentSessionId: c })).rejects.toThrow('Owned by another host');
    expect(guard.mock.calls[0][0]).toEqual(expect.arrayContaining([a, b, c]));
    expect((await repo.getManifest(a)).parentSessionId).toBeNull();
    expect((await repo.getManifest(b)).parentSessionId).toBe(a);
});
