import type { ServerResponse, IncomingMessage } from 'node:http';
import { FSError, type FSErrorCode } from '@itookit/vfs-core';
import { MAX_BODY_BYTES } from '../protocol';

export async function readJson(request: IncomingMessage): Promise<{ method?: unknown; args?: unknown }> {
    const bytes = await readBytes(request);
    try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request');
        return value;
    } catch { throw new FSError('EINVAL', 'Malformed JSON request'); }
}
export async function readBytes(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_BODY_BYTES) throw new FSError('EFBIG', 'HTTP request is too large');
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}
export function json(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed) return;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new FSError('EFBIG', 'HTTP response is too large; use smaller pages or file ranges');
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(body);
}
export function sendError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) { response.destroy(); return; }
    const raw = error instanceof Error ? error.message : String(error);
    const code = error instanceof FSError ? error.code : errorCode(error, raw);
    response.setHeader('X-VFS-Error', code);
    const status = code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : code === 'ECONFLICT' ? 409 : code === 'EFBIG' ? 413 : code === 'EIO' ? 500 : 400;
    json(response, status, { error: { code, message: error instanceof FSError ? raw : code } });
}
function errorCode(error: unknown, message: string): FSErrorCode {
    const code = (error as NodeJS.ErrnoException)?.code ?? message.match(/\b(E[A-Z]+)\b/)?.[1];
    const known = ['ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EACCES', 'EROFS', 'ENOSPC', 'EINVAL', 'ELOOP', 'EFBIG', 'EBUSY'];
    return known.includes(code ?? '') ? code as FSErrorCode : 'EIO';
}
