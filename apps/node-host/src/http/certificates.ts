import { X509Certificate, constants, timingSafeEqual } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';

export interface CertificateAuth {
    tls: ServerOptions;
    accepts(socket: TLSSocket): Promise<boolean>;
    identity?(socket: TLSSocket): Promise<string | undefined>;
    users?(): Promise<string[]>;
}

export async function loadCertificates(directory: string, readClients?: () => Promise<unknown>): Promise<CertificateAuth> {
    const [key, cert, ca] = await Promise.all(['server.key', 'server.crt', 'ca.crt'].map(file => readFile(path.join(directory, file))));
    const keyMode = await lstat(path.join(directory, 'server.key'));
    if (keyMode.isSymbolicLink() || (keyMode.mode & 0o077)) throw new Error('Server private key must be a private regular file (0600)');
    const allowFile = path.join(directory, 'clients.json');
    const readEnrollment = async () => readClients ? parseEnrollments(await readClients()) : enrollments(allowFile);
    await readEnrollment();
    const certificate = new X509Certificate(cert);
    if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('Server certificate expired');
    const identity = async (socket: TLSSocket): Promise<string | undefined> => {
        if (!socket.authorized) return;
        const peer = socket.getPeerCertificate();
        if (!peer.raw) return;
        const identity = new X509Certificate(peer.raw), now = Date.now();
        if (Date.parse(identity.validFrom) > now || Date.parse(identity.validTo) <= now) return;
        const actual = identity.fingerprint256.replaceAll(':', '').toLowerCase();
        return (await readEnrollment()).find(([value]) => timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(actual, 'hex')))?.[1];
    };
    return { tls: { key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: 10000,
        secureOptions: constants.SSL_OP_NO_TICKET }, identity, accepts: async socket => Boolean(await identity(socket)),
        users: async () => [...new Set((await readEnrollment()).map(([, user]) => user))] };
}

export function validUserId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

async function enrollments(file: string): Promise<Array<[string, string]>> {
    const source = await readFile(file, 'utf8');
    let value: unknown;
    try {value = JSON.parse(source);}
    catch {throw Object.assign(new Error('Invalid client enrollment JSON'), {code: 'CLIENT_POLICY_INVALID'});}
    return parseEnrollments(value);
}
function parseEnrollments(value: unknown): Array<[string, string]> {
    const entries = Array.isArray(value) ? value.map(fingerprint => [fingerprint, 'admin'])
        : value && typeof value === 'object' ? Object.entries(value).map(([fingerprint, user]) => [fingerprint,
            user && typeof user === 'object' ? (user as {userId?: unknown}).userId : undefined]) : [];
    if (!entries.length || entries.length > 100 || entries.some(([fingerprint, user]) =>
        typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) || !validUserId(user))) {
        throw Object.assign(new Error('Expected explicitly allowed certificate fingerprints with valid userId mappings'), {code: 'CLIENT_POLICY_INVALID'});
    }
    return entries as Array<[string, string]>;
}
