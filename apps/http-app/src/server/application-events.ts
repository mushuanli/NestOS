import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ApplicationPort, ApplicationEvent } from '@itookit/app-contracts/application';

interface EventRow { id: number; event: ApplicationEvent; bytes?: number }
interface EventSource {
    epoch: string; sequence: number; rows: EventRow[]; bytes: number; release(): void;
    responses: Set<ServerResponse>;
}

/** Bounded replay is observation only; a gap requires a fresh query, never command replay. */
export class ApplicationEvents {
    private readonly sources = new Map<string, EventSource>();
    constructor(private readonly historyLimit = 256, private readonly historyBytes = 2 * 1024 * 1024) {}
    active(identity: string): boolean { return Boolean(this.sources.get(identity)?.responses.size); }
    attach(identity: string, port: ApplicationPort, response: ServerResponse, cursor?: string, authorize: () => Promise<boolean> = async () => true): void {
        const source = this.source(identity, port);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        const [epoch, sequence] = (cursor ?? '').split(':');
        const position = Number(sequence), first = source.rows[0]?.id ?? source.sequence + 1;
        if (!cursor && source.sequence === 0) response.write(`id: ${source.epoch}:0\n\n`);
        else if (epoch !== source.epoch || !Number.isSafeInteger(position) || position < first - 1 || position > source.sequence)
            this.send(source, response, { id: source.sequence, event: { kind: 'invalidate', scope: 'all', revision: source.sequence } });
        else for (const row of source.rows) if (row.id > position) this.send(source, response, row);
        if (response.destroyed) return;
        source.responses.add(response);
        const heartbeat = setInterval(() => {
            void authorize().then(accepted => { if (accepted && !response.destroyed) response.write(': heartbeat\n\n'); else response.destroy(); })
                .catch(() => response.destroy());
        }, 15000);
        heartbeat.unref();
        response.once('close', () => { clearInterval(heartbeat); source.responses.delete(response); });
    }
    observe(identity: string, port: ApplicationPort): void { this.source(identity, port); }
    private source(identity: string, port: ApplicationPort): EventSource {
        const existing = this.sources.get(identity); if (existing) return existing;
        const source: EventSource = { epoch: randomUUID(), sequence: 0, rows: [], bytes: 0, release: () => {}, responses: new Set() };
        source.release = port.subscribe(event => {
            source.sequence = event.revision; const row = { id: event.revision, event, bytes: Buffer.byteLength(JSON.stringify(event)) };
            source.rows.push(row); source.bytes += row.bytes;
            while (source.rows.length > this.historyLimit || source.bytes > this.historyBytes) source.bytes -= source.rows.shift()!.bytes ?? 0;
            for (const response of source.responses) this.send(source, response, row);
        });
        this.sources.set(identity, source); return source;
    }
    private send(source: EventSource, response: ServerResponse, row: EventRow): void {
        if (response.destroyed) return;
        const frame = `id: ${source.epoch}:${row.id}\ndata: ${JSON.stringify(row.event)}\n\n`;
        if (Buffer.byteLength(frame) > 2 * 1024 * 1024 || response.writableLength > 2 * 1024 * 1024) { response.destroy(); return; }
        response.write(frame);
    }
    release(identity: string): void {
        const source = this.sources.get(identity); if (!source) return;
        source.release(); for (const response of source.responses) response.end(); this.sources.delete(identity);
    }
    close(): void { for (const identity of this.sources.keys()) this.release(identity); }
}
