import { afterEach, beforeEach, expect, it } from 'vitest';
import { createVFS, MemoryBackend, type IFileSystem, type IVFSManager } from '@itookit/vfs-core';
import { SessionRepository } from '../src/persistence/session-repository';
import { moveSessionDataDirectory } from '../src/persistence/session-storage-locations';

let manager: IVFSManager, fs: IFileSystem, repository: SessionRepository;
beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    fs = await manager.openFileSystem('/'); repository = new SessionRepository(fs); await repository.init();
});
afterEach(async () => { await repository.dispose(); await manager.dispose(); });
const directory = '/home/admin/projects/project/.mindos/sessions';

it('relocates existing central conversation data while keeping runtime controls and kernel files', async () => {
    const id = await repository.createSession('Existing');
    const from = `/var/lib/sessions/${id}`, to = `${directory}/${id}`;
    await repository.writeDocument(id, 'round.json', JSON.stringify('history'));
    await repository.writeAttachment(id, 'note.txt', new TextEncoder().encode('attachment').buffer);
    await fs.meta.seq!.setEntry(`${from}/session.seq`, 'files', 'runtime grant');
    await fs.driver.createFile({ parentPath: `${from}/kernel`, name: 'control.txt', content: 'kernel', recursive: true });
    repository.setStorageDirectoryResolver(async () => directory);
    await repository.relocateProjectStorage(id);
    expect(await repository.readDocument(id, 'round.json')).toBe(JSON.stringify('history'));
    expect(await fs.driver.readContent(`${to}/attachments/note.txt`, { encoding: 'utf-8' })).toBe('attachment');
    expect(await fs.meta.seq!.getEntry(`${from}/session.seq`, 'files')).toBe('runtime grant');
    expect(await fs.driver.readContent(`${from}/kernel/control.txt`, { encoding: 'utf-8' })).toBe('kernel');
    expect(await fs.meta.seq!.getEntry(`${to}/session.seq`, 'files')).toBeNull();
    expect(await fs.meta.seq!.getEntry(`${from}/session.seq`, 'session')).toBeNull();
    await repository.relocateProjectStorage(id);
    const reopened = new SessionRepository(fs); await reopened.init();
    expect((await reopened.getManifest(id)).title).toBe('Existing');
    expect(await reopened.readDocument(id, 'round.json')).toBe(JSON.stringify('history'));
});

it.each([false, true])('recovers a rejected central relocation at startup (indexed: %s)', async indexed => {
    const id = await repository.createSession('Pending');
    const from = `/var/lib/sessions/${id}`, to = `${directory}/${id}`;
    await repository.writeDocument(id, 'round.json', JSON.stringify('saved'));
    await fs.driver.createFile({ parentPath: '/var/lib/sessions', name: 'storage-moves.seq', type: 'seqfile' });
    await fs.meta.seq!.setEntry('/var/lib/sessions/storage-moves.seq', encodeURIComponent(from), JSON.stringify({ from, to }));
    if (indexed) {
        await fs.meta.seq!.setEntry('/var/lib/sessions/folders.seq', `storage/${id}`, from);
        await fs.meta.seq!.setEntry('/var/lib/sessions/folders.seq', `moving/${id}`, encodeURIComponent(from));
    }
    const reopened = new SessionRepository(fs); await reopened.init();
    expect(await reopened.readDocument(id, 'round.json')).toBe(JSON.stringify('saved'));
    expect(await fs.meta.seq!.getEntry('/var/lib/sessions/folders.seq', `storage/${id}`)).toBe(to);
    expect(await fs.meta.seq!.getEntry('/var/lib/sessions/storage-moves.seq', encodeURIComponent(from))).toBeNull();
    await reopened.init();
    expect((await reopened.list()).filter(item => item.id === id)).toHaveLength(1);
});

it('rejects invalid paths before persisting any relocation intent', async () => {
    await repository.createSession('Original');
    await expect(moveSessionDataDirectory(fs, '/var/lib/kernel/session', `${directory}/session`)).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(moveSessionDataDirectory(fs, '/home/admin/source', '/home/admin/source/child')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(moveSessionDataDirectory(fs, '/home/admin/source', '/home/admin/project/..')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(await fs.driver.exists('/var/lib/sessions/storage-moves.seq')).toBe(false);
});

it('resumes a completed attachment copy before its phase record was written', async () => {
    const id = await repository.createSession('Interrupted');
    const from = `/var/lib/sessions/${id}`, to = `${directory}/${id}`;
    await repository.writeAttachment(id, 'note.txt', new TextEncoder().encode('retained').buffer);
    await fs.driver.createFile({ parentPath: '/var/lib/sessions', name: 'storage-moves.seq', type: 'seqfile' });
    await fs.meta.seq!.setEntry('/var/lib/sessions/storage-moves.seq', encodeURIComponent(from), JSON.stringify({ from, to }));
    await fs.driver.createFile({ parentPath: to, name: 'session.seq', type: 'seqfile', recursive: true });
    await fs.meta.seq!.setEntry(`${to}/session.seq`, 'storage-relocation-source', from);
    await fs.driver.createFile({ parentPath: `${to}/attachments`, name: 'note.txt', content: 'retained', recursive: true });
    const reopened = new SessionRepository(fs); await reopened.init();
    expect(await fs.meta.seq!.getEntry('/var/lib/sessions/folders.seq', `storage/${id}`)).toBe(to);
    expect(await fs.meta.seq!.getEntry('/var/lib/sessions/storage-moves.seq', encodeURIComponent(from))).toBeNull();
    expect(await fs.driver.exists(`${from}/attachments/note.txt`)).toBe(true);
});

it('keeps conflicting attachments and recovery evidence without blocking unrelated sessions', async () => {
    const id = await repository.createSession('Interrupted'), other = await repository.createSession('Available');
    const from = `/var/lib/sessions/${id}`, to = `${directory}/${id}`;
    await repository.writeAttachment(id, 'note.txt', new TextEncoder().encode('original').buffer);
    await fs.driver.createFile({ parentPath: '/var/lib/sessions', name: 'storage-moves.seq', type: 'seqfile' });
    const key = encodeURIComponent(from);
    await fs.meta.seq!.setEntry('/var/lib/sessions/storage-moves.seq', key, JSON.stringify({ from, to }));
    await fs.meta.seq!.setEntry('/var/lib/sessions/folders.seq', `storage/${id}`, from);
    await fs.meta.seq!.setEntry('/var/lib/sessions/folders.seq', `moving/${id}`, key);
    await fs.driver.createFile({ parentPath: to, name: 'session.seq', type: 'seqfile', recursive: true });
    await fs.meta.seq!.setEntry(`${to}/session.seq`, 'storage-relocation-source', from);
    await fs.driver.createFile({ parentPath: `${to}/attachments`, name: 'note.txt', content: 'different', recursive: true });
    const reopened = new SessionRepository(fs); await reopened.init();
    expect((await reopened.getManifest(other)).title).toBe('Available');
    expect((await reopened.list()).map(session => session.id)).toEqual([other]);
    expect((await reopened.listSummaries()).map(session => session.id)).toEqual([other]);
    await expect(reopened.getManifest(id)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await fs.meta.seq!.getEntry('/var/lib/sessions/storage-moves.seq', key)).not.toBeNull();
    expect(await fs.driver.readContent(`${from}/attachments/note.txt`, { encoding: 'utf-8' })).toBe('original');
    expect(await fs.driver.readContent(`${to}/attachments/note.txt`, { encoding: 'utf-8' })).toBe('different');
});
