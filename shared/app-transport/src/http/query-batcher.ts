import type { Call, Reply } from '../rpc/protocol';
import { FSError } from '@itookit/vfs-core';

interface Pending { call: Call; resolve(reply: Reply): void; reject(error: unknown): void }
/** Only independent read queries share a request; commands retain their own acknowledgement. */
export class QueryBatcher {
    private pending: Pending[] = [];
    private scheduled = false;
    private active = 0;
    private count = 0;
    private closed?: Error;
    constructor(private readonly send: (calls: Call[]) => Promise<Reply[]>, private readonly apply: (updates: Reply['updates']) => void | Promise<void>) {}
    query(call: Call): Promise<Reply> {
        return new Promise((resolve, reject) => {
            if (this.closed) { reject(this.closed); return; }
            if (this.count >= 1024) { reject(new FSError('EBUSY', 'View query queue is full')); return; }
            this.count++;
            this.pending.push({ call, resolve, reject });
            this.schedule();
        });
    }
    private schedule(): void {
        if (this.closed || this.scheduled || !this.pending.length || this.active >= 2) return;
        this.scheduled = true; queueMicrotask(() => {
            this.scheduled = false;
            while (this.pending.length && this.active < 2) {
                this.active++; void this.flush(this.pending.splice(0, 32));
            }
        });
    }
    private async flush(pending: Pending[]): Promise<void> {
        try {
            const replies = await this.send(pending.map(item => item.call));
            if (replies.length !== pending.length) throw new Error('Invalid view query batch');
            for (const reply of replies) await this.apply(reply.updates);
            pending.forEach((item, index) => item.resolve({ ...replies[index], updates: [] }));
        } catch (error) { pending.forEach(item => item.reject(error)); }
        finally { this.count -= pending.length; this.active--; this.schedule(); }
    }
    close(): void {
        this.closed = new FSError('EIO', 'View closed');
        const pending = this.pending.splice(0); this.count -= pending.length;
        pending.forEach(item => item.reject(this.closed));
    }
}
