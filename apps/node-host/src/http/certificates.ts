import { X509Certificate, constants, timingSafeEqual } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';

export interface CertificateAuth {
    tls: ServerOptions;
    accepts(socket: TLSSocket): Promise<boolean>;
}

export async function loadCertificates(directory: string): Promise<CertificateAuth> {
    const [key, cert, ca] = await Promise.all(['server.key', 'server.crt', 'ca.crt'].map(file => readFile(path.join(directory, file))));
    const keyMode = await lstat(path.join(directory, 'server.key'));
    if (keyMode.isSymbolicLink() || (keyMode.mode & 0o077)) throw new Error('Server private key must be a private regular file (0600)');
    const allowFile = path.join(directory, 'clients.json');
    await fingerprints(allowFile);
    const certificate = new X509Certificate(cert);
    if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('Server certificate expired');
    return { tls: { key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: 10000,
        secureOptions: constants.SSL_OP_NO_TICKET }, accepts: async socket => {
        if (!socket.authorized) return false;
        const peer = socket.getPeerCertificate();
        if (!peer.raw) return false;
        const identity = new X509Certificate(peer.raw), now = Date.now();
        if (Date.parse(identity.validFrom) > now || Date.parse(identity.validTo) <= now) return false;
        const actual = identity.fingerprint256.replaceAll(':', '').toLowerCase();
        return (await fingerprints(allowFile)).some(value => timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(actual, 'hex')));
    } };
}

async function fingerprints(file: string): Promise<string[]> {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) {
        throw new Error('Expected at least one explicitly allowed client certificate fingerprint');
    }
    return value;
}
