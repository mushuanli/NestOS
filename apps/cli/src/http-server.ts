import { fileURLToPath } from 'node:url';
import type { CommandOptions } from './commands';
import { resolveProfileRoot } from './nestos';

export function parseHttpAddress(value: string): {host: string; port: number} {
    const index = value.lastIndexOf(':'), host = index < 0 ? '127.0.0.1' : value.slice(0, index);
    const port = Number(index < 0 ? value : value.slice(index + 1));
    if (!value || !host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid -d address; expected [host:]port');
    return {host, port};
}
/** The legacy daemon flag delegates to the same authenticated host as httpd. */
export async function startHttpServer(address: string, options: CommandOptions): Promise<void> {
    const {runHttpHost} = await import('@itookit/node-host/http');
    const {host, port} = parseHttpAddress(address);
    const args = ['--root', resolveProfileRoot(options.profile), '--host', host, '--port', String(port)];
    for (const [flag, value] of [['--auth-dir', options.authDir], ['--cert-dir', options.certDir], ['--audit-file', options.auditFile], ['--static', options.staticDir]])
        if (value) args.push(flag!, value);
    await runHttpHost(args, fileURLToPath(new URL('../../http-app/dist/', import.meta.url)), 'cli');
}
