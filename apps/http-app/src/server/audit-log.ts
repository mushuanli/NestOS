import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AuditEvent {
    event: string; requestId?: string; remoteAddress?: string; method?: string; route?: string;
    status?: number; durationMs?: number; operation?: string; code?: string; certificate?: string; parentRequestId?: string;
    rpcKind?: string; rpcBatchSize?: number; rpcOperations?: string[];
    providerRequestId?: string;
}
export interface AuditPort { write(event: AuditEvent): void; close(): Promise<void>; }

/** A bounded JSONL log containing metadata only, never headers, arguments or bodies. */
export class AuditLog implements AuditPort {
    private pending = Promise.resolve();
    private queued = 0;
    private dropped = 0;
    constructor(private readonly file: string, private readonly maxBytes = 10 * 1024 * 1024) {}
    async initialize(): Promise<void> {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const handle = await open(this.file, 'a', 0o600);
        try { await handle.chmod(0o600); } finally { await handle.close(); }
    }
    write(event: AuditEvent): void {
        if (this.queued >= 1000) { this.dropped++; return; }
        this.queued++;
        const dropped = this.dropped; this.dropped = 0;
        const line = JSON.stringify({ time: new Date().toISOString(), ...event, ...(dropped ? { droppedEvents: dropped } : {}) }) + '\n';
        this.pending = this.pending.then(async () => {
            await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            const size = await stat(this.file).then(value => value.size).catch(() => 0);
            if (size + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
            const handle = await open(this.file, 'a', 0o600);
            try { await handle.chmod(0o600); await handle.write(line); } finally { await handle.close(); }
        }).catch(() => { console.error('[HTTP] Audit log write failed'); }).finally(() => { this.queued--; });
    }
    async close(): Promise<void> {
        await this.pending;
        if (this.dropped) { this.write({ event: 'audit.events_dropped' }); await this.pending; }
    }
    private async rotate(): Promise<void> {
        await unlink(`${this.file}.3`).catch(() => {});
        for (let index = 2; index >= 0; index--) {
            await rename(index ? `${this.file}.${index}` : this.file, `${this.file}.${index + 1}`).catch(error => {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            });
        }
    }
}

export function auditRequest(audit: AuditPort, request: IncomingMessage, response: ServerResponse, route: string): string {
    const requestId = randomUUID(), startedAt = Date.now(), remoteAddress = request.socket.remoteAddress;
    response.setHeader('X-Request-ID', requestId);
    let finished = false;
    const record = () => {
        if (finished) return; finished = true;
        const parent = request.headers['x-parent-request-id'];
        audit.write({ event: response.writableFinished ? 'request.complete' : 'request.aborted', requestId,
            ...(typeof parent === 'string' && /^[a-f0-9-]{36}$/.test(parent) ? { parentRequestId: parent } : {}),
            remoteAddress, method: request.method, route,
            status: response.statusCode, durationMs: Date.now() - startedAt,
            ...(typeof response.getHeader('X-VFS-Error') === 'string' ? { code: String(response.getHeader('X-VFS-Error')) } : {}),
            ...(typeof response.getHeader('X-VFS-Operation') === 'string' ? { operation: String(response.getHeader('X-VFS-Operation')) } : {}) });
    };
    response.once('finish', record); response.once('close', record); return requestId;
}
