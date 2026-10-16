import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, connect } from 'node:net';
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
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(release);
    const initialize = vi.spyOn(VFSAgentService.prototype, 'init').mockImplementation(async function (this: VFSAgentService) { await gate; await original.call(this); });
    const opening = startHost(values); cleanups.push(async () => { release(); await opening.then(host => host.close()); });
    await vi.waitFor(() => expect(initialize).toHaveBeenCalled());
    expect(await connected(values.port)).toBe(false);
    release(); const host = await opening; expect(host.server.listening).toBe(true);
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
