import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { FSError } from '@itookit/vfs-core';

export async function proxyStorage(request: IncomingMessage, response: ServerResponse, port: number, token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const outgoing = httpRequest({ hostname: '127.0.0.1', port, method: request.method, path: new URL(request.url ?? '/', 'http://localhost').pathname,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': request.headers['content-type'] ?? 'application/json',
                'X-Parent-Request-ID': String(response.getHeader('X-Request-ID')) } }, incoming => {
            response.writeHead(incoming.statusCode ?? 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                ...(incoming.headers['x-vfs-error'] ? { 'X-VFS-Error': incoming.headers['x-vfs-error'] } : {}),
                ...(incoming.headers['x-vfs-operation'] ? { 'X-VFS-Operation': incoming.headers['x-vfs-operation'] } : {}) });
            incoming.once('error', reject); incoming.once('end', resolve); incoming.pipe(response);
        });
        outgoing.setTimeout(120000, () => outgoing.destroy(new Error('Internal storage timeout')));
        outgoing.once('error', () => reject(new FSError('EIO', 'Internal storage unavailable')));
        request.once('aborted', () => outgoing.destroy());
        response.once('close', () => { if (!response.writableFinished) outgoing.destroy(); });
        request.pipe(outgoing);
    });
}
