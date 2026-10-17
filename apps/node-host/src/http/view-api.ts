import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { FSError } from '@itookit/vfs-core';
import type { ApplicationRuntime } from '@itookit/app-core';
import { RpcPeer } from '@itookit/app-transport/application';
import type { Call, Reply } from '@itookit/app-transport/rpc';
import { RPC_VERSION } from '@itookit/app-transport/rpc';
import { json, readJson, readBytes } from './http-response';
import { MAX_BODY_BYTES } from '@itookit/app-transport/rpc';
import { createHostedView, type HostedView } from './view-services';
import { ViewNotifications } from './view-notifications';
import { ViewEventStream } from './view-event-stream';
import type { AuditPort } from '../logging/audit-log';
import { recordRequestPhase } from '../logging/audit-log';
import {SnapshotCache} from '@itookit/app-transport/http';
import {bootstrapView, type BootstrapRequest} from './view-bootstrap';

interface Client { peer: RpcPeer; view: HostedView; stream?: ServerResponse; lastSeen: number; active: number;
    bootstrap?: Promise<Reply>; stopObservation?: () => void;
    initialized: boolean; notifications: ViewNotifications; events: ViewEventStream;
    pending: Map<string, { resolve(reply: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>; }
type ApplicationRequest = BootstrapRequest & {clientId?: unknown; version?: unknown; kind?: string;
    call?: Call; calls?: Call[]; id?: string; reply?: Reply};
/** A certificate-scoped browser view owns subscriptions; the daemon owns execution. */
export class ViewApi {
    private readonly snapshots = new SnapshotCache();
    private readonly clients = new Map<string, Promise<Client>>();
    private readonly sweep: ReturnType<typeof setInterval>;
    constructor(private readonly runtime: Promise<ApplicationRuntime>, private readonly audit?: AuditPort, private readonly ownsRuntime = true) {
        this.sweep = setInterval(() => { void this.releaseIdle(); }, 15000); this.sweep.unref();
    }
    private identity(request: IncomingMessage, id: unknown): string {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new FSError('EINVAL', 'Invalid view identity');
        const certificate = (request.socket as TLSSocket).getPeerCertificate?.()?.fingerprint256 ?? 'internal';
        return certificate + ':' + id;
    }
    async handle(request: IncomingMessage, response: ServerResponse, authorize?: () => Promise<boolean>): Promise<void> {
        const url = new URL(request.url ?? '/', 'https://localhost');
        if (url.pathname.endsWith('/events')) return this.stream(request, response, url, authorize);
        if (url.pathname.endsWith('/files')) return this.file(request, response, url);
        if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new FSError('EINVAL', 'Expected application/json');
        const body = await readApplicationBody(request, response) as ApplicationRequest;
        const identity = this.identity(request, body.clientId);
        if (body.version !== RPC_VERSION) throw new FSError('ECAPABILITY', 'Unsupported view protocol version');
        if (body.kind === 'close') { await this.release(identity); json(response, 200, {}); return; }
        const preparing = Date.now();
        const client = await (body.kind === 'bootstrap' ? this.client(identity) : this.requireClient(identity, response)); client.lastSeen = Date.now();
        recordRequestPhase(response, 'viewReadyMs', Date.now() - preparing);
        if (body.kind === 'bootstrap') return this.respondBootstrap(client, identity, body, response);
        if (body.kind === 'bootstrap-data') {json(response, 200, await client.bootstrap!); return;}
        if (body.kind === 'reply') {
            const pending = client.pending.get(body.id!); if (!pending) throw new FSError('ENOENT', 'Unknown callback');
            clearTimeout(pending.timer); client.pending.delete(body.id!); pending.resolve(body.reply!); json(response, 200, {}); return;
        }
        return this.invoke(client, body, response);
    }
    private async respondBootstrap(client: Client, identity: string, body: BootstrapRequest, response: ServerResponse): Promise<void> {
        const started = Date.now(), existing = client.bootstrap;
        try {json(response, 200, await bootstrapView(client, body, this.snapshots));}
        catch (error) {if (!existing) await this.release(identity); throw error;}
        finally {
            recordRequestPhase(response, 'rpcMs', Date.now() - started);
            this.audit?.write({event: 'application.complete', requestId: String(response.getHeader('X-Request-ID') ?? ''),
                rpcKind: 'bootstrap', rpcBatchSize: body.initialView ? 1 : 0,
                rpcOperations: body.initialView ? ['ApplicationBackend.openView'] : [], durationMs: Date.now() - started});
        }
    }
    private async invoke(client: Client, body: ApplicationRequest, response: ServerResponse): Promise<void> {
        if (!['queries', 'bindings'].includes(body.kind ?? '') && (body.kind !== 'call' || !validCall(body.call))) throw new FSError('EINVAL', 'Invalid public capability call');
        this.acquire(client);
        const started = Date.now();
        const calls = body.kind === 'call' ? [body.call!] : (Array.isArray(body.calls) ? body.calls : []).filter(validCall).slice(0, 32);
        const operations = calls.map(call => client.peer.operationName(call));
        try { json(response, 200, ['queries', 'bindings'].includes(body.kind!) ? await this.queries(client, body.calls, body.kind === 'bindings') : await client.peer.handle(body.call!)); }
        finally {
            client.active--; client.lastSeen = Date.now();
            recordRequestPhase(response, 'rpcMs', Date.now() - started);
            this.audit?.write({ event: 'application.complete', requestId: String(response.getHeader('X-Request-ID') ?? ''),
                rpcKind: body.kind, rpcBatchSize: calls.length, rpcOperations: operations,
                durationMs: Date.now() - started });
        }
    }
    private async file(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
        if (request.method !== 'POST' || request.headers['content-type'] !== 'application/octet-stream') throw new FSError('EINVAL', 'Expected file transfer');
        if (url.searchParams.get('version') !== String(RPC_VERSION)) throw new FSError('ECAPABILITY', 'Unsupported view protocol version');
        const call = fileCall(request.headers['x-view-call']);
        const client = await this.requireClient(this.identity(request, url.searchParams.get('clientId')), response); this.acquire(client);
        try {
            const body = await readBytes(request);
            if (call.method === 'readContent') {
                if (body.byteLength) throw new FSError('EINVAL', 'File read must have an empty body');
                const { bytes, revision } = await client.peer.readBinary(call);
                if (bytes.byteLength > MAX_BODY_BYTES) throw new FSError('EFBIG', 'File transfer is too large');
                response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': bytes.byteLength,
                    'X-File-Revision': encodeURIComponent(JSON.stringify(revision ?? null)) });
                response.end(Buffer.from(bytes));
            } else {
                json(response, 200, await client.peer.writeBinary(call, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer));
            }
        } finally { client.active--; client.lastSeen = Date.now(); }
    }
    private acquire(client: Client): void {
        if (client.active >= 16) throw new FSError('EBUSY', 'Too many active view requests');
        client.active++;
    }
    private async queries(client: Client, calls: Call[] | undefined, bindings = false): Promise<{ replies: Reply[]; updates: Reply['updates'] }> {
        if (!Array.isArray(calls) || !calls.length || calls.length > 32 || calls.some(call => !validCall(call) || !(bindings ? client.peer.binding(call) : client.peer.query(call))))
            throw new FSError('EINVAL', 'Only bounded read queries may be batched');
        const replies = await Promise.all(calls.map(call => client.peer.handle(call, false)));
        return { replies, updates: await client.peer.refresh() };
    }
    private client(identity: string): Promise<Client> {
        let ready = this.clients.get(identity);
        if (!ready) {
            if (this.clients.size >= 128) throw new FSError('EBUSY', 'View limit reached');
            ready = this.createClient(); this.clients.set(identity, ready);
            void ready.catch(() => this.clients.delete(identity));
        }
        return ready;
    }
    private async requireClient(identity: string, response: ServerResponse): Promise<Client> {
        const ready = this.clients.get(identity), client = ready && await ready;
        if (client?.initialized && !client.events.destroyed) return client;
        response.setHeader('X-MindOS-View-Expired', '1');
        throw new FSError('ECAPABILITY', 'View expired; reload the page');
    }
    private async createClient(): Promise<Client> {
        const view = await createHostedView(await this.runtime);
        const client = { view, lastSeen: Date.now(), active: 0, initialized: false, pending: new Map(), events: new ViewEventStream() } as Client;
        client.peer = new RpcPeer('server', async call => {
            if (call.notification) return client.notifications.enqueue(call);
            if (client.events.destroyed) throw new FSError('EIO', 'View event stream is disconnected');
            if (client.pending.size >= 128) throw new FSError('EBUSY', 'Too many active view callbacks');
            const id = randomUUID(), updates: Reply['updates'] = [];
            return new Promise<Reply>((resolve, reject) => {
                const timer = setTimeout(() => { client.pending.delete(id); client.events.end(); reject(new FSError('EIO', 'View callback timed out')); }, 30000);
                client.pending.set(id, { resolve, reject, timer });
                client.events.write(`data: ${JSON.stringify({ id, call, updates })}\n\n`);
            });
        }, error => console.warn('[View] Callback failed', error), undefined, domains => view.prepare(client.peer, domains));
        client.notifications = new ViewNotifications(() => client.events, () => client.initialized ? client.peer.refresh() : Promise.resolve([]), error => console.warn('[View] Notifications failed', error));
        client.peer.onInvalidated(() => { void client.notifications.enqueue(); });
        return client;
    }
    private async stream(request: IncomingMessage, response: ServerResponse, url: URL, authorize?: () => Promise<boolean>): Promise<void> {
        if (request.method !== 'GET') throw new FSError('EINVAL', 'Expected event subscription');
        const identity = this.identity(request, url.searchParams.get('clientId')), resume = url.searchParams.has('after');
        if (resume && url.searchParams.get('version') !== String(RPC_VERSION)) {
            response.setHeader('X-MindOS-View-Expired', '1');
            throw new FSError('ECAPABILITY', 'Unsupported view protocol version');
        }
        const client = await (resume ? this.requireClient(identity, response) : this.client(identity));
        const after = resume ? Number(url.searchParams.get('after')) : 0;
        if (!client.events.canResume(after)) {
            response.setHeader('X-MindOS-View-Expired', '1');
            throw new FSError('ECAPABILITY', 'View event history expired; reload the page');
        }
        client.lastSeen = Date.now(); client.stream = response;
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-MindOS-View-Resume': '1' });
        response.write(': connected\n\n');
        client.events.attach(response, after, resume || url.searchParams.get('resume') === '1');
        const timer = setInterval(() => {
            void (authorize?.() ?? Promise.resolve(true)).then(accepted => {
                if (!accepted) { response.end(); return; } client.lastSeen = Date.now(); response.write(': heartbeat\n\n');
            }).catch(() => response.end());
        }, 15000);
        response.once('close', () => { clearInterval(timer); if (client.stream === response) client.stream = undefined; });
    }
    private async releaseIdle(): Promise<void> {
        for (const [id, ready] of this.clients) {
            const client = await ready.catch(() => undefined);
            if (client && !client.stream && !client.pending.size && !client.active && Date.now() - client.lastSeen > 60000) await this.release(id);
        }
    }
    private async release(identity: string): Promise<void> {
        const ready = this.clients.get(identity); if (!ready) return; this.clients.delete(identity);
        const client = await ready; client.stopObservation?.(); client.notifications.close(); client.events.end();
        for (const pending of client.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('View closed')); }
        client.pending.clear(); await client.peer.close(); await client.view.close();
    }
    endStreams(): void { for (const ready of this.clients.values()) void ready.then(client => client.stream?.end()); }
    async close(): Promise<void> {
        clearInterval(this.sweep); this.endStreams();
        const results = await Promise.allSettled([...this.clients.keys()].map(id => this.release(id)));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (this.ownsRuntime) await this.runtime.then(runtime => runtime.dispose()).catch(error => errors.push(error));
        if (errors.length) throw new AggregateError(errors, 'HTTP host cleanup failed');
    }

}
async function readApplicationBody(request: IncomingMessage, response: ServerResponse) {
    const started = Date.now();
    try { return await readJson(request); }
    finally { recordRequestPhase(response, 'bodyReadMs', Date.now() - started); }
}
function validCall(call: Call | undefined): call is Call {
    return !!call && typeof call.target === 'string' && typeof call.method === 'string' && Array.isArray(call.args);
}
function fileCall(header: string | string[] | undefined): Call {
    if (typeof header !== 'string' || header.length > 8192) throw new FSError('EINVAL', 'Invalid file transfer metadata');
    let call: Call;
    try { call = JSON.parse(decodeURIComponent(header)); } catch { throw new FSError('EINVAL', 'Malformed file transfer metadata'); }
    if (!validCall(call)) throw new FSError('EINVAL', 'Invalid file capability call');
    return call;
}
