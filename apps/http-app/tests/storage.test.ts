import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLocalFSBackend, type LocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { guardHostStorage } from '@itookit/node-host/storage';

let directory: string, backend: LocalFSBackend;
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nestos-host-'));
    backend = await openLocalFSBackend({ rootDir: path.join(directory, 'data'), sidecarDir: path.join(directory, 'meta'), createDb: NodeSqliteSidecarDb.open });
});
afterEach(async () => { await backend.close(); await rm(directory, { recursive: true, force: true }); });
it('commits and rolls back records across two SeqFiles inside the daemon', async () => {
    await backend.records.transaction!(async transaction => {
        await transaction.setRecordField('/a.seq', 'revision', 1); await transaction.setRecordField('/b.seq', 'result', 'keep');
    });
    await expect(backend.records.transaction!(async transaction => {
        await transaction.setRecordField('/a.seq', 'revision', 2); await transaction.setRecordField('/b.seq', 'result', 'discard'); throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await backend.records.getRecordFieldsMany!([{ path: '/a.seq', field: 'revision' }, { path: '/b.seq', field: 'result' }])).toEqual([1, 'keep']);
});
it('blocks symlink escapes, private metadata and traversal beneath the application runtime', async () => {
    await writeFile(path.join(directory, 'secret'), 'private'); await symlink(directory, path.join(directory, 'data', 'escape'));
    const storage = guardHostStorage(backend, path.join(directory, 'data'));
    await expect(storage.read('/escape/secret')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(storage.read('/../secret')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(storage.read('/_meta/private')).rejects.toMatchObject({ code: 'EINVAL' });
});
