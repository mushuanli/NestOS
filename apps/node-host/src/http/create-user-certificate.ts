import {execFile} from 'node:child_process';
import {mkdir, readFile, writeFile, chmod, rm, realpath} from 'node:fs/promises';
import {randomBytes, X509Certificate} from 'node:crypto';
import path from 'node:path';
import {promisify} from 'node:util';
import {validUserId} from './certificates';
import {privateDirectory} from '../runtime/paths';
import {createModuleLogger} from '@itookit/common';

const execute = promisify(execFile), log = createModuleLogger('http-certificates');
/** Issue a new device identity without replacing the CA, server certificate or existing users. */
export async function createUserCertificate(directory: string, userId: string) {
    if (!validUserId(userId)) throw new Error('Expected a valid userId for certificate issuance');
    const caDirectory = await realpath(directory), parent = await privateDirectory(path.join(caDirectory, 'users'));
    const target = path.join(parent, userId), started = Date.now(), operationId = randomBytes(16).toString('hex');
    let created = false;
    try {
        await mkdir(target, {mode: 0o700}); created = true;
        log.info('certificate.user.issue', {operationId, userId, stage: 'issue', result: 'started'});
        await issueCertificate(caDirectory, target, userId);
        const certificate = new X509Certificate(await readFile(path.join(target, 'client.crt')));
        log.info('certificate.user.issue', {operationId, userId, stage: 'complete', result: 'success', durationMs: Date.now() - started});
        return {userId, fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
            certificateFile: path.join(target, 'client.crt'), bundleFile: path.join(target, 'browser-client.p12'), passwordFile: path.join(target, 'client-password.txt')};
    } catch (error) {
        log.warn('certificate.user.issue', {operationId, userId, stage: 'issue', result: 'failure',
            code: issueErrorCode(error), durationMs: Date.now() - started});
        if (created) await rm(target, {recursive: true, force: true});
        throw error;
    }
}
async function issueCertificate(ca: string, target: string, userId: string): Promise<void> {
    const run = (stage: string, args: string[]) => execute('openssl', args, {cwd: target}).catch(() => {
        throw Object.assign(new Error(`User certificate ${stage.toLowerCase()} failed; check the CA and OpenSSL`), {code: `USER_CERTIFICATE_${stage}_FAILED`});
    });
    await run('REQUEST', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', `/CN=NestOS ${userId}`]);
    await chmod(path.join(target, 'client.key'), 0o600);
    await writeFile(path.join(target, 'client.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n', {mode: 0o600});
    await run('SIGN', ['x509', '-req', '-in', 'client.csr', '-CA', path.join(ca, 'ca.crt'), '-CAkey', path.join(ca, 'ca.key'), '-set_serial', '0x' + randomBytes(16).toString('hex'),
        '-out', 'client.crt', '-days', '365', '-extfile', 'client.ext']);
    await run('VERIFY', ['verify', '-purpose', 'sslclient', '-CAfile', path.join(ca, 'ca.crt'), 'client.crt']);
    await writeFile(path.join(target, 'client-password.txt'), randomBytes(24).toString('base64url'), {mode: 0o600, flag: 'wx'});
    await run('EXPORT', ['pkcs12', '-export', '-out', 'browser-client.p12', '-inkey', 'client.key', '-in', 'client.crt', '-certfile', path.join(ca, 'ca.crt'),
        '-name', `NestOS ${userId}`, '-passout', 'file:client-password.txt']);
    await chmod(path.join(target, 'browser-client.p12'), 0o600);
}

function issueErrorCode(error: unknown): string {
    const code = (error as {code?: string})?.code;
    return code === 'EEXIST' ? 'USER_CERTIFICATE_EXISTS' : code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'USER_CERTIFICATE_ISSUE_FAILED';
}
