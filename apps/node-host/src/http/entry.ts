import { startHost } from './start-host';
import { mkdir, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import { loadCertificates } from './certificates';
import { createCertificates } from './create-certificates';
import { configDirectory, resolveDataRoot, resolveHttpDirectories } from '../runtime/profile';
import { options } from './options';

export async function runHttpHost(args = process.argv.slice(2), defaultStaticDir?: string, logMode = process.env.MINDOS_HTTPD_MODE ?? 'standalone'): Promise<void> {
    const values = options(args);
    if (values.help) { console.log('MindOS HTTPS defaults: --host 0.0.0.0 --port 2000 --backlog 4096\n  Data root: --root > MINDOS_ROOT > mindos.json rootDir > <configDir>/data\n  Config: $XDG_CONFIG_HOME/mindos/mindos.json or ~/.config/mindos/mindos.json\n  mindos.json: http.certDir / http.authDir (config-relative paths; flags override)\n  --cert-dir <private directory> --init-certs --cert-host <IP or hostname>\n  --sidecar <directory> --static <UI directory> --audit-file <JSONL file> --auth-dir <private directory>'); return; }
    const backlog = validBacklog(values.backlog);
    const cwd = process.env.INIT_CWD ?? process.cwd(), config = configDirectory();
    const {certDir, authDir: authPath} = await resolveHttpDirectories(config, cwd,
        {certDir: values['cert-dir'], authDir: values['auth-dir']}, logMode);
    if (values['init-certs']) {
        await createCertificates(certDir, (values['cert-host'] ?? (values.host === '0.0.0.0' || values.host === '::' ? '127.0.0.1' : values.host)).split(',').map(host => host.trim()));
        console.log(`Certificates created: ${certDir}\nBrowser identity: ${path.join(certDir, 'browser-client.p12')}\nImport password file: ${path.join(certDir, 'client-password.txt')}`); return;
    }
    const root = await resolveDataRoot(config, cwd, values.root), sidecar = path.resolve(cwd, values.sidecar ?? path.join(root, '_meta'));
    const staticDir = values.static ? path.resolve(cwd, values.static) : defaultStaticDir ?? (() => { throw new Error('Expected --static UI directory'); })();
    const auditFile = path.resolve(cwd, values['audit-file'] ?? path.join(config, 'logs', 'http', `httpd-${logMode}-audit.jsonl`));
    await mkdir(authPath, { recursive: true, mode: 0o700 });
    const authDir = await realpath(authPath);
    await access(path.join(staticDir, 'index.html')); await mkdir(root, { recursive: true }); await mkdir(sidecar, { recursive: true });
    const canonicalRoot = await realpath(root), canonicalSidecar = await realpath(sidecar);
    const canonicalCertificates = await realpath(certDir);
    protectPaths(canonicalRoot, canonicalSidecar, canonicalCertificates, auditFile);
    if (within(canonicalRoot, authDir) || within(await realpath(staticDir), authDir)) throw new Error('OAuth credentials must remain outside data and static roots');
    if (within(await realpath(staticDir), canonicalCertificates)) throw new Error('Certificates cannot reside within the static UI root');
    const certificates = await loadCertificates(certDir), port = validPort(values.port);
    const hosted = await startHost({ root: canonicalRoot, sidecar: canonicalSidecar, certificates, staticDir, auditFile, authDir, logMode, port, host: values.host, backlog });
    installShutdown(hosted);
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
function installShutdown(hosted: Awaited<ReturnType<typeof startHost>>): void {
    let stopping = false;
    const stop = () => {
        if (stopping) return; stopping = true;
        void hosted.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    hosted.server.on('error', stop);
}
