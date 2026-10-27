import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { randomBytes, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Initialize a private local CA and browser identity without exposing any secrets in argv or logs. */
export async function createCertificates(directory: string, hosts: string[]): Promise<void> {
    if (!hosts.length || hosts.some(host => !isIP(host) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) throw new Error('Expected IP addresses or DNS hostnames');
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await createDirectory(directory);
    const run = (args: string[]) => execute('openssl', args, { cwd: directory }).catch(() => { throw new Error('Certificate generation failed; check that OpenSSL is installed'); });
    await run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
        '-days', '3650', '-subj', '/CN=NestOS Local CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    const names = [...new Set([...hosts, 'localhost', '127.0.0.1'])].map(host => `${isIP(host) ? 'IP' : 'DNS'}:${host}`).join(',');
    await issue(run, directory, 'server', `subjectAltName=${names}\nextendedKeyUsage=serverAuth`);
    await issue(run, directory, 'client', 'extendedKeyUsage=clientAuth');
    await writeFile(path.join(directory, 'client-password.txt'), randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' });
    await run(['pkcs12', '-export', '-out', 'browser-client.p12', '-inkey', 'client.key', '-in', 'client.crt', '-certfile', 'ca.crt',
        '-name', 'NestOS browser', '-passout', 'file:client-password.txt']);
    const certificate = new X509Certificate(await readFile(path.join(directory, 'client.crt')));
    await writeFile(path.join(directory, 'clients.json'), JSON.stringify([certificate.fingerprint256.replaceAll(':', '').toLowerCase()]) + '\n', { mode: 0o600 });
    await Promise.all(['ca.key', 'server.key', 'client.key', 'browser-client.p12'].map(file => chmod(path.join(directory, file), 0o600)));
}

async function createDirectory(directory: string): Promise<void> {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new Error(`Certificate directory already exists: ${directory}. Initialization refuses to overwrite existing certificates. Reuse this directory when starting the server with --cert-dir, or initialize in a new directory with --cert-dir.`);
    }
}

async function issue(run: (args: string[]) => Promise<unknown>, directory: string, name: string, extensions: string): Promise<void> {
    await run(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=NestOS ${name}`]);
    await writeFile(path.join(directory, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n${extensions}\n`);
    await run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '365', '-extfile', `${name}.ext`]);
}
