import { mkdir, realpath, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Server } from 'node:http';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from './sqlite-sidecar';
import { createHttpServer } from './http-server';
import { createStorageServer } from './storage-server';
import { loadCertificates } from './certificates';
import { createCertificates } from './create-certificates';
import { AuditLog } from './audit-log';
import { configDirectory, resolveDataRoot } from './profile';
import { options } from './options';
import { createApplicationApi } from './application-host';

async function main(): Promise<void> {
    const values = options();
    if (values.help) { console.log('MindOS HTTPS defaults: --host 0.0.0.0 --port 2000 --internal-port 2001 --backlog 4096\n  Data root: --root > MINDOS_ROOT > mindos.json rootDir > <configDir>/data\n  Config: $XDG_CONFIG_HOME/mindos/mindos.json or ~/.config/mindos/mindos.json\n  --cert-dir <private directory> --init-certs --cert-host <IP or hostname>\n  --sidecar <directory> --static <UI directory> --audit-file <JSONL file>'); return; }
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
    await access(path.join(staticDir, 'index.html')); await mkdir(root, { recursive: true }); await mkdir(sidecar, { recursive: true });
    const canonicalRoot = await realpath(root), canonicalSidecar = await realpath(sidecar);
    const canonicalCertificates = await realpath(certDir);
    protectPaths(canonicalRoot, canonicalSidecar, canonicalCertificates, auditFile);
    if (within(await realpath(staticDir), canonicalCertificates)) throw new Error('Certificates cannot reside within the static UI root');
    const certificates = await loadCertificates(certDir), port = validPort(values.port), internalPort = validPort(values['internal-port']);
    if (port === internalPort) throw new Error('Public and internal ports must differ');
    await startHost({ root: canonicalRoot, sidecar: canonicalSidecar, certificates, staticDir, auditFile, port, internalPort, host: values.host, backlog });
}

interface HostOptions {
    root: string; sidecar: string; certificates: Awaited<ReturnType<typeof loadCertificates>>; staticDir: string;
    auditFile: string; port: number; internalPort: number; host: string; backlog: number;
}
async function startHost({ root, sidecar, certificates, staticDir, auditFile, port, internalPort, host, backlog }: HostOptions): Promise<void> {
    const backend = await openLocalFSBackend({ rootDir: root, sidecarDir: sidecar,
        durability: 'full', createDb: file => NodeSqliteSidecarDb.open(file) });
    const audit = new AuditLog(auditFile), token = randomBytes(32).toString('base64url');
    try { await audit.initialize(); } catch (error) { await backend.close(); throw error; }
    const applicationApi = createApplicationApi(backend);
    const internal = createStorageServer(backend, root, token, audit);
    const server = createHttpServer({ certificates, staticDir, internalPort, internalToken: token, audit, application: applicationApi });
    try { await listen(internal, internalPort, '127.0.0.1', backlog); await listen(server, port, host, backlog); }
    catch (error) { applicationApi?.endStreams(); await stopServers([server, internal]); await applicationApi?.close().catch(() => {}); await backend.close(); await audit.close(); throw error; }
    installShutdown([server, internal], async () => {
        const errors: unknown[] = [];
        await applicationApi.close().catch(error => errors.push(error)); await backend.close().catch(error => errors.push(error));
        audit.write({ event: 'server.stopped' }); await audit.close().catch(error => errors.push(error));
        if (errors.length) throw new AggregateError(errors, 'Host cleanup failed');
    }, () => applicationApi.endStreams());
    audit.write({ event: 'server.started', route: `https://${host}:${port}` });
    console.log(`MindOS HTTPS UI: https://${host}:${port}\nVFS internal: 127.0.0.1:${internalPort}\nClient certificate required\nAudit log: ${auditFile}`);
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
