import {lstat} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import path from 'node:path';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {canonical, within} from '../runtime/paths';
import {createCertificates} from './create-certificates';

const log = createModuleLogger('http-certificates');

/** Validate even a not-yet-created directory, following existing parent symlinks. */
export async function protectCertificateDirectory(directory: string, root: string, staticDir?: string): Promise<void> {
    const certificates = await canonical(path.resolve(directory)), data = await canonical(path.resolve(root));
    if (within(data, certificates) || staticDir && within(await canonical(path.resolve(staticDir)), certificates))
        throw new Error('Certificates must remain outside the VFS data root and static UI root');
}
export function reportCertificateFiles(directory: string): void {
    console.log(`Certificates created: ${directory}\nBrowser identity: ${path.join(directory, 'browser-client.p12')}\nImport password file: ${path.join(directory, 'client-password.txt')}`);
    console.log('Import ca.crt as a trusted CA and browser-client.p12 as a personal certificate before opening the HTTPS workspace.');
}
async function askHosts(directory: string, defaults: string): Promise<string[]> {
    const prompt = createInterface({input: stdin, output: stdout}), cancellation = new AbortController();
    prompt.on('SIGINT', () => prompt.close()); prompt.on('close', () => cancellation.abort());
    try {
        const answer = await prompt.question(`HTTPS certificate directory not found: ${directory}\nGenerate a private CA and browser identity now? [y/N] `, {signal: cancellation.signal});
        if (!/^(?:y|yes)$/i.test(answer.trim())) throw new Error('Certificate initialization declined. Initialize with --init-certs --cert-host <IP/DNS> before starting.');
        const hosts = await prompt.question(`Browser access IP/DNS (comma-separated; default ${defaults}): `, {signal: cancellation.signal});
        return (hosts.trim() || defaults).split(',').map(host => host.trim());
    } catch (error) {
        if (cancellation.signal.aborted) throw new Error('Certificate initialization cancelled; no HTTPS server was started.');
        throw error;
    } finally {prompt.close();}
}
/** Only a missing directory may trigger an explicit, interactive first-run initialization. */
export async function ensureStartupCertificates(directory: string, defaults: string): Promise<void> {
    try {await lstat(directory); return;}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    // The repository launcher pipes stdout to its runtime log while retaining interactive stdin.
    if (!stdin.isTTY) throw new Error(`HTTPS certificates are missing: ${directory}. Run with --init-certs --cert-host <IP/DNS> --cert-dir "${directory}" first. Non-interactive startup cannot prompt.`);
    const hosts = await askHosts(directory, defaults), operationId = randomUUID(), started = Date.now();
    log.info('http.certificates.initialize', {operation: 'http.certificates.initialize', operationId, stage: 'generate', result: 'start', hostCount: hosts.length});
    try {
        await createCertificates(directory, hosts); reportCertificateFiles(directory);
        log.info('http.certificates.initialize', {operation: 'http.certificates.initialize', operationId, stage: 'generate', result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        log.warn('http.certificates.initialize', {operation: 'http.certificates.initialize', operationId, stage: 'generate', result: 'failure', code: 'CERTIFICATE_INITIALIZATION_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
