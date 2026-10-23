import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, transferFileSystemEntry, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { SessionRepository } from '../src/persistence/session-repository';
import { moveSessionDataDirectory } from '../src/persistence/session-storage-locations';
import * as identifiers from '../src/persistence/ulid';

let manager: IVFSManager, fs: IFileSystem, repository: SessionRepository;
const index = '/var/lib/sessions/folders.seq';
const directory = '/home/admin/projects/project/.mindos/sessions';
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    fs = await manager.openFileSystem('/'); repository = new SessionRepository(fs); await repository.init();
});
afterEach(async () => { vi.restoreAllMocks(); await repository.dispose(); await manager.dispose(); });
async function copySession(id: string, parent = directory): Promise<string> {
    await fs.driver.createDirectory({ parentPath: parent.slice(0, parent.lastIndexOf('/')), name: parent.split('/').pop()!, recursive: true });
    await transferFileSystemEntry(fs, `/var/lib/sessions/${id}`, fs, parent);
    return `${parent}/${id}`;
}

it('rejects a generated identity collision without treating creation as recovery', async () => {
    await repository.ensureSession('node-collision', 'Original');
    await repository.writeDocument('node-collision', 'round.json', JSON.stringify('retained'));
    vi.spyOn(identifiers, 'ulid').mockReturnValue('collision');
    await expect(repository.createSession('Replacement')).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await repository.getManifest('node-collision')).title).toBe('Original');
    expect(await repository.readDocument('node-collision', 'round.json')).toBe(JSON.stringify('retained'));
});

it('serializes competing creation claims without deleting the successful identity', async () => {
    vi.spyOn(identifiers, 'ulid').mockReturnValue('collision');
    const results = await Promise.allSettled([repository.createSession('First'), repository.createSession('Second')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'EEXIST' } });
    expect((await repository.list()).map(session => session.id)).toEqual(['node-collision']);
});

it('keeps unindexed central data when a project resolver is installed later', async () => {
    const id = await repository.createSession('Legacy');
    await repository.writeDocument(id, 'round.json', JSON.stringify('retained'));
    await fs.meta.seq!.deleteEntry(index, `storage/${id}`);
    repository.setStorageDirectoryResolver(async () => directory);
    await repository.ensureSession(id, 'Replacement');
    expect(await fs.meta.seq!.getEntry(index, `storage/${id}`)).toBe(`/var/lib/sessions/${id}`);
    expect(await fs.driver.exists(`${directory}/${id}`)).toBe(false);
    expect(await repository.readDocument(id, 'round.json')).toBe(JSON.stringify('retained'));
    expect((await repository.getManifest(id)).title).toBe('Legacy');
});

it('observes a storage registration made after another repository initialized', async () => {
    const other = new SessionRepository(fs); await other.init();
    repository.setStorageDirectoryResolver(async () => directory);
    const id = await repository.createSession('Project');
    try {
        await other.ensureSession(id, 'Replacement');
        expect((await other.getManifest(id)).title).toBe('Project');
        expect(await fs.driver.exists(`/var/lib/sessions/${id}`)).toBe(false);
        expect((await other.list()).map(session => session.id)).toEqual([id]);
    } finally { await other.dispose(); }
});

it('rejects copied identities before publishing navigation or replacing storage ownership', async () => {
    const id = await repository.createSession('Original'), copy = await copySession(id);
    const manifest = JSON.parse((await fs.meta.seq!.getEntry(`${copy}/session.seq`, 'session'))!);
    await fs.meta.seq!.setEntry(`${copy}/session.seq`, 'session', JSON.stringify({ ...manifest, title: 'Conflicting copy' }));
    await expect(repository.validateProjectSessions(directory)).rejects.toMatchObject({ code: 'ECONFLICT', path: copy });
    await expect(repository.indexProjectSessions(directory)).rejects.toThrow(`registered=/var/lib/sessions/${id}; candidate=${copy}`);
    expect(await fs.meta.seq!.getEntry(index, `storage/${id}`)).toBe(`/var/lib/sessions/${id}`);
    expect((await repository.listSummariesInFolder(null))[0].title).toBe('Original');
    expect(JSON.parse((await fs.meta.seq!.getEntry(`${copy}/session.seq`, 'session'))!).title).toBe('Conflicting copy');
});

it('detects a copied identity even before the central storage location was indexed', async () => {
    const id = await repository.createSession('Legacy'); await copySession(id);
    await fs.meta.seq!.deleteEntry(index, `storage/${id}`);
    await expect(repository.validateProjectSessions(directory)).rejects.toMatchObject({ code: 'ECONFLICT' });
    await expect(repository.indexProjectSessions(directory)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(await fs.meta.seq!.getEntry(index, `storage/${id}`)).toBeNull();
});

it('rejects a directory whose name differs from its manifest identity', async () => {
    const id = await repository.createSession('Original');
    const copy = await copySession(id);
    const parent = copy.slice(0, copy.lastIndexOf('/'));
    await transferFileSystemEntry(fs, copy, fs, parent, { newName: 'wrong-id', move: true });
    await expect(repository.indexProjectSessions(directory)).rejects.toMatchObject({ code: 'ECONFLICT', path: `${parent}/wrong-id` });
    expect(await fs.meta.seq!.getEntry(index, 'storage/wrong-id')).toBeNull();
});

it('rejects a stale central move without replacing the authoritative project location', async () => {
    const id = await repository.createSession('Original'), central = `/var/lib/sessions/${id}`;
    repository.setStorageDirectoryResolver(async () => directory);
    await repository.relocateProjectStorage(id);
    await expect(moveSessionDataDirectory(fs, central, `/home/admin/another/${id}`)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(await fs.meta.seq!.getEntry(index, `storage/${id}`)).toBe(`${directory}/${id}`);
    expect(await fs.meta.seq!.getEntry(index, `moving/${id}`)).toBeNull();
    expect((await repository.getManifest(id)).title).toBe('Original');
});

it('rejects an occupied relocation target before fencing or changing the source', async () => {
    const id = await repository.createSession('Original'); await copySession(id);
    await expect(moveSessionDataDirectory(fs, `/var/lib/sessions/${id}`, `${directory}/${id}`)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(await fs.meta.seq!.getEntry(index, `moving/${id}`)).toBeNull();
    expect((await repository.getManifest(id)).title).toBe('Original');
});

it('logs duplicate discovery with both locations and one operation ID without leaking conversation data', async () => {
    const id = await repository.createSession('PRIVATE_SESSION_TITLE'), copy = await copySession(id);
    await repository.writeDocument(id, 'private.json', JSON.stringify('PRIVATE_DOCUMENT_BODY'));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observed = new SessionRepository(fs, undefined, logger);
    try {
        await observed.init();
        await expect(observed.indexProjectSessions(directory)).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(logger.error).toHaveBeenCalledWith('session.storage', expect.objectContaining({operation: 'session.storage.index',
            stage: 'validate-identities', outcome: 'failure', code: 'ECONFLICT', reason: 'SESSION_STORAGE_IDENTITY_CONFLICT',
            sessionId: id, registered: `/var/lib/sessions/${id}`, candidate: copy, durationMs: expect.any(Number)}));
        const failure = logger.error.mock.calls[0][1];
        expect(logger.info.mock.calls.some(([, data]) => data.operationId === failure.operationId)).toBe(true);
        const logs = JSON.stringify([...logger.info.mock.calls, ...logger.error.mock.calls]);
        expect(logs).not.toContain('PRIVATE_SESSION_TITLE'); expect(logs).not.toContain('PRIVATE_DOCUMENT_BODY');
    } finally { await observed.dispose(); }
});

it('ignores unrelated directories without a Session manifest during discovery', async () => {
    await fs.driver.createDirectory({ parentPath: directory, name: '.unrelated', recursive: true });
    await repository.validateProjectSessions(directory);
    await repository.indexProjectSessions(directory);
    expect(await repository.list()).toEqual([]);
});

it('retains a stale move intent without replacing a completed relocation during recovery', async () => {
    const id = await repository.createSession('Original'), central = `/var/lib/sessions/${id}`;
    repository.setStorageDirectoryResolver(async () => directory);
    await repository.relocateProjectStorage(id);
    await fs.meta.seq!.setEntry('/var/lib/sessions/storage-moves.seq', encodeURIComponent(central),
        JSON.stringify({ from: central, to: `/home/admin/another/${id}` }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reopened = new SessionRepository(fs, undefined, logger);
    try {
        await reopened.init();
        expect(logger.error).toHaveBeenCalledWith('session.storage', expect.objectContaining({operation: 'session.storage.recover',
            stage: 'validate-identity', outcome: 'failure', code: 'ECONFLICT', reason: 'SESSION_STORAGE_IDENTITY_CONFLICT'}));
        expect(await fs.meta.seq!.getEntry(index, `storage/${id}`)).toBe(`${directory}/${id}`);
        expect((await reopened.getManifest(id)).title).toBe('Original');
        expect(await fs.driver.exists(`/home/admin/another/${id}`)).toBe(false);
    } finally { await reopened.dispose(); }
});
