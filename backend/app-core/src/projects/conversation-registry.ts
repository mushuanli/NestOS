import {FSError} from '@itookit/vfs-core';
import type {ProjectConversationPort} from '@itookit/app-contracts/services';

interface Entry {source: ProjectConversationPort; references: number; release: () => void; closing: boolean}
/** Native execution and queued work belong to the host, across individual view leases. */
export class ConversationRegistry {
    private readonly entries = new Map<string, Promise<Entry>>();
    private closed = false;
    async acquire(key: string, create: () => Promise<ProjectConversationPort>): Promise<ProjectConversationPort> {
        if (this.closed) throw new FSError('EIO', 'Conversation registry closed');
        let pending = this.entries.get(key);
        if (!pending) {
            pending = create().then(source => {
                const entry: Entry = {source, references: 0, release: () => {}, closing: false};
                entry.release = source.subscribe(() => {void this.collect(key, entry).catch(error => {
                    console.warn('[Conversation] Background release failed', {operation: 'conversation.release', code: (error as {code?: string}).code ?? 'EIO'});
                });});
                return entry;
            });
            this.entries.set(key, pending);
            void pending.catch(() => {if (this.entries.get(key) === pending) this.entries.delete(key);});
        }
        const entry = await pending;
        if (entry.closing) return this.acquire(key, create);
        entry.references++;
        return this.lease(key, entry);
    }
    private lease(key: string, entry: Entry): ProjectConversationPort {
        let closed = false;
        const subscriptions = new Set<() => void>();
        return new Proxy(entry.source, {get: (target, property) => {
            if (property === 'close') return async () => {
                if (closed) return; closed = true;
                for (const release of subscriptions) release(); subscriptions.clear();
                entry.references--; await this.collect(key, entry);
            };
            if (property === 'subscribe') return (listener: () => void) => {
                if (closed) throw new FSError('EIO', 'Conversation view closed');
                const release = target.subscribe(listener); subscriptions.add(release);
                return () => {subscriptions.delete(release); release();};
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? (...args: unknown[]) => {
                if (closed) throw new FSError('EIO', 'Conversation view closed');
                return Reflect.apply(value, target, args);
            } : value;
        }});
    }
    private async collect(key: string, entry: Entry): Promise<void> {
        const snapshot = entry.source.snapshot(), queue = snapshot.instructionQueue;
        const controls = snapshot.controls?.some(row => row.receipt === 'unknown' || row.receipt === 'accepted' && row.effect === 'unconfirmed');
        if (entry.references || entry.closing || controls || snapshot.pendingQueryReports?.length || queue?.items.length && !queue.paused) return;
        entry.closing = true; this.entries.delete(key); entry.release();
        await entry.source.close();
    }
    async dispose(): Promise<void> {
        this.closed = true;
        const entries = [...this.entries.values()]; this.entries.clear();
        await Promise.all(entries.map(async pending => {
            const entry = await pending; entry.closing = true; entry.release(); await entry.source.close();
        }));
    }
}
