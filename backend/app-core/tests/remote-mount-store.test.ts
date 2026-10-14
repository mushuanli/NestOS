import { it, expect, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { RemoteMountStore, type RemoteMountCatalog } from '../src/projects/remote-mount-store';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';

const connection = { id: 'connection-1', name: 'Office', endpoint: 'http://files.test', username: 'alice', credentialRef: 'credential-1' };
const catalog: RemoteMountCatalog = { version: 1, revision: 4, connections: [connection], projects: { 'project-1': [
    { ...connection, connectionId: connection.id, mountId: 'mount-1', alias: 'docs', root: '/a', at: '/', access: 'ro' },
] } };

it('migrates legacy settings once, preserves stable IDs and ignores the old backup after migration', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }), fs = await manager.openFileSystem('/');
    const legacy = '/etc/project-remote-mounts.seq';
    await fs.driver.createFile({ parentPath: '/etc', name: 'project-remote-mounts.seq', type: 'seqfile', recursive: true });
    await fs.meta.seq!.setEntry(legacy, 'catalog', JSON.stringify(catalog));
    const provider = { setCredential: vi.fn(), async dispose() {}, async open(): Promise<never> { throw new Error('No network during migration'); } };
    const service = new ProjectRemoteMountService(fs, provider, async () => {}, async () => {});
    try {
        await service.init();
        expect(service.connections()).toEqual([connection]);
        expect(service.findRemoteProject(connection.id, '/docs/a')).toBe('project-1');
        expect(JSON.parse((await fs.meta.seq!.getEntry('/etc/fs/remote/connection-1.seq', 'config'))!)).toEqual(connection);
        expect(JSON.parse((await fs.meta.seq!.getEntry('/etc/fs/projects/project-1.seq', 'config'))!)).toEqual(catalog.projects['project-1']);
        expect(await fs.meta.seq!.getEntry(legacy, 'catalog')).toBe(JSON.stringify(catalog));
        await fs.meta.seq!.setEntry(legacy, 'catalog', 'bad old data');
        const reloaded = new RemoteMountStore(fs);
        expect((await reloaded.load())?.connections).toEqual([connection]);
        expect(reloaded.needsMigration).toBe(false); expect(provider.setCredential).not.toHaveBeenCalled();
    } finally { await service.dispose(); await manager.dispose(); }
});

it('rolls back partial record changes and rejects stale writers; removing records cannot resurrect them', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }), fs = await manager.openFileSystem('/');
    try {
        const first = new RemoteMountStore(fs); await first.save(catalog, { id: connection.id, password: 'original' });
        const second = new RemoteMountStore(fs); await second.load();
        let interrupted = false;
        const seq = fs.meta.seq!;
        const faultySeq = new Proxy(seq, { get(target, property) {
            if (property === 'transaction') return (run: Parameters<typeof seq.transaction>[0]) => seq.transaction(async tx => {
                const result = await run(tx); if (interrupted) throw new Error('interrupted'); return result;
            });
            return Reflect.get(target, property);
        } });
        const faultyFS = new Proxy(fs, { get(target, property) {
            return property === 'meta' ? new Proxy(target.meta, { get(meta, name) { return name === 'seq' ? faultySeq : Reflect.get(meta, name); } }) : Reflect.get(target, property);
        } });
        const failing = new RemoteMountStore(faultyFS); await failing.load(); interrupted = true;
        await expect(failing.save({ ...catalog, revision: 5, connections: [{ ...connection, name: 'Changed' }] }, { id: connection.id, password: 'uncommitted' })).rejects.toThrow('interrupted');
        expect((await new RemoteMountStore(fs).load())?.connections?.[0].name).toBe('Office');
        expect(await fs.meta.seq!.getEntry('/etc/fs/remote/connection-1.seq', 'password')).toBe('original');
        await first.save({ version: 1, revision: 5, connections: [], projects: {} });
        await expect(second.save({ ...catalog, revision: 5 })).rejects.toMatchObject({ code: 'ECONFLICT' });
        expect(await fs.meta.seq!.getEntry('/etc/fs/remote/connection-1.seq', 'config')).toBeNull();
        expect(await new RemoteMountStore(fs).load()).toEqual({ version: 1, revision: 5, connections: [], projects: {} });
    } finally { await manager.dispose(); }
});

it('restores saved credentials after restart, keeps blank edits, and deletes persisted and cached passwords', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() }), fs = await manager.openFileSystem('/');
    const provider = () => ({ setCredential: vi.fn(), clearCredential: vi.fn(), async dispose() {}, async open(): Promise<never> { throw new Error('unused'); } });
    const firstProvider = provider(), nextProvider = provider();
    const first = new ProjectRemoteMountService(fs, firstProvider, async () => {}, async () => {});
    const next = new ProjectRemoteMountService(fs, nextProvider, async () => {}, async () => {});
    try {
        await first.init();
        const id = await first.saveConnection({ name: 'Files', endpoint: 'files.test', username: 'alice' }, 'saved-password');
        const path = `/etc/fs/remote/${id}.seq`, ref = first.connection(id).credentialRef;
        expect(await fs.meta.seq!.getEntry(path, 'password')).toBe('saved-password');
        expect(JSON.stringify(first.connections())).not.toContain('saved-password');
        expect(await fs.meta.seq!.getEntry(path, 'config')).not.toContain('saved-password');
        await first.dispose(); await next.init();
        expect(nextProvider.setCredential).toHaveBeenCalledWith(ref, 'saved-password');
        await next.saveConnection({ name: 'Renamed', endpoint: 'files.test', username: 'alice' }, '', id);
        expect(await fs.meta.seq!.getEntry(path, 'password')).toBe('saved-password');
        await next.saveConnection({ name: 'Renamed', endpoint: 'files.test', username: 'alice' }, 'replacement', id);
        expect(await fs.meta.seq!.getEntry(path, 'password')).toBe('replacement');
        await expect(first.saveConnection({ name: 'Stale', endpoint: 'files.test', username: 'alice' }, 'bad', id)).rejects.toThrow();
        expect(await fs.meta.seq!.getEntry(path, 'password')).toBe('replacement');
        await next.removeConnection(id);
        expect(await fs.meta.seq!.getEntry(path, 'password')).toBeNull();
        expect(await fs.meta.seq!.getEntry(path, 'config')).toBeNull();
        expect(nextProvider.clearCredential).toHaveBeenCalledWith(ref);
    } finally { await next.dispose(); await manager.dispose(); }
});
