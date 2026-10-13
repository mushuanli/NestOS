import { FSError } from '@itookit/vfs-core';
import type { ApplicationRuntime } from '../runtime/create-application-runtime';
import { CommandReceipts } from './receipts';
import { ReceiptApplicationPort } from './receipt-port';
import { LocalApplicationPort } from './local';
import type { ApplicationPort } from './contracts';

/** One execution owner, many disposable clients. Hosting policy is supplied by the app. */
export class ApplicationHost {
    private ready?: Promise<ApplicationRuntime>;
    private readonly clients = new Map<string, Promise<ApplicationPort>>();
    private closed = false;
    private readonly receipts = new CommandReceipts(async () => (await this.start()).vfs.openFileSystem('/var/lib/application'));
    private closing?: Promise<void>;
    constructor(private readonly createRuntime: () => Promise<ApplicationRuntime>, private readonly workspaces: readonly string[],
        private readonly maxClients = 128) {}
    start(): Promise<ApplicationRuntime> {
        if (this.closed) return Promise.reject(new FSError('EIO', 'Application host is closed'));
        return this.ready ??= this.createRuntime().then(runtime => {
            if (!this.closed) runtime.startBackground?.(); return runtime;
        });
    }
    client(identity: string): Promise<ApplicationPort> {
        if (this.closed) return Promise.reject(new FSError('EIO', 'Application host is closed'));
        let client = this.clients.get(identity);
        if (!client) {
            if (this.clients.size >= this.maxClients) return Promise.reject(new FSError('EBUSY', 'Application client limit reached'));
            client = this.start().then(runtime => new ReceiptApplicationPort(new LocalApplicationPort(runtime, this.workspaces), this.receipts, identity));
            this.clients.set(identity, client);
            void client.catch(() => { if (this.clients.get(identity) === client) this.clients.delete(identity); });
        }
        return client;
    }
    async release(identity: string): Promise<void> {
        const client = this.clients.get(identity);
        if (!client) return;
        await (await client).close();
        if (this.clients.get(identity) === client) this.clients.delete(identity);
    }
    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true;
            this.closing = (async () => {
                const clients = await Promise.allSettled(this.clients.values());
                const results = await Promise.allSettled(clients.map(result => result.status === 'fulfilled' ? result.value.close() : undefined));
                this.clients.clear();
                const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
                if (this.ready) await this.ready.then(runtime => runtime.dispose()).catch(error => errors.push(error));
                if (errors.length) throw new AggregateError(errors, 'Application host cleanup failed');
            })();
        }
        return this.closing;
    }
}
