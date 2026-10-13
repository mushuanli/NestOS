import type { FSNode } from '@itookit/vfs-core';
import type { HttpTransport } from './transport';

type NodeType = Pick<FSNode, 'type'> | null;
interface Pending {
    path: string; cancelled: boolean; abortBatch?(): void; cleanup(): void;
    resolve(value: NodeType): void; reject(error: unknown): void;
}

/** Merge view probes within one microtask; cancellation belongs to each caller, not its peers. */
export class StatBatch {
    private pending: Pending[] = [];
    constructor(private readonly transport: HttpTransport) {}
    read(path: string, signal?: AbortSignal): Promise<NodeType> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(signal.reason); return; }
            const row: Pending = { path, cancelled: false, resolve, reject,
                cleanup: () => signal?.removeEventListener('abort', abort) };
            const abort = () => { row.cancelled = true; reject(signal?.reason); row.abortBatch?.(); };
            signal?.addEventListener('abort', abort, { once: true });
            this.pending.push(row);
            if (this.pending.length === 1) queueMicrotask(() => { void this.flush(); });
        });
    }
    private async flush(): Promise<void> {
        const pending = this.pending.splice(0), active = pending.filter(row => !row.cancelled);
        if (!active.length) { for (const row of pending) row.cleanup(); return; }
        const paths = [...new Set(active.map(row => row.path))], controller = new AbortController();
        for (const row of active) row.abortBatch = () => { if (active.every(item => item.cancelled)) controller.abort(); };
        try {
            const values: NodeType[] = [];
            for (let offset = 0; offset < paths.length; offset += 1000) {
                const batch = paths.slice(offset, offset + 1000);
                values.push(...(batch.length === 1 ? [await this.transport.call<NodeType>('statType', batch, controller.signal)]
                    : await this.transport.call<NodeType[]>('statTypes', [batch], controller.signal)));
            }
            const rows = new Map(paths.map((path, index) => [path, values[index]]));
            for (const row of active) if (!row.cancelled) row.resolve(rows.get(row.path) ?? null);
        } catch (error) { for (const row of active) if (!row.cancelled) row.reject(error); }
        finally { for (const row of pending) row.cleanup(); }
    }
}
