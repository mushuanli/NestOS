import {afterAll, beforeAll, expect, it} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, stat, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate} from 'node:crypto';
import {createCertificates, loadCertificates, startHost, importLegacyUser} from '@itookit/node-host/http';
import {openLocalFSBackend} from '@itookit/vfsdriver-local';
import {NodeSqliteSidecarDb} from '@itookit/node-host/storage';
import {openUserApplication} from '../../node-host/src/http/user-application';
import {HttpViewClient} from '@itookit/app-transport/http';
import {authenticatedFetch, listen, close} from './tls-fixture';
import {resolveHttpDirectories} from '@itookit/node-host/runtime';
import {createHttpServer} from '@itookit/node-host/http';

let temp: string, host: Awaited<ReturnType<typeof startHost>>;
let admin: Awaited<ReturnType<typeof authenticatedFetch>>, alice: typeof admin;
const clients: HttpViewClient[] = [];
const execute = promisify(execFile);
beforeAll(async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'nestos-users-'));
    const certs = path.join(temp, 'certs'), second = path.join(temp, 'alice-certs'), ui = path.join(temp, 'ui');
    await createCertificates(certs, ['127.0.0.1']); await mkdir(second); await mkdir(ui);
    await cp(path.join(certs, 'ca.crt'), path.join(second, 'ca.crt'));
    await execute('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(second, 'client.key'),
        '-out', path.join(second, 'client.csr'), '-subj', '/CN=Alice']);
    await execute('openssl', ['x509', '-req', '-in', path.join(second, 'client.csr'), '-CA', path.join(certs, 'ca.crt'), '-CAkey', path.join(certs, 'ca.key'),
        '-CAcreateserial', '-out', path.join(second, 'client.crt'), '-days', '365', '-extfile', path.join(certs, 'client.ext')]);
    const fingerprint = async (file: string) => new X509Certificate(await readFile(file)).fingerprint256.replaceAll(':', '').toLowerCase();
    const policy = {[await fingerprint(path.join(certs, 'client.crt'))]: {userId: 'admin'}, [await fingerprint(path.join(second, 'client.crt'))]: {userId: 'alice'}};
    await writeFile(path.join(certs, 'clients.json'), JSON.stringify(policy));
    await writeFile(path.join(ui, 'index.html'), '<title>Multi-user</title>');
    admin = await authenticatedFetch(certs); alice = await authenticatedFetch(second);
    host = await startHost({root: path.join(temp, 'server'), sidecar: path.join(temp, 'unused-meta'), authDir: path.join(temp, 'unused-auth'),
        usersDir: path.join(temp, 'home'), staticDir: ui, auditFile: path.join(temp, 'audit.jsonl'), certificates: await loadCertificates(certs),
        port: 0, host: '127.0.0.1', backlog: 32});
}, 30000);
afterAll(async () => {
    for (const client of clients) await client.close();
    admin?.close(); alice?.close(); await host?.close(); await rm(temp, {recursive: true, force: true});
});
const origin = () => `https://127.0.0.1:${(host.server.address() as {port: number}).port}`;
async function view(fetcher: typeof fetch, id = 'same-client') {
    const client = new HttpViewClient(id, origin() + '/api/application', fetcher); clients.push(client);
    return client.start();
}
it('routes equal client IDs into separate runtimes and stores complete state inside each home', async () => {
    expect(await (await admin.fetcher(origin() + '/api/identity')).json()).toEqual({userId: 'admin'});
    expect(await (await alice.fetcher(origin() + '/api/identity')).json()).toEqual({userId: 'alice'});
    const [a, b] = await Promise.all([view(admin.fetcher), view(alice.fetcher)]);
    const session = await a.services.projects.sessions.create('admin-private-session', null);
    expect((await a.services.projects.sessions.get(session)).id).toBe(session);
    await expect(b.services.projects.sessions.get(session)).rejects.toThrow();
    const filesA = await a.services.vfs.openFileSystem('/home/admin/notes');
    const filesB = await b.services.vfs.openFileSystem('/home/admin/notes');
    await filesA.driver.createFile({name: 'private.txt', parentPath: '/', content: 'admin-private-content'});
    expect(await filesB.driver.exists('/private.txt')).toBe(false);
    await filesB.driver.createFile({name: 'private.txt', parentPath: '/', content: 'alice-private-content'});
    expect(await readFile(path.join(temp, 'home/admin/notes/private.txt'), 'utf8')).toBe('admin-private-content');
    expect(await readFile(path.join(temp, 'home/alice/notes/private.txt'), 'utf8')).toBe('alice-private-content');
    for (const id of ['admin', 'alice']) {
        expect((await stat(path.join(temp, 'home', id, '.nestos/meta/index.db'))).isFile()).toBe(true);
        expect((await stat(path.join(temp, 'home', id, '.nestos/state/var/lib'))).isDirectory()).toBe(true);
    }
    const home = await b.services.vfs.openFileSystem('/home/admin');
    expect((await home.driver.getChildren('/')).some(node => node.name === '.nestos')).toBe(false);
    await expect(home.driver.readContent('/.nestos/meta/index.db')).rejects.toThrow();
});
it('shares definitions while rejecting non-admin configuration writes and cross-user request pins', async () => {
    const a = await view(admin.fetcher, 'config-admin'), b = await view(alice.fetcher, 'config-alice');
    expect(b.services.agentService.getProviders().map(provider => provider.id)).toEqual(a.services.agentService.getProviders().map(provider => provider.id));
    const provider = a.services.agentService.getProviders()[0];
    const full = await a.services.agentService.getFullProvider(provider.id);
    await a.services.agentService.saveProvider({...full!, apiKey: 'shared-secret-test'});
    await expect(b.services.agentService.saveProvider({...provider, name: 'forbidden-change'})).rejects.toThrow();
    const response = await alice.fetcher(origin() + '/api/application', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-NestOS-User': 'admin'}, body: '{}'});
    expect(response.status).toBe(403);
    const etc = await b.services.vfs.openFileSystem('/etc');
    await expect(etc.driver.readContent('/llm/.providers/test.json')).rejects.toThrow('administrator');
    const ocr = await b.backend.ocr(); await expect(ocr.prepareConfiguration()).resolves.toBeUndefined();
    const settings = await b.backend.settings([]);
    await expect(settings.readPreference('/llm/.providers/test.json')).rejects.toThrow('administrator');
    const config = await readFile(path.join(temp, 'audit.jsonl'), 'utf8');
    expect(config).toContain('user.runtime.ready');
    expect(config).not.toContain('admin-private-content'); expect(config).not.toContain('alice-private-content'); expect(config).not.toContain('shared-secret-test');
});
it('rejects invalid mappings and symbolic-link user homes', async () => {
    const file = path.join(temp, 'certs/clients.json'), saved = await readFile(file, 'utf8');
    const fingerprint = Object.keys(JSON.parse(saved))[0];
    await writeFile(file, JSON.stringify({[fingerprint]: {userId: '../escape'}}));
    await expect(loadCertificates(path.join(temp, 'certs'))).rejects.toThrow('valid userId');
    await writeFile(file, saved);
    const outside = path.join(temp, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(temp, 'home', 'mallory'));
    const events: Array<{event: string; stage?: string; code?: string}> = [];
    await expect(openUserApplication({usersDir: path.join(temp, 'home')} as never, 'mallory',
        {write: event => events.push(event), close: async () => {}})).rejects.toThrow('real directories');
    expect(events).toContainEqual(expect.objectContaining({event: 'user.runtime.failed', stage: 'paths', code: 'EACCES'}));
});

it('lets another enrolled device enter the same user data without copying a profile', async () => {
    const file = path.join(temp, 'certs/clients.json'), saved = await readFile(file, 'utf8');
    const policy = JSON.parse(saved) as Record<string, {userId: string}>;
    const fingerprint = Object.keys(policy).find(key => policy[key].userId === 'alice')!;
    policy[fingerprint] = {userId: 'admin'}; await writeFile(file, JSON.stringify(policy));
    try {
        const root = await view(alice.fetcher, 'same-user-device');
        const notes = await root.services.vfs.openFileSystem('/home/admin/notes');
        expect(await notes.driver.readContent('/private.txt', {encoding: 'utf-8'})).toBe('admin-private-content');
        await clients.at(-1)!.close();
    } finally {await writeFile(file, saved);}
});

it('authenticates JSON certificate mappings and revokes them without falling back to clients.json', async () => {
    const certs = path.join(temp, 'certs'), policy = JSON.parse(await readFile(path.join(certs, 'clients.json'), 'utf8')) as Record<string, {userId: string}>;
    const fingerprint = Object.keys(policy).find(key => policy[key].userId === 'alice')!;
    policy[fingerprint] = {userId: 'li'};
    const config = path.join(temp, 'json-config'); await mkdir(config);
    await writeFile(path.join(config, 'nestos.json'), JSON.stringify({http: {usersDir: './data/home', mtls: {clients: policy}}}));
    const settings = await resolveHttpDirectories(config, temp), certificates = await loadCertificates(certs, settings.certificateClients);
    const server = createHttpServer({certificates, multiUser: true, staticDir: path.join(temp, 'ui'), audit: {write() {}, close: async () => {}}});
    const port = await listen(server);
    try {
        expect(await (await alice.fetcher(`https://127.0.0.1:${port}/api/identity`)).json()).toEqual({userId: 'li'});
        const reduced = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== fingerprint));
        await writeFile(path.join(config, 'nestos.json'), JSON.stringify({http: {mtls: {clients: reduced}}}));
        await expect(alice.fetcher(`https://127.0.0.1:${port}/api/identity`)).rejects.toThrow();
        await writeFile(path.join(config, 'nestos.json'), '{}');
        await expect(certificates.users!()).rejects.toMatchObject({code: 'CLIENT_POLICY_INVALID'});
    } finally {await close(server);}
});

it('imports legacy documents, SeqFile values and shared configuration without touching the source', async () => {
    const source = path.join(temp, 'legacy'), server = path.join(temp, 'imported-server'), homes = path.join(server, 'home');
    const legacy = await openLocalFSBackend({rootDir: source, sidecarDir: path.join(source, '_meta'), createDb: file => NodeSqliteSidecarDb.open(file)});
    await legacy.mkdir('/home/admin/notes'); await legacy.write('/home/admin/notes/migrate.txt', new TextEncoder().encode('migrate-content'));
    await legacy.mkdir('/var/lib/sessions'); await legacy.write('/var/lib/sessions/history.seq', new Uint8Array());
    await legacy.records.setRecordField('/var/lib/sessions/history.seq', 'round', {text: 'persisted-round'});
    await legacy.mkdir('/etc/llm'); await legacy.write('/etc/llm/systemprompt', new Uint8Array());
    await legacy.records.setRecordField('/etc/llm/systemprompt', 'test-agent', 'persisted-prompt');
    await legacy.close();
    const options = {source, root: server, usersDir: homes, auditFile: path.join(temp, 'import.jsonl')};
    await importLegacyUser(options);
    expect(await readFile(path.join(homes, 'admin/notes/migrate.txt'), 'utf8')).toBe('migrate-content');
    expect(await readFile(path.join(source, 'home/admin/notes/migrate.txt'), 'utf8')).toBe('migrate-content');
    const meta = await NodeSqliteSidecarDb.open(path.join(homes, 'admin/.nestos/meta/index.db'));
    expect(await meta.getRecordField('/var/lib/sessions/history.seq', 'round')).toEqual({text: 'persisted-round'}); await meta.close();
    const shared = await NodeSqliteSidecarDb.open(path.join(server, 'etc/_meta/llm/index.db'));
    expect(await shared.getRecordField('/systemprompt', 'test-agent')).toBe('persisted-prompt'); await shared.close();
    await expect(importLegacyUser(options)).rejects.toThrow('refuses to overwrite');
    await rename(path.join(homes, 'admin'), path.join(homes, 'saved-admin'));
    await expect(importLegacyUser(options)).rejects.toThrow('refuses to overwrite');
});

it('reopens both user runtimes after moving the complete home directory', async () => {
    for (const client of clients.splice(0)) await client.close();
    await host.close();
    const moved = path.join(temp, 'moved-home'); await rename(path.join(temp, 'home'), moved);
    host = await startHost({root: path.join(temp, 'server'), sidecar: path.join(temp, 'unused-meta'), authDir: path.join(temp, 'unused-auth'),
        usersDir: moved, staticDir: path.join(temp, 'ui'), auditFile: path.join(temp, 'audit.jsonl'), certificates: await loadCertificates(path.join(temp, 'certs')),
        port: 0, host: '127.0.0.1', backlog: 32});
    const a = await view(admin.fetcher, 'moved-admin'), b = await view(alice.fetcher, 'moved-alice');
    const read = async (root: typeof a) => (await root.services.vfs.openFileSystem('/home/admin/notes')).driver.readContent('/private.txt', {encoding: 'utf-8'});
    expect(await read(a)).toBe('admin-private-content'); expect(await read(b)).toBe('alice-private-content');
    const providerId = a.services.agentService.getProviders()[0].id;
    expect((await a.services.agentService.getFullProvider(providerId))?.apiKey).toBe('shared-secret-test');
    expect((await b.services.agentService.getFullProvider(providerId))?.apiKey).toBeUndefined();
    const toolbox = await b.backend.toolboxView();
    expect(toolbox.inventory.providers.get(providerId)?.configured).toBe(true);
    expect((await b.services.projects.sessions.navigation()).sessions.some(session => session.title === 'admin-private-session')).toBe(false);
});
