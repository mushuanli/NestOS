import { startHost } from './start-host';
import { mkdir, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import { loadCertificates } from './certificates';
import {createUserCertificate} from './create-user-certificate';
import { createCertificates } from './create-certificates';
import {ensureStartupCertificates, protectCertificateDirectory, reportCertificateFiles} from './startup-certificates';
import { resolveHttpConfigDirectory, configurationFilePath, resolveDataRoot, resolveHttpDirectories } from '../runtime/profile';
import { options } from './options';
import {importLegacyUser} from './import-legacy-user';
import {canonical} from '../runtime/paths';
const canonicalPath = (value: string, cwd: string) => canonical(path.resolve(cwd, value));

export async function runHttpHost(args = process.argv.slice(2), defaultStaticDir?: string, logMode = process.env.NESTOS_HTTPD_MODE ?? 'standalone'): Promise<void> {
    const values = options(args);
    if (values.help) { console.log('NestOS HTTPS defaults: --host 0.0.0.0 --port 2000 --backlog 4096\n  Data root: --root > NESTOS_ROOT > nestos.json rootDir > <configDir>/data\n  Config: launch directory/nestos.json > $XDG_CONFIG_HOME/nestos/nestos.json or ~/.config/nestos/nestos.json\n  nestos.json: http.certDir / http.authDir / http.usersDir / http.mtls.clients (paths are config-relative; flags override)\n  --cert-dir <private directory> --init-certs --cert-host <IP or hostname>\n  --create-user-cert <userId> (issue a separate browser identity using the existing CA)\n  --import-legacy-root <old root> [--import-legacy-auth-dir <old auth>] (offline copy into admin; requires http.usersDir or --users-dir)\n  --users-dir <directory> (enable isolated per-user bundles; http.mtls.clients maps certificates to userId)\n  --sidecar <directory> --static <UI directory> --audit-file <JSONL file> --auth-dir <private directory>'); return; }
    const backlog = validBacklog(values.backlog);
    const cwd = process.env.INIT_CWD ?? process.cwd(), selected = resolveHttpConfigDirectory(cwd), config = selected.directory;
    console.log(`[HTTP] Config: ${configurationFilePath(config)} (${selected.source})`);
    const {certDir, authDir: authPath, editorSwap, usersDir, certificateClients} = await resolveHttpDirectories(config, cwd,
        {certDir: values['cert-dir'], authDir: values['auth-dir'], usersDir: values['users-dir']}, logMode);
    const root = await resolveDataRoot(config, cwd, values.root), sidecar = path.resolve(cwd, values.sidecar ?? path.join(root, '_meta'));
    const configuredStatic = values.static ? path.resolve(cwd, values.static) : defaultStaticDir;
    const certificateHosts = values['cert-host'] ?? (values.host === '0.0.0.0' || values.host === '::' ? '127.0.0.1' : values.host);
    await protectCertificateDirectory(certDir, root, configuredStatic);
    if (values['import-legacy-root']) {
        if (!usersDir) throw new Error('Legacy import requires http.usersDir or --users-dir');
        await importLegacyUser({source: path.resolve(cwd, values['import-legacy-root']),
            sourceAuth: values['import-legacy-auth-dir'] ? path.resolve(cwd, values['import-legacy-auth-dir']) : undefined,
            root, usersDir,
            auditFile: path.resolve(cwd, values['audit-file'] ?? path.join(config, 'logs', 'http', 'user-import.jsonl'))});
        console.log('Legacy data copied into the admin bundle and shared configuration. Source data preserved.'); return;
    }
    if (values['create-user-cert']) {
        const certificate = await createUserCertificate(certDir, values['create-user-cert']);
        console.log(`User: ${certificate.userId}\nSHA-256: ${certificate.fingerprint}\nBrowser identity: ${certificate.bundleFile}\nPassword file: ${certificate.passwordFile}`); return;
    }
    if (values['init-certs']) {
        await createCertificates(certDir, certificateHosts.split(',').map(host => host.trim()));
        reportCertificateFiles(certDir); return;
    }
    const staticDir = values.static ? path.resolve(cwd, values.static) : defaultStaticDir ?? (() => { throw new Error('Expected --static UI directory'); })();
    await ensureStartupCertificates(certDir, certificateHosts);
    const auditFile = path.resolve(cwd, values['audit-file'] ?? path.join(config, 'logs', 'http', `httpd-${logMode}-audit.jsonl`));
    await mkdir(authPath, { recursive: true, mode: 0o700 });
    const authDir = await realpath(authPath);
    await access(path.join(staticDir, 'index.html')); await mkdir(root, { recursive: true }); await mkdir(sidecar, { recursive: true });
    const canonicalRoot = await realpath(root), canonicalSidecar = await realpath(sidecar);
    const canonicalCertificates = await realpath(certDir);
    protectPaths(canonicalRoot, canonicalSidecar, canonicalCertificates, auditFile);
    if (within(canonicalRoot, authDir) || within(await realpath(staticDir), authDir)) throw new Error('OAuth credentials must remain outside data and static roots');
    if (within(await realpath(staticDir), canonicalCertificates)) throw new Error('Certificates cannot reside within the static UI root');
    if (usersDir && (within(await canonicalPath(usersDir, cwd), canonicalCertificates) || within(await canonicalPath(usersDir, cwd), authDir)))
        throw new Error('Server certificates and legacy authorization must remain outside user bundles');
    const certificates = await loadCertificates(certDir, certificateClients), port = validPort(values.port);
    const hosted = await startHost({ root: canonicalRoot, sidecar: canonicalSidecar, certificates, staticDir, auditFile, authDir, editorSwap, logMode, port, host: values.host, backlog, usersDir });
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
