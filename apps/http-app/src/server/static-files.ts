import { readFile, realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { FSError } from '@itookit/vfs-core';

const compress = promisify(gzip);

export async function serveStatic(response: ServerResponse, method: string, directory: string, pathname: string, acceptsGzip: boolean): Promise<void> {
    const root = await realpath(directory);
    const target = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
    if (!inside(root, target) || !inside(root, await realpath(target))) throw new FSError('EACCES', 'Static path is outside the UI root');
    if (!(await stat(target)).isFile()) throw new FSError('ENOENT', 'Static file not found');
    let body = await readFile(target);
    const encoded = acceptsGzip && /\.(html|js|css|json|svg)$/.test(target);
    if (encoded) body = await compress(body);
    response.writeHead(200, { 'Content-Type': mime(target), 'Content-Length': body.length,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        Vary: 'Accept-Encoding', ...(encoded ? { 'Content-Encoding': 'gzip' } : {}) });
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
