import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { openLocalFSBackend, type LocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { createCertificates } from '@itookit/node-host/http';
import { loadCertificates } from '@itookit/node-host/http';
import { AuditLog } from '@itookit/node-host/logging';
import { secureServers, authenticatedFetch, close } from './tls-fixture';

let temp: string, certificates: string, untrusted: string, backend: LocalFSBackend;
let host: Awaited<ReturnType<typeof secureServers>>, client: Awaited<ReturnType<typeof authenticatedFetch>>;
const execute = promisify(execFile);
beforeAll(async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'nestos-mtls-'));
    certificates = path.join(temp, 'trusted'); untrusted = path.join(temp, 'untrusted');
    await createCertificates(certificates, ['127.0.0.1']); await createCertificates(untrusted, ['127.0.0.1']);
    await writeFile(path.join(certificates, 'expired-index.txt'), ''); await writeFile(path.join(certificates, 'expired-serial.txt'), '01');
    await writeFile(path.join(certificates, 'expired-ca.cnf'), '[ca]\ndefault_ca=local\n[local]\ndatabase=expired-index.txt\nserial=expired-serial.txt\nnew_certs_dir=.\ncertificate=ca.crt\nprivate_key=ca.key\ndefault_md=sha256\npolicy=names\n[names]\ncommonName=supplied\n');
    await execute('openssl', ['ca', '-batch', '-config', 'expired-ca.cnf', '-in', 'client.csr', '-out', 'expired.crt',
        '-startdate', '20000101000000Z', '-enddate', '20010101000000Z', '-extfile', 'client.ext'], { cwd: certificates });
});
afterAll(async () => { await rm(temp, { recursive: true, force: true }); });
beforeEach(async () => {
    const certificate = new X509Certificate(await readFile(path.join(certificates, 'client.crt')));
    await writeFile(path.join(certificates, 'clients.json'), JSON.stringify([certificate.fingerprint256.replaceAll(':', '').toLowerCase()]));
    const root = await mkdtemp(path.join(temp, 'data-')), ui = path.join(root, 'ui');
    await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<title>Private NestOS</title>');
    await mkdir(path.join(ui, 'assets')); await writeFile(path.join(ui, 'assets/chat.js'), 'private module');
    backend = await openLocalFSBackend({ rootDir: root, sidecarDir: path.join(temp, path.basename(root) + '-meta'), createDb: file => NodeSqliteSidecarDb.open(file) });
    host = await secureServers(backend, root, ui, certificates); client = await authenticatedFetch(certificates);
});
afterEach(async () => { client.close(); await close(host.server); await backend.close(); });

async function requestWithIdentity(route: string, directory?: string, certificate = 'client.crt'): Promise<number> {
    const ca = await readFile(path.join(certificates, 'ca.crt'));
    const identity = directory ? { cert: await readFile(path.join(directory, certificate)), key: await readFile(path.join(directory, 'client.key')) } : {};
    return new Promise((resolve, reject) => {
        const outgoing = request(host.origin + route, { ca, ...identity, agent: false }, response => { response.resume(); resolve(response.statusCode!); });
        outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Test request timed out')));
        outgoing.once('error', reject); outgoing.end();
    });
}
it('rejects missing certificates before serving UI, assets, health or VFS', async () => {
    for (const route of ['/', '/assets/chat.js', '/api/health', '/api/vfs']) await expect(requestWithIdentity(route)).rejects.toThrow();
    expect(host.events.some(event => event.event === 'auth.rejected')).toBe(true);
    expect(host.events.some(event => event.event === 'request.complete')).toBe(false);
});
it('rejects untrusted and expired identities at TLS without falling back to public access', async () => {
    await expect(requestWithIdentity('/', untrusted)).rejects.toThrow();
    await expect(requestWithIdentity('/', certificates, 'expired.crt')).rejects.toThrow();
    expect(host.events.some(event => event.event === 'request.complete')).toBe(false);
});
it('allows an enrolled identity and revokes it on the next request even on an existing connection', async () => {
    expect((await client.fetcher(host.origin)).status).toBe(200);
    expect(await (await client.fetcher(host.origin + '/api/health')).json()).toEqual({ ready: true });
    await writeFile(path.join(certificates, 'clients.json'), JSON.stringify(['0'.repeat(64)]));
    await expect(client.fetcher(host.origin + '/api/health')).rejects.toThrow();
    await expect(requestWithIdentity('/')).rejects.toThrow();
    expect(host.events.some(event => event.event === 'auth.accepted')).toBe(true);
    expect(host.events.some(event => event.code === 'CLIENT_CERTIFICATE_NOT_ENROLLED')).toBe(true);
});
it('blocks cross-site authenticated writes and never logs request bodies, credentials or query parameters', async () => {
    const response = await client.fetcher(host.origin + '/api/vfs?password=private-query', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ method: 'write', args: ['/private', 'private-body'] }) });
    expect(response.status).toBe(403);
    await vi.waitFor(() => expect(host.events.some(event => event.event === 'request.complete')).toBe(true));
    const encoded = JSON.stringify(host.events);
    expect(encoded).not.toMatch(/private-query|private-body|Bearer|BEGIN PRIVATE KEY/);
    expect(encoded).toContain('request.complete'); expect(encoded).toContain('EACCES');
});
it('refuses to initialize without an explicit certificate policy', async () => {
    await expect(loadCertificates(path.join(temp, 'missing'))).rejects.toThrow();
    await writeFile(path.join(certificates, 'clients.json'), '[]');
    await expect(loadCertificates(certificates)).rejects.toThrow('explicitly allowed');
});
it('writes private structured audit files with bounded rotation', async () => {
    const file = path.join(temp, 'logs', 'audit.jsonl'), audit = new AuditLog(file, 180);
    for (let index = 0; index < 10; index++) audit.write({ event: 'request.complete', status: 200, durationMs: index });
    await audit.close();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const content = await readFile(file, 'utf8'); expect(JSON.parse(content.trim())).toMatchObject({ event: 'request.complete', status: 200 });
    expect((await stat(file + '.3')).size).toBeGreaterThan(0);
    await expect(stat(file + '.4')).rejects.toThrow();
});
