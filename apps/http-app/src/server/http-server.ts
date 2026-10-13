import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { FSError } from '@itookit/vfs-core';
import type { CertificateAuth } from './certificates';
import { auditRequest, type AuditPort } from './audit-log';
import { sendError } from './http-response';
import { serveStatic } from './static-files';
import type { ApplicationApi } from './application-api';
import { proxyStorage } from './storage-proxy';

export interface HttpServerOptions {
    application?: ApplicationApi;
    certificates: CertificateAuth; staticDir: string; internalPort: number; internalToken: string; audit: AuditPort;
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
    const remoteAddress = socket.remoteAddress;
    const accepted = await options.certificates.accepts(socket).catch(() => false);
    options.audit.write({ event: accepted ? 'auth.accepted' : 'auth.rejected', remoteAddress,
        certificate: socket.getPeerCertificate()?.fingerprint256, code: accepted ? undefined : 'CLIENT_CERTIFICATE_NOT_ENROLLED' });
    if (!accepted) socket.destroy();
}
async function serve(request: IncomingMessage, response: ServerResponse, options: HttpServerOptions): Promise<void> {
    if (!await options.certificates.accepts(request.socket as TLSSocket).catch(() => false)) {
        options.audit.write({ event: 'auth.rejected', remoteAddress: request.socket.remoteAddress, code: 'CLIENT_CERTIFICATE_NOT_ENROLLED' });
        request.socket.destroy(); return;
    }
    const pathname = new URL(request.url ?? '/', 'https://localhost').pathname;
    const route = ['/api/vfs', '/api/health', '/api/application', '/api/application/events'].includes(pathname) ? pathname : pathname.startsWith('/api/') ? '/api/unknown' : '/ui';
    auditRequest(options.audit, request, response, route);
    if (request.method === 'POST' || pathname.startsWith('/api/application')) validateOrigin(request);
    if (pathname === '/api/application' || pathname === '/api/application/events') {
        if (!options.application) throw new FSError('ECAPABILITY', 'Application hosting is disabled');
        await options.application.handle(request, response, () => options.certificates.accepts(request.socket as TLSSocket)); return;
    }
    if (pathname === '/api/vfs' && options.application) throw new FSError('EACCES', 'Managed state is only writable through application commands');
    if (pathname === '/api/vfs' || pathname === '/api/health') {
        await proxyStorage(request, response, options.internalPort, options.internalToken); return;
    }
    if (pathname.startsWith('/api/')) throw new FSError('ENOENT', 'Unknown API route');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
    await serveStatic(response, request.method, options.staticDir, pathname, request.headers['accept-encoding']?.includes('gzip') ?? false);
}
function validateOrigin(request: IncomingMessage): void {
    if (request.headers.origin && request.headers.origin !== `https://${request.headers.host}`) throw new FSError('EACCES', 'Cross-origin requests are denied');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new FSError('EACCES', 'Cross-site requests are denied');
}
function safeCode(error: Error): string {
    const code = (error as NodeJS.ErrnoException).code;
    return code && /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'TLS_CLIENT_AUTHENTICATION_FAILED';
}
