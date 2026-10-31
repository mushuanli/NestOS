import {expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, rm, cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {X509Certificate} from 'node:crypto';
import {createCertificates, createUserCertificate, loadCertificates, startHost} from '@itookit/node-host/http';
import {HttpViewClient} from '@itookit/app-transport/http';
import {ApplicationEventFeed} from '@itookit/app-transport/application';
import {authenticatedFetch} from './tls-fixture';
import {openLocalFSBackend} from '@itookit/vfsdriver-local';
import {NodeSqliteSidecarDb} from '@itookit/node-host/storage';
import {createVFS} from '@itookit/vfs-core';
import {UserEventService} from '../../../backend/app-core/src/events/service';

it('serves independent browser cursors, isolates users and reopens their real persisted homes after host restart', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'nestos-events-'));
    const certs = path.join(temp, 'certs'), ui = path.join(temp, 'ui');
    const clients: HttpViewClient[] = [], fetchers: Array<Awaited<ReturnType<typeof authenticatedFetch>>> = [];
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
        await createCertificates(certs, ['127.0.0.1']); await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<title>Events</title>');
        const alice = await createUserCertificate(certs, 'alice');
        await cp(path.join(certs, 'ca.crt'), path.join(certs, 'users/alice/ca.crt'));
        const admin = new X509Certificate(await readFile(path.join(certs, 'client.crt'))).fingerprint256.replaceAll(':', '').toLowerCase();
        await writeFile(path.join(certs, 'clients.json'), JSON.stringify({[admin]: {userId: 'admin'}, [alice.fingerprint]: {userId: 'alice'}}));
        const options = {root: path.join(temp, 'server'), sidecar: path.join(temp, 'unused'), authDir: path.join(temp, 'auth'),
            usersDir: path.join(temp, 'home'), staticDir: ui, auditFile: path.join(temp, 'audit.jsonl'), certificates: await loadCertificates(certs),
            port: 0, host: '127.0.0.1', backlog: 32};
        host = await startHost(options);
        const connect = async (identity: string, id: string) => {
            const auth = await authenticatedFetch(identity); fetchers.push(auth);
            const port = (host!.server.address() as {port: number}).port;
            const client = new HttpViewClient(id, `https://127.0.0.1:${port}/api/application`, auth.fetcher); clients.push(client);
            return client.start();
        };
        const a = await connect(certs, 'browser-a'), b = await connect(certs, 'browser-b');
        const c = await connect(path.join(certs, 'users/alice'), 'browser-a');
        const before = await a.backend.events!.eventBaseline(), other = await c.backend.events!.eventBaseline();
        const receivedA = vi.fn(), receivedB = vi.fn(), failures = vi.fn();
        const feedA = new ApplicationEventFeed(a.backend.events!, before, {receive: receivedA, reset() {}, failure: failures});
        const feedB = new ApplicationEventFeed(b.backend.events!, before, {receive: receivedB, reset() {}, failure: failures});
        await feedA.start(); await feedB.start();
        const files = await a.services.vfs.openFileSystem('/home/admin/notes');
        await files.driver.createFile({parentPath: '/', name: 'event-test.md', content: 'PRIVATE_BODY'});
        await vi.waitFor(() => {expect(receivedA).toHaveBeenCalled(); expect(receivedB).toHaveBeenCalled();});
        const page = await b.backend.events!.readEvents(before);
        expect(page.events.some(event => event.value.type === 'node:created')).toBe(true);
        expect(JSON.stringify(page)).not.toContain('PRIVATE_BODY');
        expect((await c.backend.events!.readEvents(other)).events).toEqual([]);
        await expect(c.backend.events!.readEvents(before)).rejects.toMatchObject({code: 'ECONFLICT'});
        feedA.close(); feedB.close();
        for (const client of clients.splice(0)) await client.close();
        for (const auth of fetchers.splice(0)) auth.close();
        await host.close(); host = undefined;
        host = await startHost(options);
        const restored = await connect(certs, 'after-restart');
        const replay = await restored.backend.events!.readEvents(before);
        expect(replay.events.some(event => event.value.type === 'node:created')).toBe(true);
        expect(replay.events.some(event => event.value.type === 'runtime.reset')).toBe(true);
        expect(replay.cursor.streamId).toBe(before.streamId); expect(failures).not.toHaveBeenCalled();
    } finally {
        for (const client of clients) await client.close();
        for (const auth of fetchers) auth.close();
        await host?.close(); await rm(temp, {recursive: true, force: true});
    }
}, 60000);

it('persists unread/read state across physical SQLite storage close and reopen for separate users', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'nestos-event-state-'));
    const open = async (user: string) => {
        const base = path.join(temp, user, '.nestos');
        const backend = await openLocalFSBackend({rootDir: path.join(base, 'state'), sidecarDir: path.join(base, 'meta'),
            durability: 'full', createDb: NodeSqliteSidecarDb.open});
        const {manager} = await createVFS({rootBackend: backend});
        return {service: await UserEventService.open(await manager.openFileSystem('/')),
            close: async () => {await manager.dispose(); await backend.close();}};
    };
    try {
        for (const user of ['alice', 'bob']) {
            const current = await open(user);
            try {
                await current.service.journal.append('same-id', {type: 'task.failed', resourceId: user, notification: 'error'});
                if (user === 'alice') await current.service.setNotificationRead('same-id', true);
            } finally {await current.close();}
        }
        for (const user of ['alice', 'bob']) {
            const current = await open(user);
            try {expect((await current.service.listNotifications()).items[0]).toMatchObject({read: user === 'alice', event: {value: {resourceId: user}}});}
            finally {await current.close();}
        }
    } finally {await rm(temp, {recursive: true, force: true});}
});
