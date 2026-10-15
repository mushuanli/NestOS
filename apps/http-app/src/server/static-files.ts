import { readFile, realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { FSError } from '@itookit/vfs-core';

const compress = promisify(gzip);
type Asset = { body: Buffer; etag: string };
const assets = new Map<string, { ready: Promise<Asset>; size: number }>();
let cachedBytes = 0;
function asset(file: string, revision: string, encoded: boolean): Promise<Asset> {
    const key = JSON.stringify([file, revision, encoded]), cached = assets.get(key);
    if (cached) { assets.delete(key); assets.set(key, cached); return cached.ready; }
    const entry: { size: number; ready: Promise<Asset> } = { size: 0, ready: readFile(file).then(async body => {
        if (encoded) body = await compress(body);
        if (assets.get(key) === entry) { entry.size = body.length; cachedBytes += entry.size; trimAssets(); }
        return { body, etag: '"' + createHash('sha256').update(body).digest('base64url') + '"' };
    }).catch(error => { if (assets.get(key) === entry) assets.delete(key); throw error; }) };
    assets.set(key, entry); trimAssets(); return entry.ready;
}
function trimAssets(): void {
    while (assets.size > 64 || cachedBytes > 16 * 1024 * 1024) {
        const key = assets.keys().next().value!; cachedBytes -= assets.get(key)!.size; assets.delete(key);
    }
}
export async function serveStatic(response: ServerResponse, method: string, directory: string, pathname: string, acceptsGzip: boolean, ifNoneMatch?: string): Promise<void> {
    const root = await realpath(directory);
    const target = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
    if (!inside(root, target) || !inside(root, await realpath(target))) throw new FSError('EACCES', 'Static path is outside the UI root');
    const info = await stat(target);
    if (!info.isFile()) throw new FSError('ENOENT', 'Static file not found');
    const encoded = acceptsGzip && /\.(html|js|css|json|svg)$/.test(target);
    const { body, etag } = await asset(target, `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, encoded);
    const immutable = /\/assets\/[^/]+-[\w-]{8,}\.[\w.]+$/.test(target);
    const unchanged = ifNoneMatch?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*');
    response.writeHead(unchanged ? 304 : 200, { 'Content-Type': mime(target), ...(!unchanged ? { 'Content-Length': body.length } : {}),
        'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        Vary: 'Accept-Encoding', ...(encoded ? { 'Content-Encoding': 'gzip' } : {}) });
    response.end(method === 'HEAD' || unchanged ? undefined : body);
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
