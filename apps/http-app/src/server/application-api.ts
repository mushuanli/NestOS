import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { FSError } from '@itookit/vfs-core';
import { ApplicationHost } from '@itookit/app-core/application';
import type { ApplicationQueries, ApplicationCommands } from '@itookit/app-core/application/contracts';
import { json, readJson } from './http-response';
import { ApplicationEvents } from './application-events';

export class ApplicationApi {
    private readonly events = new ApplicationEvents();
    private readonly activity = new Map<string, { lastSeen: number; pending: number }>();
    private readonly sweep: ReturnType<typeof setInterval>;
    constructor(private readonly host: ApplicationHost, private readonly idleMs = 60000) {
        this.sweep = setInterval(() => { void this.releaseIdle().catch(error => console.warn('[Application] Client cleanup failed', error)); }, 15000);
        this.sweep.unref();
    }
    async handle(request: IncomingMessage, response: ServerResponse, authorize?: () => Promise<boolean>): Promise<void> {
        const url = new URL(request.url ?? '/', 'https://localhost');
        if (url.pathname.endsWith('/events')) return this.stream(request, response, url, authorize);
        if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new FSError('EINVAL', 'Expected application/json');
        const body = await readJson(request) as { clientId?: unknown; kind?: unknown; name?: unknown; input?: unknown; requestId?: unknown };
        if (typeof body.clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.clientId)) throw new FSError('EINVAL', 'Invalid application client');
        const identity = this.identity(request, body.clientId);
        if (body.kind === 'close') { await this.release(identity); json(response, 200, { result: null }); return; }
        if (body.kind !== 'query' && body.kind !== 'command') throw new FSError('EINVAL', 'Invalid application request');
        if (typeof body.name !== 'string' || !/^[a-zA-Z]{1,80}$/.test(body.name)) throw new FSError('EINVAL', 'Invalid application operation');
        if (body.kind === 'command' && (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.requestId))) throw new FSError('EINVAL', 'Invalid command identity');
        response.setHeader('X-VFS-Operation', `application.${body.kind}.${body.name}`);
        const activity = this.touch(identity); activity.pending++;
        try {
            const port = await this.host.client(identity); this.events.observe(identity, port);
            const result = body.kind === 'query' ? await port.query(body.name as keyof ApplicationQueries, body.input as never)
                : await port.command(body.name as keyof ApplicationCommands, body.input as never, undefined, body.requestId as string);
            json(response, 200, { result });
        } finally { activity.pending--; activity.lastSeen = Date.now(); }
    }
    private identity(request: IncomingMessage, clientId: string): string {
        const certificate = (request.socket as TLSSocket).getPeerCertificate?.()?.fingerprint256 ?? 'internal';
        return certificate + ':' + clientId;
    }
    private async stream(request: IncomingMessage, response: ServerResponse, url: URL, authorize?: () => Promise<boolean>): Promise<void> {
        if (request.method !== 'GET') throw new FSError('EINVAL', 'Expected event subscription');
        const clientId = url.searchParams.get('clientId') ?? '';
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(clientId)) throw new FSError('EINVAL', 'Invalid application client');
        const cursor = request.headers['last-event-id'] as string | undefined ?? url.searchParams.get('cursor') ?? undefined;
        if (cursor && !/^[a-zA-Z0-9_-]{1,80}:[0-9]{1,16}$/.test(cursor)) throw new FSError('EINVAL', 'Invalid event cursor');
        const identity = this.identity(request, clientId), port = await this.host.client(identity);
        this.touch(identity);
        if (!response.destroyed) this.events.attach(identity, port, response, cursor, authorize);
    }
    private touch(identity: string) {
        let activity = this.activity.get(identity);
        if (!activity) { activity = { lastSeen: Date.now(), pending: 0 }; this.activity.set(identity, activity); }
        activity.lastSeen = Date.now(); return activity;
    }
    async releaseIdle(now = Date.now()): Promise<void> {
        for (const [identity, activity] of this.activity) {
            if (!activity.pending && !this.events.active(identity) && now - activity.lastSeen >= this.idleMs) await this.release(identity);
        }
    }
    private async release(identity: string): Promise<void> {
        this.events.release(identity); await this.host.release(identity); this.activity.delete(identity);
    }
    endStreams(): void { this.events.close(); }
    async close(): Promise<void> { clearInterval(this.sweep); this.endStreams(); await this.host.close(); this.activity.clear(); }

}
