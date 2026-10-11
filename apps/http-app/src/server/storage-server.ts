import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { FSError, type IStorageBackend } from '@itookit/vfs-core';
import { StorageApi } from './storage-api';
import { readJson, json, sendError } from './http-response';
import { auditRequest, type AuditPort } from './audit-log';
import { RecordConflictError } from './record-conflict';

/** Internal service: loopback only plus an ephemeral process credential. */
export function createStorageServer(backend: IStorageBackend, root: string, token: string, audit: AuditPort) {
    if (token.length < 32) throw new Error('Internal VFS credential is required');
    const api = new StorageApi(backend, root);
    return createServer((request, response) => {
        const requestId = auditRequest(audit, request, response, '/internal/vfs');
        if (request.socket.remoteAddress !== '127.0.0.1' || !validToken(request.headers.authorization, token)) {
            json(response, 401, { error: { code: 'EACCES', message: 'Internal authentication required' } }); return;
        }
        void handleStorage(request, response, api).catch(error => {
            if (error instanceof RecordConflictError) audit.write({ event: 'records.conflict', requestId,
                operation: 'records.commit', code: 'ECONFLICT', status: 409, conflict: error.conflict });
            sendError(response, error);
        });
    });
}
async function handleStorage(request: IncomingMessage, response: ServerResponse, api: StorageApi): Promise<void> {
    const route = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (route === '/api/health' && request.method === 'GET') {
        await api.invoke('stat', ['/']); json(response, 200, { ready: true }); return;
    }
    if (route !== '/api/vfs') throw new FSError('ENOENT', 'Unknown storage route');
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new FSError('EINVAL', 'Expected application/json');
    const payload = await readJson(request);
    if (typeof payload.method === 'string' && /^[a-zA-Z.]{1,80}$/.test(payload.method)) response.setHeader('X-VFS-Operation', payload.method);
    json(response, 200, { result: await api.invoke(payload.method, payload.args) });
}
function validToken(value: string | undefined, token: string): boolean {
    const actual = Buffer.from(value ?? ''), expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
