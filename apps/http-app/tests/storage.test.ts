import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { openLocalFSBackend, type LocalFSBackend } from '@itookit/vfsdriver-local';
import { createApplicationRuntime } from '@itookit/app-core';
import { NodeSqliteSidecarDb } from '../src/server/sqlite-sidecar';
import { createHttpServer } from '../src/server/http-server';
import { HttpStorageBackend } from '../src/client/backend';
import { HttpTransport } from '../src/client/transport';

let temp: string, root: string, backend: LocalFSBackend, server: Server, client: HttpStorageBackend, origin: string;
let requests: string[], rejectField: string | undefined;
beforeEach(async () => {
    rejectField = undefined;
    temp = await mkdtemp(path.join(tmpdir(), 'mindos-http-')); root = path.join(temp, 'data');
    const ui = path.join(temp, 'ui'); await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<!doctype html><title>MindOS</title>');
    backend = await openLocalFSBackend({ rootDir: root, sidecarDir: path.join(temp, 'sqlite'), createDb: async file => {
        const db = await NodeSqliteSidecarDb.open(file);
        return new Proxy(db, { get(target, key) {
            if (key === 'setRecordField') return async (itemPath: string, field: string, value: unknown) => {
                if (field === rejectField) throw new Error('Injected persistence failure');
                await target.setRecordField(itemPath, field, value);
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
    } });
    server = createHttpServer(backend, root, ui);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number }; origin = `http://127.0.0.1:${address.port}`;
    requests = [];
    const fetcher: typeof fetch = async (input, init) => {
        requests.push(JSON.parse(init!.body as string).method);
        return fetch(input, init);
    };
    client = new HttpStorageBackend(new HttpTransport(`${origin}/api/vfs`, fetcher));
});
afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await backend.close(); await rm(temp, { recursive: true, force: true });
});

it('serves the entry and round-trips binary files, metadata, tags and renamed SeqFile data', async () => {
    expect(await (await fetch(origin)).text()).toContain('<title>MindOS');
    await client.init(); await client.mkdir('/notes');
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]); await client.write('/notes/a.seq', bytes);
    expect(await client.read('/notes/a.seq')).toEqual(bytes);
    expect(await client.read('/notes/a.seq', { offset: 2, length: 2 })).toEqual(bytes.slice(2, 4));
    await client.updateMetadata('/notes/a.seq', { description: 'portable' }); await client.setTags('/notes/a.seq', ['a', 'b']);
    expect((await client.stat('/notes/a.seq'))?.metadata).toMatchObject({ description: 'portable' });
    expect(await client.getAllTags()).toEqual(['a', 'b']);
    await client.records.setRecordField('/notes/a.seq', 'identity', { id: 'one' });
    await client.rename('/notes/a.seq', '/notes/b.seq');
    expect(await client.records.getRecordField('/notes/b.seq', 'identity')).toEqual({ id: 'one' });
    expect(await client.records.getRecordField('/notes/a.seq', 'identity')).toBeUndefined();
    expect(await client.listEntries('/notes')).toHaveLength(1);
    await client.delete('/notes/b.seq'); expect(await client.stat('/notes/b.seq')).toBeNull();
    expect(await client.records.getRecordFieldsMany([{ path: '/x.seq', field: 'missing' }])).toEqual([undefined]);
});

it('commits records across two SeqFiles in one batch and rolls back a failed callback', async () => {
    await client.records.transaction!(async tx => {
        await tx.setRecordField('/a.seq', 'null', null); await tx.setRecordField('/b.seq', 'value', { n: 1 });
        expect(await tx.getRecordField('/a.seq', 'null')).toBeNull();
    });
    expect(requests.filter(method => method === 'records.commit')).toHaveLength(1);
    expect(requests.some(method => /sql|tauri|begin|execute/.test(method))).toBe(false);
    await expect(client.records.transaction!(async tx => {
        await tx.setRecordField('/a.seq', 'null', 'discard'); throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await client.records.getRecordFieldsMany([{ path: '/a.seq', field: 'null' }, { path: '/b.seq', field: 'missing' }])).toEqual([null, undefined]);
    const reopened = new HttpStorageBackend(new HttpTransport(`${origin}/api/vfs`));
    expect(await reopened.records.getRecordField('/b.seq', 'value')).toEqual({ n: 1 });
});

it('rejects a concurrent correction without partially writing another SeqFile', async () => {
    await client.records.setRecordField('/a.seq', 'revision', 1);
    let release!: () => void, observed!: () => void;
    const ready = new Promise<void>(resolve => { observed = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const pending = client.records.transaction!(async tx => {
        expect(await tx.getRecordField('/a.seq', 'revision')).toBe(1); observed(); await wait;
        await tx.setRecordField('/a.seq', 'revision', 2); await tx.setRecordField('/b.seq', 'result', 'discard');
    });
    await ready; await client.records.setRecordField('/a.seq', 'revision', 3); release();
    await expect(pending).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(await client.records.getRecordField('/a.seq', 'revision')).toBe(3);
    expect(await client.records.getRecordField('/b.seq', 'result')).toBeUndefined();
});

it('detects range phantoms and supports read-after-write enumeration and early termination', async () => {
    await client.records.setAllRecordFields('/a.seq', { 'item/a': 1, 'item/b': 2, other: 0 });
    await expect(client.records.transaction!(async tx => {
        const seen: string[] = [];
        expect(await tx.walkRecordFields('/a.seq', field => { seen.push(field); return false; }, { prefix: 'item/', limit: 1 }))
            .toEqual({ total: 2, processed: 0 });
        expect(seen).toEqual(['item/a']);
        await client.records.setRecordField('/a.seq', 'item/c', 3);
        await tx.setRecordField('/b.seq', 'result', true);
    })).rejects.toMatchObject({ code: 'ECONFLICT' });
    await client.records.transaction!(async tx => {
        await tx.deleteRecordField('/a.seq', 'item/a'); await tx.setRecordField('/a.seq', 'item/d', 4);
        const seen: string[] = [];
        expect(await tx.walkRecordFields('/a.seq', field => { seen.push(field); return true; }, { prefix: 'item/', offset: 1, limit: 2 }))
            .toEqual({ total: 3, processed: 2 });
        expect(seen).toEqual(['item/c', 'item/d']);
    });
});

it('blocks traversal, symlink escapes, root deletion, SQL and cross-origin writes', async () => {
    await writeFile(path.join(temp, 'outside'), 'secret'); await symlink(temp, path.join(root, 'escape'));
    await mkdir(path.join(root, '_meta')); await writeFile(path.join(root, '_meta', 'private'), 'database');
    expect((await client.list('/')).some(node => node.name === '_meta')).toBe(false);
    await expect(client.read('/_meta/private')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(client.read('/../outside')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(client.read('/escape/outside')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(client.delete('/', { recursive: true })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(client.read('/missing')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(new HttpTransport(`${origin}/api/vfs`).call('sqlite_execute', [])).rejects.toMatchObject({ code: 'EINVAL' });
    const response = await fetch(`${origin}/api/vfs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
        body: JSON.stringify({ method: 'write', args: ['/bad', ''] }) });
    expect(response.status).toBe(403); expect(await backend.stat('/bad')).toBeNull();
    expect(await readFile(path.join(temp, 'outside'), 'utf8')).toBe('secret');
});

it('boots the full application runtime through the HTTP backend and preserves the personal project on reopen', async () => {
    const reference = JSON.stringify({ version: 1, id: 'old-machine', name: 'External', createdAt: 1,
        directory: 'host:/Users/li/share/x1', kind: 'local' });
    await client.write('/home/admin/projects/.mindos/local.seq', new Uint8Array());
    await client.records.setRecordField('/home/admin/projects/.mindos/local.seq', 'old-machine', reference);
    const first = await createApplicationRuntime({ backend: client, ownerKind: 'web', digitalTwinAutoStart: false });
    const project = await first.projects.personal(); expect(project.project.id).toEqual(expect.any(String)); await first.dispose();
    const second = await createApplicationRuntime({ backend: new HttpStorageBackend(new HttpTransport(`${origin}/api/vfs`)), ownerKind: 'web', digitalTwinAutoStart: false });
    expect((await second.projects.personal()).project.id).toBe(project.project.id);
    expect(await client.records.getRecordField('/home/admin/projects/.mindos/local.seq', 'old-machine')).toBe(reference);
    await second.dispose();
}, 20000);


it('rolls back all SeqFiles when persistence fails after the first mutation', async () => {
    rejectField = 'reject';
    await expect(client.records.transaction!(async tx => {
        await tx.setRecordField('/a.seq', 'first', 'discard');
        await tx.setRecordField('/b.seq', 'reject', 'failure');
    })).rejects.toMatchObject({ code: 'EIO' });
    expect(await client.records.getRecordField('/a.seq', 'first')).toBeUndefined();
    expect(await client.records.getRecordField('/b.seq', 'reject')).toBeUndefined();
});

it('matches native record enumeration order after staged Unicode inserts', async () => {
    const staged: string[] = [], persisted: string[] = [];
    await client.records.transaction!(async tx => {
        await tx.setRecordField('/unicode.seq', 'item/\uffff', 1);
        await tx.setRecordField('/unicode.seq', 'item/😀', 2);
        await tx.walkRecordFields('/unicode.seq', field => { staged.push(field); return true; });
    });
    await client.records.walkRecordFields('/unicode.seq', field => { persisted.push(field); return true; });
    expect(staged).toEqual(persisted); expect(persisted).toHaveLength(2);
});
