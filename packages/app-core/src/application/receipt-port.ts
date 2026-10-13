import { FSError } from '@itookit/vfs-core';
import type { ApplicationPort, ApplicationQueries, ApplicationCommands, ApplicationEvent } from './contracts';
import type { CommandReceipts } from './receipts';
import { validateApplicationCommand, validateApplicationQuery } from './validation';

/** Delivery guarantees decorate capabilities without changing their business implementation. */
export class ReceiptApplicationPort implements ApplicationPort {
    private closed = false;
    private readonly pending = new Set<Promise<unknown>>();
    private closing?: Promise<void>;
    constructor(private readonly port: ApplicationPort, private readonly receipts: CommandReceipts, private readonly identity: string) {}
    async query<K extends keyof ApplicationQueries>(name: K, input: ApplicationQueries[K]['input'], signal?: AbortSignal): Promise<ApplicationQueries[K]['output']> {
        if (this.closed) throw new FSError('EIO', 'Application client is closed');
        signal?.throwIfAborted(); validateApplicationQuery(name, input);
        const work: Promise<unknown> = name === 'receipt'
            ? this.receipts.read(this.identity, (input as ApplicationQueries['receipt']['input']).requestId)
            : this.port.query(name, input, signal).then(result => name === 'capabilities' ? { ...result, receipts: true } : result);
        return this.track(work) as Promise<ApplicationQueries[K]['output']>;
    }
    command<K extends keyof ApplicationCommands>(name: K, input: ApplicationCommands[K]['input'], signal?: AbortSignal, requestId: string = globalThis.crypto.randomUUID()): Promise<ApplicationCommands[K]['output']> {
        if (this.closed) return Promise.reject(new FSError('EIO', 'Application client is closed'));
        signal?.throwIfAborted(); validateApplicationCommand(name, input);
        const work = this.receipts.execute(this.identity, requestId, name, input, () => this.port.command(name, input, signal));
        return this.track(work);
    }
    private track<T>(work: Promise<T>): Promise<T> {
        this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {}); return work;
    }
    subscribe(listener: (event: ApplicationEvent) => void): () => void {
        if (this.closed) throw new FSError('EIO', 'Application client is closed');
        return this.port.subscribe(listener);
    }
    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true;
            this.closing = Promise.allSettled(this.pending).then(() => this.port.close());
        }
        return this.closing;
    }
}
