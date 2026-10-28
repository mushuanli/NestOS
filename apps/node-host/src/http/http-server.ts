import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { FSError } from '@itookit/vfs-core';
import type { CertificateAuth } from './certificates';
import { auditRequest, type AuditPort } from '../logging/audit-log';
import { sendError } from './http-response';
import { serveStatic } from './static-files';
import type { IncomingMessage as ApplicationRequest, ServerResponse as ApplicationResponse } from 'node:http';
export interface HostedApi { handle(request: ApplicationRequest, response: ApplicationResponse, authorize?: () => Promise<boolean>): Promise<void> }
import { json } from './http-response';

export interface HttpServerOptions {
    multiUser?: boolean;
    userAudit?(userId: string): AuditPort;
    build?: { mode: string; version?: string };
    application?: HostedApi;
    certificates: CertificateAuth; staticDir: string; audit: AuditPort;
}
/** Every public resource requires both TLS client validation and explicit certificate enrollment. */
export function createHttpServer(options: HttpServerOptions): Server {
    const server = createServer(options.certificates.tls, (request, response) => {
        void serve(request, response, options).catch(error => sendError(response, error));
    });
    server.on('secureConnection', socket => { void validateConnection(socket, options); });
    server.on('tlsClientError', (error, socket) => options.audit.write({ event: 'auth.rejected', remoteAddress: socket.remoteAddress,
        code: safeCode(error) }));
    server.requestTimeout = 120000; server.headersTimeout = 30000;
    return server;
}
async function validateConnection(socket: TLSSocket, options: HttpServerOptions): Promise<void> {
    const started = Date.now(), auth = await authenticate(socket, options.certificates);
    options.audit.write({event: auth.accepted ? 'auth.accepted' : 'auth.rejected', remoteAddress: socket.remoteAddress,
        userId: auth.userId, certificate: socket.getPeerCertificate()?.fingerprint256, code: auth.code,
        operation: 'certificate.authenticate', stage: 'enrollment', result: auth.accepted ? 'success' : 'failure', durationMs: Date.now() - started});
    if (!auth.accepted) socket.destroy();
}
async function serve(request: IncomingMessage, response: ServerResponse, options: HttpServerOptions): Promise<void> {
    const auth = await authenticate(request.socket as TLSSocket, options.certificates);
    if (!auth.accepted) {
        options.audit.write({event: 'auth.rejected', remoteAddress: request.socket.remoteAddress, code: auth.code,
            operation: 'certificate.authenticate', stage: 'request', result: 'failure'});
        request.socket.destroy(); return;
    }
    const pathname = new URL(request.url ?? '/', 'https://localhost').pathname;
    const route = ['/api/identity', '/api/vfs', '/api/health', '/api/application', '/api/application/events', '/api/application/files'].includes(pathname) ? pathname : pathname.startsWith('/api/') ? '/api/unknown' : '/ui';
    const userId = auth.userId;
    if (userId && userId !== 'admin' && !options.multiUser) throw new FSError('EACCES', 'User mappings require multi-user hosting');
    const audit = userId && options.userAudit ? options.userAudit(userId) : options.audit;
    auditRequest(audit, request, response, route);
    if (pathname === '/api/identity') {
        if (request.method !== 'GET') throw new FSError('EINVAL', 'Identity requires GET');
        json(response, 200, {userId: userId ?? 'admin'}); return;
    }
    if (request.method === 'POST' || pathname.startsWith('/api/application')) validateOrigin(request);
    if (['/api/application', '/api/application/events', '/api/application/files'].includes(pathname)) {
        if (!options.application) throw new FSError('ECAPABILITY', 'Application hosting is disabled');
        await options.application.handle(request, response, () => options.certificates.accepts(request.socket as TLSSocket)); return;
    }
    if (pathname === '/api/vfs') throw new FSError('EACCES', 'Storage is private to the daemon');
    if (pathname === '/api/health') { json(response, 200, { ready: true, ...options.build }); return; }
    if (pathname.startsWith('/api/')) throw new FSError('ENOENT', 'Unknown API route');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
    await serveStatic(response, request.method, options.staticDir, pathname, request.headers['accept-encoding']?.includes('gzip') ?? false, request.headers['if-none-match']);
}
function validateOrigin(request: IncomingMessage): void {
    if (request.headers.origin && request.headers.origin !== `https://${request.headers.host}`) throw new FSError('EACCES', 'Cross-origin requests are denied');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new FSError('EACCES', 'Cross-site requests are denied');
}
function safeCode(error: Error): string {
    const code = (error as NodeJS.ErrnoException).code;
    return code && /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'TLS_CLIENT_AUTHENTICATION_FAILED';
}

async function authenticate(socket: TLSSocket, certificates: CertificateAuth): Promise<{accepted: boolean; userId?: string; code?: string}> {
    try {
        const userId = await certificates.identity?.(socket);
        const accepted = certificates.identity ? Boolean(userId) : await certificates.accepts(socket);
        return {accepted, userId, code: accepted ? undefined : 'CLIENT_CERTIFICATE_NOT_ENROLLED'};
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        return {accepted: false, code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'CLIENT_POLICY_UNAVAILABLE'};
    }
}
