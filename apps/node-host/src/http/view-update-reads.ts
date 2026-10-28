import {randomUUID} from 'node:crypto';
import {FSError} from '@itookit/vfs-core';
import {MAX_BODY_BYTES} from '@itookit/app-transport/rpc';
import type {AuditPort} from '../logging/audit-log';

interface Entry {data: string; bytes: number; expires: number}
const inlineBytes = 64 * 1024, maxEntries = 32, lifetimeMs = 60000;

/** Large prepared updates are read over HTTP; no Session activation or command is repeated. */
export class ViewUpdateReads {
    private readonly entries = new Map<string, Entry>();
    private bytes = 0;
    constructor(private readonly audit?: AuditPort) {}
    stage(data: string): string {
        const size = Buffer.byteLength(data); if (size <= inlineBytes) return data;
        const id = randomUUID(), started = Date.now();
        this.prune(started);
        if (size > MAX_BODY_BYTES) {
            this.report(id, 'prepare', started, 'VIEW_UPDATE_TOO_LARGE', undefined, size);
            throw new FSError('EFBIG', 'Prepared view update exceeds the read limit');
        }
        while (this.entries.size && (this.entries.size >= maxEntries || this.bytes + size > MAX_BODY_BYTES)) this.remove(this.entries.keys().next().value!);
        this.entries.set(id, {data, bytes: size, expires: started + lifetimeMs}); this.bytes += size;
        this.report(id, 'prepare', started, undefined, undefined, size);
        return JSON.stringify({updatesRead: id});
    }
    read(id: string, requestId?: string): object {
        const started = Date.now(); this.prune(started);
        const entry = this.entries.get(id);
        if (!entry) {
            this.report(id, 'read', started, 'VIEW_UPDATE_EXPIRED', requestId);
            throw new FSError('ENOENT', 'Prepared view update expired');
        }
        this.report(id, 'read', started, undefined, requestId, entry.bytes);
        return JSON.parse(entry.data);
    }
    clear(): void {this.entries.clear(); this.bytes = 0;}
    private remove(id: string): void {this.bytes -= this.entries.get(id)!.bytes; this.entries.delete(id);}
    private prune(now: number): void {for (const [id, entry] of this.entries) if (entry.expires <= now) this.remove(id);}
    private report(operationId: string, stage: string, started: number, code?: string, requestId?: string, bytes?: number): void {
        try {this.audit?.write({event: 'view.update.read', operation: 'view.update', operationId, requestId, stage,
            result: code ? 'failure' : 'success', code, bytes, durationMs: Date.now() - started});}
        catch { /* Diagnostics cannot change a prepared update. */ }
    }
}
