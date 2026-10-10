import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { FSError, type FSErrorCode, type IStorageBackend } from '@itookit/vfs-core';
import { MAX_BODY_BYTES } from '../protocol';
import { StorageApi } from './storage-api';

const compress = promisify(gzip);

export function createHttpServer(backend: IStorageBackend, root: string, staticDir: string): Server {
    const api = new StorageApi(backend, root);
    return createServer((request, response) => {
        void handle(request, response, api, staticDir).catch(error => sendError(response, error));
    });
}

async function handle(request: IncomingMessage, response: ServerResponse, api: StorageApi, staticDir: string): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/vfs') {
        if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) throw new FSError('EACCES', 'Cross-origin VFS requests are denied');
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new FSError('EINVAL', 'Expected application/json');
        const payload = await readJson(request);
        json(response, 200, { result: await api.invoke(payload.method, payload.args) });
        return;
    }
    if (url.pathname.startsWith('/api/')) throw new FSError('ENOENT', 'Unknown API route');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
    await serveStatic(response, request.method, staticDir, url.pathname, request.headers['accept-encoding']?.includes('gzip') ?? false);
}

async function readJson(request: IncomingMessage): Promise<{ method?: unknown; args?: unknown }> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_BODY_BYTES) throw new FSError('EFBIG', 'HTTP request is too large');
        chunks.push(bytes);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request');
        return value;
    }
    catch { throw new FSError('EINVAL', 'Malformed JSON request'); }
}

async function serveStatic(response: ServerResponse, method: string, directory: string, pathname: string, acceptsGzip: boolean): Promise<void> {
    const root = await realpath(directory);
    const target = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
    if (!inside(root, target) || !inside(root, await realpath(target))) throw new FSError('EACCES', 'Static path is outside the UI root');
    if (!(await stat(target)).isFile()) throw new FSError('ENOENT', 'Static file not found');
    let body = await readFile(target);
    const encoded = acceptsGzip && /\.(html|js|css|json|svg)$/.test(target);
    if (encoded) body = await compress(body);
    response.writeHead(200, { 'Content-Type': mime(target), 'Content-Length': body.length,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
        'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding', ...(encoded ? { 'Content-Encoding': 'gzip' } : {}) });
    response.end(method === 'HEAD' ? undefined : body);
}

function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function mime(file: string): string {
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
        '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
    return types[path.extname(file)] ?? 'application/octet-stream';
}
function json(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new FSError('EFBIG', 'HTTP response is too large; use smaller pages or file ranges');
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(body);
}
function sendError(response: ServerResponse, error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    const code = error instanceof FSError ? error.code : errorCode(error, raw);
    if (code === 'EIO') console.error('[HTTP] VFS operation failed:', error);
    const status = code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : code === 'ECONFLICT' ? 409 : code === 'EFBIG' ? 413 : code === 'EIO' ? 500 : 400;
    // Public errors carry VFS codes rather than host filesystem paths.
    json(response, status, { error: { code, message: error instanceof FSError ? raw : code } });
}
function errorCode(error: unknown, message: string): FSErrorCode {
    const code = (error as NodeJS.ErrnoException)?.code ?? message.match(/\b(E[A-Z]+)\b/)?.[1];
    const known = ['ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EACCES', 'EROFS', 'ENOSPC', 'EINVAL', 'ELOOP', 'EFBIG', 'EBUSY'];
    return known.includes(code ?? '') ? code as FSErrorCode : 'EIO';
}
