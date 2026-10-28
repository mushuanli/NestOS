import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, connect } from 'node:net';
import { request } from 'node:https';
import { VFSAgentService } from '../../../backend/llm-session/src/index';
import { startHost, type HttpHostOptions } from '@itookit/node-host/http';
import { createCertificates } from '@itookit/node-host/http';
import { loadCertificates } from '@itookit/node-host/http';
import { acquireHostLock } from '@itookit/node-host/storage';
import { authenticatedFetch } from './tls-fixture';

let directory: string, certificates: HttpHostOptions['certificates'];
const cleanups: Array<() => unknown> = [];
beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'httpd-startup-'));
    await createCertificates(path.join(directory, 'certs'), ['127.0.0.1']);
    certificates = await loadCertificates(path.join(directory, 'certs'));
});
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function options(): Promise<HttpHostOptions> {
    const root = await mkdtemp(path.join(directory, 'data-')), staticDir = path.join(directory, 'ui');
    await mkdir(staticDir, { recursive: true }); await writeFile(path.join(staticDir, 'index.html'), '<title>Ready</title>');
    const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
    return { root, sidecar: path.join(root, '_meta'), certificates, staticDir, port, host: '127.0.0.1', backlog: 32,
        auditFile: path.join(directory, path.basename(root) + '.jsonl'), authDir: path.join(directory, path.basename(root) + '-auth') };
}
function connected(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1'); socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('TCP probe timed out')); });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', error => { if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false); else reject(error); });
    });
}
it('keeps the TCP port closed until application initialization completes, then serves ready health', async () => {
    const values = await options(), original = VFSAgentService.prototype.init;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(release);
    const initialize = vi.spyOn(VFSAgentService.prototype, 'init').mockImplementation(async function (this: VFSAgentService) { await gate; await original.call(this); });
    const opening = startHost(values); cleanups.push(async () => { release(); await opening.then(host => host.close()); });
    await vi.waitFor(() => expect(initialize).toHaveBeenCalled());
    expect(await connected(values.port)).toBe(false);
    release(); const host = await opening; expect(host.server.listening).toBe(true);
    expect(warning).toHaveBeenCalledWith('\u001b[1;31m【单用户模式：admin】所有访问均操作同一份 admin 数据。\u001b[0m');
    const auth = await authenticatedFetch(path.join(directory, 'certs')); cleanups.push(auth.close);
    expect(await (await auth.fetcher(`https://127.0.0.1:${values.port}/api/health`)).json()).toMatchObject({ ready: true });
});
it('rejects failed initialization without listening and releases data and credential locks', async () => {
    const values = await options();
    vi.spyOn(VFSAgentService.prototype, 'init').mockRejectedValue(new Error('Agent configuration unavailable'));
    await expect(startHost(values)).rejects.toThrow('Agent configuration unavailable');
    expect(await connected(values.port)).toBe(false);
    for (const where of [path.join(values.root, '_meta'), values.authDir]) (await acquireHostLock(where))();
});
it('closes a stalled HTTPS request and releases both locks before a replacement host starts', async () => {
    const values = await options(), host = await startHost(values); cleanups.push(() => host.close());
    const [ca, cert, key] = await Promise.all(['ca.crt', 'client.crt', 'client.key'].map(name => readFile(path.join(directory, 'certs', name))));
    const accepted = new Promise<void>(resolve => host.server.once('request', () => resolve()));
    const outgoing = request(`https://127.0.0.1:${values.port}/api/application`, {ca, cert, key, agent: false, method: 'POST',
        headers: {'Content-Type': 'application/json', 'Content-Length': '100'}});
    outgoing.on('error', () => {}); cleanups.push(() => outgoing.destroy());
    const disconnected = new Promise<void>(resolve => outgoing.once('close', resolve));
    outgoing.write('{'); await accepted;
    for (const where of [path.join(values.root, '_meta'), values.authDir]) await expect(acquireHostLock(where)).rejects.toThrow('another application host');
    await host.close(); await disconnected;
    expect(host.server.listening).toBe(false);
    for (const where of [path.join(values.root, '_meta'), values.authDir]) (await acquireHostLock(where))();
    const replacement = await startHost(values); cleanups.push(() => replacement.close());
    expect(replacement.server.listening).toBe(true);
}, 15000);
