import type {IncomingMessage, ServerResponse} from 'node:http';
import type {TLSSocket} from 'node:tls';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {FSError} from '@itookit/vfs-core';
import {AuditLog, type AuditPort} from '../logging/audit-log';
import {acquireHostLock} from '../storage/host-lock';
import {closeHostResources, type HostCleanup} from '../runtime/host-runtime';
import {createHttpServer} from './http-server';
import type {HttpHostOptions} from './start-host';
import {openUserApplication, privateDirectory, userAudit, userErrorCode, validateUserHostPaths} from './user-application';

type UserApplication = Awaited<ReturnType<typeof openUserApplication>>;
/** Registry keys come exclusively from an authenticated certificate, never a browser parameter. */
export class UserApplications {
    private readonly users = new Map<string, Promise<UserApplication>>();
    private closed = false;
    constructor(private readonly options: HttpHostOptions, private readonly audit: AuditPort) {}
    get(userId: string): Promise<UserApplication> {
        if (this.closed) return Promise.reject(new FSError('ECAPABILITY', 'User runtimes are stopping'));
        let opening = this.users.get(userId);
        if (!opening) {
            if (this.users.size >= 100) return Promise.reject(new FSError('EBUSY', 'User runtime limit reached'));
            opening = openUserApplication(this.options, userId, this.audit); this.users.set(userId, opening);
            void opening.catch(() => {if (this.users.get(userId) === opening) this.users.delete(userId);});
        }
        return opening;
    }
    async handle(request: IncomingMessage, response: ServerResponse, authorize?: () => Promise<boolean>): Promise<void> {
        const userId = await this.options.certificates.identity?.(request.socket as TLSSocket);
        if (!userId) throw new FSError('EACCES', 'Enrolled user certificate required');
        if (request.headers['x-nestos-user'] !== undefined && request.headers['x-nestos-user'] !== userId)
            throw new FSError('EACCES', 'Certificate user changed; reload this page');
        const app = await this.get(userId);
        await app.application.handle(request, response, async () => Boolean(await authorize?.()) &&
            await this.options.certificates.identity?.(request.socket as TLSSocket) === userId);
    }
    endStreams(): void {for (const value of this.users.values()) void value.then(user => user.application.endStreams()).catch(() => {});}
    async close(): Promise<void> {
        this.closed = true;
        const ready = await Promise.allSettled(this.users.values());
        this.users.clear();
        await closeHostResources(ready.flatMap(value => value.status === 'fulfilled' ? [value.value.close] : []));
    }
}

export async function startUserHost(options: HttpHostOptions) {
    if (!options.certificates.identity || !options.certificates.users) throw new Error('Multi-user hosting requires certificate-to-user enrollment');
    const cleanup: HostCleanup = [], audit = new AuditLog(options.auditFile), operationId = randomUUID(), started = Date.now();
    try {
        await audit.initialize(); cleanup.push(() => audit.close());
        await validateUserHostPaths(options);
        await privateDirectory(path.join(options.root, '_meta'));
        cleanup.push(await acquireHostLock(path.join(options.root, '_meta')));
        const users = new UserApplications(options, audit); cleanup.push(() => users.close());
        // Seed shared definitions before opening any read-only consumer; recover all enrolled users before listen.
        const enrolled = await options.certificates.users();
        if (!enrolled.includes('admin')) throw new FSError('EINVAL', 'Multi-user hosting requires an enrolled admin certificate');
        await users.get('admin');
        for (const userId of enrolled.filter(id => id !== 'admin')) await users.get(userId);
        const server = createHttpServer({certificates: options.certificates, staticDir: options.staticDir, audit, application: users, multiUser: true,
            userAudit: id => userAudit(audit, id), build: {mode: options.logMode ?? 'standalone', version: process.env.NESTOS_HTTPD_VERSION}});
        cleanup.push(async () => {users.endStreams(); await stopUserServer(server);});
        await listenUserServer(server, options);
        audit.write({event: 'server.started', operationId, stage: 'listen', result: 'success', count: enrolled.length, durationMs: Date.now() - started});
        console.log(`NestOS HTTPS UI: https://${options.host}:${(server.address() as {port: number}).port}\nClient certificate required; multi-user hosting enabled\nAudit log: ${options.auditFile}`);
        let closing: Promise<void> | undefined;
        return {server, close: () => closing ??= closeHostResources(cleanup)};
    } catch (error) {
        audit.write({event: 'server.start.failed', operationId, stage: 'startup', result: 'failure', code: userErrorCode(error, 'HTTP_START_FAILED'), durationMs: Date.now() - started});
        try {await closeHostResources(cleanup);} catch { /* Preserve the startup error. */ }
        throw error;
    }
}
async function stopUserServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
    await new Promise<void>(resolve => {
        const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
        server.close(() => {clearTimeout(deadline); resolve();}); server.closeIdleConnections();
    });
}

function listenUserServer(server: ReturnType<typeof createHttpServer>, options: HttpHostOptions): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject); server.listen({host: options.host, port: options.port, backlog: options.backlog}, () => {server.off('error', reject); resolve();});
    });
}
