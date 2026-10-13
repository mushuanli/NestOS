import { request, Agent } from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { IStorageBackend } from '@itookit/vfs-core';
import { loadCertificates } from '../src/server/certificates';
import { createHttpServer } from '../src/server/http-server';
import { createStorageServer } from '../src/server/storage-server';
import type { AuditEvent, AuditPort } from '../src/server/audit-log';
import type { ApplicationApi } from '../src/server/application-api';

export async function authenticatedFetch(directory: string): Promise<{ fetcher: typeof fetch; close(): void }> {
    const [ca, cert, key] = await Promise.all(['ca.crt', 'client.crt', 'client.key'].map(file => readFile(path.join(directory, file))));
    const agent = new Agent({ ca, cert, key, keepAlive: true, maxCachedSessions: 0 });
    const fetcher: typeof fetch = async (input, init = {}) => new Promise((resolve, reject) => {
        const url = input instanceof Request ? input.url : String(input);
        const outgoing = request(url, { agent, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined }, incoming => {
            const chunks: Buffer[] = [];
            incoming.on('data', chunk => chunks.push(Buffer.from(chunk))); incoming.once('error', reject);
            incoming.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode,
                headers: Object.fromEntries(Object.entries(incoming.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])) })));
        });
        outgoing.once('error', reject); outgoing.end(init.body as string | undefined);
    });
    return { fetcher, close: () => agent.destroy() };
}
export async function listen(server: Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as { port: number }).port;
}
export async function close(server: Server): Promise<void> {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
export async function secureServers(backend: IStorageBackend, root: string, ui: string, certificates: string, application?: ApplicationApi) {
    const events: AuditEvent[] = [], audit: AuditPort = { write: event => { events.push(event); }, close: async () => {} };
    const token = randomBytes(32).toString('hex'), internal = createStorageServer(backend, root, token, audit);
    const internalPort = await listen(internal);
    const server = createHttpServer({ certificates: await loadCertificates(certificates), staticDir: ui, internalPort, internalToken: token, audit, application });
    const port = await listen(server);
    return { server, internal, internalPort, token, events, origin: `https://127.0.0.1:${port}` };
}
