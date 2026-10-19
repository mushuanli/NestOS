import { HttpFSBackend } from '@itookit/mindos-node-client';
import { writeFile } from 'node:fs/promises';
import type { CommandOptions } from './commands';

/** Direct VFS access without pretending an HTTP alias is a native process directory. */
export async function remoteFilesCommand(args: string[], options: CommandOptions): Promise<number> {
    const [operation, endpoint, alias, path = ''] = args;
    if (!['list', 'read', 'stat', 'status'].includes(operation) || !endpoint || !alias) throw new Error('Usage: mindos fs list|read|stat|status <endpoint> <alias> [relative-path]');
    const username = process.env.FS_SERVER_USER;
    const credentialEnv = options.credentialEnv ?? (username ? 'FS_SERVER_PASSWORD' : 'FS_SERVER_TOKEN');
    const token = process.env[credentialEnv];
    if (!token) throw new Error(`Set FS_SERVER_USER/FS_SERVER_PASSWORD, FS_SERVER_TOKEN, or --credential-env (${credentialEnv} is empty)`);
    const controller = new AbortController(), stop = () => controller.abort();
    const backend = new HttpFSBackend({ endpoint, alias, username, credential: () => token, maxReadBytes: options.maxBytes });
    process.once('SIGINT', stop);
    try {
        const opts = { signal: controller.signal };
        await backend.init(opts);
        if (operation === 'status') process.stdout.write(JSON.stringify(await backend.operationStatus(path, opts)) + '\n');
        else if (operation === 'read') {
            const result = await backend.files.read(path, opts);
            if (options.out) await writeFile(options.out, result.data); else process.stdout.write(result.data);
        } else if (operation === 'stat') process.stdout.write(JSON.stringify(await backend.files.stat(path, opts)) + '\n');
        else await list(backend, path, opts);
        return 0;
    } finally { process.removeListener('SIGINT', stop); await backend.close(); }
}

async function list(backend: HttpFSBackend, path: string, options: { signal: AbortSignal }) {
    let cursor: string | undefined;
    do {
        const page = await backend.files.list(path, { ...options, cursor });
        for (const entry of page.entries) process.stdout.write(JSON.stringify(entry) + '\n');
        for (const warning of page.warnings ?? []) process.stderr.write(warning + '\n');
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
}
