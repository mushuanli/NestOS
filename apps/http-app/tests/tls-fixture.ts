import { request, Agent } from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { IStorageBackend } from '@itookit/vfs-core';
import { loadCertificates } from '@itookit/node-host/http';
import { createHttpServer } from '@itookit/node-host/http';
import type { AuditEvent, AuditPort } from '@itookit/node-host/logging';
import type { HostedApi } from '@itookit/node-host/http';

export async function authenticatedFetch(directory: string): Promise<{ fetcher: typeof fetch; close(): void }> {
    const [ca, cert, key] = await Promise.all(['ca.crt', 'client.crt', 'client.key'].map(file => readFile(path.join(directory, file))));
    const agent = new Agent({ ca, cert, key, keepAlive: true, maxCachedSessions: 0 });
    const fetcher: typeof fetch = async (input, init = {}) => new Promise((resolve, reject) => {
        const url = input instanceof Request ? input.url : String(input);
        const outgoing = request(url, { agent, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined }, incoming => {
            if (url.includes('/events?')) {
                const body = new ReadableStream<Uint8Array>({ start(controller) {
                    incoming.on('data', chunk => controller.enqueue(new Uint8Array(chunk)));
                    incoming.once('end', () => controller.close()); incoming.once('error', error => controller.error(error));
                }, cancel() { incoming.destroy(); } });
                resolve(new Response(body, { status: incoming.statusCode, headers: { 'Content-Type': 'text/event-stream' } })); return;
            }
            const chunks: Buffer[] = [];
            incoming.on('data', chunk => chunks.push(Buffer.from(chunk))); incoming.once('error', reject);
            incoming.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode,
                headers: Object.fromEntries(Object.entries(incoming.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])) })));
        });
        outgoing.once('error', reject); outgoing.end(init.body instanceof ArrayBuffer ? Buffer.from(init.body) : init.body as string | undefined);
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
export async function secureServers(_backend: IStorageBackend, _root: string, ui: string, certificates: string, application?: HostedApi) {
    const events: AuditEvent[] = [], audit: AuditPort = { write: event => { events.push(event); }, close: async () => {} };
    const server = createHttpServer({ certificates: await loadCertificates(certificates), staticDir: ui, audit, application });
    const port = await listen(server);
    return { server, events, origin: `https://127.0.0.1:${port}` };
}
