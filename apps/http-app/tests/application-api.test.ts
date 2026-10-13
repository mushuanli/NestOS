import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { createApplicationRuntime } from '@itookit/app-core';
import { ApplicationHost } from '@itookit/app-core/application';
import { ApplicationApi } from '../src/server/application-api';
import { HttpApplicationPort } from '../src/client/application-port';
import { createCertificates } from '../src/server/create-certificates';
import { NodeSqliteSidecarDb } from '../src/server/sqlite-sidecar';
import { authenticatedFetch, secureServers, close } from './tls-fixture';

let directory: string, api: ApplicationApi, servers: Awaited<ReturnType<typeof secureServers>>, client: Awaited<ReturnType<typeof authenticatedFetch>>;
beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mindos-application-'));
    const certificates = path.join(directory, 'certs'), ui = path.join(directory, 'ui');
    await createCertificates(certificates, ['127.0.0.1']); await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<title>Application</title>');
    const root = path.join(directory, 'data'); await mkdir(root);
    await mkdir(path.join(root, 'home/admin/notes'), { recursive: true });
    await writeFile(path.join(root, 'home/admin/notes/shared.md'), 'original');
    const backend = await openLocalFSBackend({ rootDir: root, sidecarDir: path.join(root, '_meta'), createDb: file => NodeSqliteSidecarDb.open(file) });
    const host = new ApplicationHost(() => createApplicationRuntime({ backend, digitalTwinAutoStart: false }), ['notes']);
    api = new ApplicationApi(host, 1);
    servers = await secureServers(backend, root, ui, certificates, api); client = await authenticatedFetch(certificates);
});
afterAll(async () => {
    client?.close(); api?.endStreams(); if (servers) { await close(servers.server); await close(servers.internal); }
    await api?.close(); await rm(directory, { recursive: true, force: true });
});
it('serves the same capability contract over authenticated HTTP and persists command receipts after client release', async () => {
    const port = new HttpApplicationPort(servers.origin + '/api/application', client.fetcher, 'client');
    expect(await port.query('capabilities', undefined)).toMatchObject({ protocol: 1, workspaces: ['notes'], receipts: true });
    const input = { title: 'Created once' }, created = await port.command('createConversation', input, undefined, 'create-once');
    const view = await port.query('conversation', { sessionId: created.sessionId });
    expect(view.snapshot.sessionId).toBe(created.sessionId); expect(view.manifest.title).toBe(input.title);
    await port.close();
    const reopened = new HttpApplicationPort(servers.origin + '/api/application', client.fetcher, 'client');
    expect(await reopened.command('createConversation', input, undefined, 'create-once')).toEqual(created);
    expect(await reopened.query('sessions', {})).toHaveLength(1);
    await expect(reopened.command('createConversation', { title: 'different' }, undefined, 'create-once')).rejects.toMatchObject({ code: 'ECONFLICT' });
    await reopened.close();
});
it('denies raw managed storage writes and cross-origin application operations', async () => {
    const raw = await client.fetcher(servers.origin + '/api/vfs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(raw.status).toBe(403);
    const cross = await client.fetcher(servers.origin + '/api/application', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://another.example' }, body: '{}' });
    expect(cross.status).toBe(403);
});
it('releases idle clients without disposing the owning runtime or losing durable receipts', async () => {
    const port = new HttpApplicationPort(servers.origin + '/api/application', client.fetcher, 'idle');
    const created = await port.command('createConversation', { title: 'Idle' }, undefined, 'idle-create');
    await api.releaseIdle(Date.now() + 1000);
    expect(await port.command('createConversation', { title: 'Idle' }, undefined, 'idle-create')).toEqual(created);
    expect((await port.query('sessions', {})).some(session => session.id === created.sessionId)).toBe(true); await port.close();
});
it('does not advertise or silently ignore unsupported file revision preconditions', async () => {
    const first = new HttpApplicationPort(servers.origin + '/api/application', client.fetcher, 'writer-one');
    const second = new HttpApplicationPort(servers.origin + '/api/application', client.fetcher, 'writer-two');
    const identity = { kind: 'workspace' as const, name: 'notes' }, query = { workspace: identity, path: '/shared.md' };
    const file = await first.query('file', query); expect(file.revision).toBeUndefined();
    await first.command('saveFile', { ...query, revision: file.revision, content: 'first writer' });
    await expect(second.command('saveFile', { ...query, revision: 'unavailable-precondition', content: 'stale writer' })).rejects.toMatchObject({ code: 'ECAPABILITY' });
    expect((await second.query('file', query)).content).toBe('first writer'); await first.close(); await second.close();
});
