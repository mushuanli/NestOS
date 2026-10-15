import { openHostRuntime, closeHostResources, type HostCleanup } from './host-runtime';
import { mkdir, realpath, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Server } from 'node:http';
import { createHttpServer } from './http-server';
import { loadCertificates } from './certificates';
import { createCertificates } from './create-certificates';
import { configDirectory, resolveDataRoot } from './profile';
import { options } from './options';
import { createApplicationApi } from './application-host';

async function main(): Promise<void> {
    const values = options();
    if (values.help) { console.log('MindOS HTTPS defaults: --host 0.0.0.0 --port 2000 --backlog 4096\n  Data root: --root > MINDOS_ROOT > mindos.json rootDir > <configDir>/data\n  Config: $XDG_CONFIG_HOME/mindos/mindos.json or ~/.config/mindos/mindos.json\n  --cert-dir <private directory> --init-certs --cert-host <IP or hostname>\n  --sidecar <directory> --static <UI directory> --audit-file <JSONL file> --auth-dir <private directory>'); return; }
    const backlog = validBacklog(values.backlog);
    const cwd = process.env.INIT_CWD ?? process.cwd(), config = configDirectory();
    const certDir = path.resolve(cwd, values['cert-dir'] ?? path.join(config, 'http-certs'));
    if (values['init-certs']) {
        await createCertificates(certDir, (values['cert-host'] ?? (values.host === '0.0.0.0' || values.host === '::' ? '127.0.0.1' : values.host)).split(',').map(host => host.trim()));
        console.log(`Certificates created: ${certDir}\nBrowser identity: ${path.join(certDir, 'browser-client.p12')}\nImport password file: ${path.join(certDir, 'client-password.txt')}`); return;
    }
    const root = await resolveDataRoot(config, cwd, values.root), sidecar = path.resolve(cwd, values.sidecar ?? path.join(root, '_meta'));
    const staticDir = values.static ? path.resolve(cwd, values.static) : fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/' : '../dist/', import.meta.url));
    const auditFile = path.resolve(cwd, values['audit-file'] ?? path.join(config, 'logs', 'http', 'audit.jsonl'));
    const authPath = path.resolve(cwd, values['auth-dir'] ?? path.join(config, 'http-auth'));
    await mkdir(authPath, { recursive: true, mode: 0o700 });
    const authDir = await realpath(authPath);
    await access(path.join(staticDir, 'index.html')); await mkdir(root, { recursive: true }); await mkdir(sidecar, { recursive: true });
    const canonicalRoot = await realpath(root), canonicalSidecar = await realpath(sidecar);
    const canonicalCertificates = await realpath(certDir);
    protectPaths(canonicalRoot, canonicalSidecar, canonicalCertificates, auditFile);
    if (within(canonicalRoot, authDir) || within(await realpath(staticDir), authDir)) throw new Error('OAuth credentials must remain outside data and static roots');
    if (within(await realpath(staticDir), canonicalCertificates)) throw new Error('Certificates cannot reside within the static UI root');
    const certificates = await loadCertificates(certDir), port = validPort(values.port);
    await startHost({ root: canonicalRoot, sidecar: canonicalSidecar, certificates, staticDir, auditFile, authDir, port, host: values.host, backlog });
}

interface HostOptions {
    root: string; sidecar: string; certificates: Awaited<ReturnType<typeof loadCertificates>>; staticDir: string;
    auditFile: string; authDir: string; port: number; host: string; backlog: number;
}
async function startHost(options: HostOptions): Promise<void> {
    const cleanup: HostCleanup = [];
    try {
        const runtime = await openHostRuntime(options); cleanup.push(runtime.close);
        const { backend, audit, authorization } = runtime;
        const applicationApi = createApplicationApi(backend, options.root, audit, authorization);
        cleanup.push(() => applicationApi.close());
        const server = createHttpServer({ certificates: options.certificates, staticDir: options.staticDir, audit, application: applicationApi,
            build: { mode: process.env.MINDOS_HTTPD_MODE ?? 'standalone', version: process.env.MINDOS_HTTPD_VERSION } });
        cleanup.push(async () => { applicationApi.endStreams(); await stopServers([server]); });
        await listen(server, options.port, options.host, options.backlog);
        installShutdown([server], async () => { audit.write({ event: 'server.stopped' }); await closeHostResources(cleanup); }, () => applicationApi.endStreams());
        audit.write({ event: 'server.started', route: `https://${options.host}:${options.port}` });
        console.log(`MindOS HTTPS UI: https://${options.host}:${options.port}\nClient certificate required\nAudit log: ${options.auditFile}`);
    } catch (error) {
        try { await closeHostResources(cleanup); } catch { /* Preserve the startup error. */ }
        throw error;
    }
}

function protectPaths(root: string, sidecar: string, certificates: string, log: string): void {
    if (within(root, sidecar) && sidecar !== path.join(root, '_meta')) throw new Error('Sidecar must be <root>/_meta or outside the VFS data root');
    if (within(root, certificates) || within(root, log)) throw new Error('Certificates and audit logs must remain outside the VFS data root');
}
function within(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function validPort(value: string): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a port between 1 and 65535');
    return port;
}
function validBacklog(value: string): number {
    const backlog = Number(value);
    if (!Number.isInteger(backlog) || backlog < 1 || backlog > 2147483647) throw new Error('Expected backlog between 1 and 2147483647');
    return backlog;
}
function listen(server: Server, port: number, host: string, backlog: number): Promise<void> {
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port, host, backlog }, () => { server.off('error', reject); resolve(); }); });
}
async function stopServers(servers: Server[]): Promise<void> {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); })));
}
function installShutdown(servers: Server[], cleanup: () => Promise<void>, beforeStop: () => void = () => {}): void {
    let stopping = false;
    const stop = () => {
        if (stopping) return; stopping = true; beforeStop();
        void stopServers(servers).then(cleanup).then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    for (const server of servers) server.on('error', stop);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
