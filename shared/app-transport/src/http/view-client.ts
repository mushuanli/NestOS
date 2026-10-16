import type { HostedApplicationClient } from '@itookit/app-contracts/services';
import { FSError } from '@itookit/vfs-core';
import { RpcPeer } from '../application/peer';
import type { Reply, CallbackRequest, Call } from '../rpc/protocol';
import { RPC_VERSION } from '../rpc/protocol';
import { installViewProjections } from '../application/projections';
import { QueryBatcher } from './query-batcher';
import { installFileTransport } from './file-transport';

type NotificationPacket = Partial<CallbackRequest> & Pick<Reply, 'updates'> & { calls?: Call[] };

/** HTTP commands are never automatically replayed after an unknown outcome. */
export class HttpViewClient {
    readonly peer: RpcPeer;
    private readonly abort = new AbortController();
    private listening?: Promise<void>;
    private callbacks: Promise<void> = Promise.resolve();
    private closing = false;
    private disconnected = false;
    private pendingNotifications = 0;
    private notificationBytes = 0;
    private initialized!: () => void;
    private readonly ready = new Promise<void>(resolve => { this.initialized = resolve; });
    private readonly queries: QueryBatcher;
    private readonly bindings: QueryBatcher;
    constructor(private readonly clientId: string, private readonly url = '/api/application', private readonly fetcher = globalThis.fetch.bind(globalThis), private readonly onDisconnected?: (error: unknown) => void) {
        this.queries = this.batcher('queries'); this.bindings = this.batcher('bindings');
        this.peer = new RpcPeer('client', call => this.peer.remoteQuery(call) ? this.queries.query(call)
            : this.peer.remoteBinding(call) ? this.bindings.query(call) : this.post({ kind: 'call', call }),
            error => console.error('[View]', error), installViewProjections);
        installFileTransport(this.peer, this.url, this.clientId, this.abort.signal, this.fetcher, error => this.showDisconnected(error));
    }
    private batcher(kind: 'queries' | 'bindings'): QueryBatcher {
        return new QueryBatcher(calls => this.post({ kind, calls }).then(reply => {
            if (reply.error) throw new Error(reply.error.message);
            const replies = reply.replies!; if (replies[0]) replies[0].updates = reply.updates; return replies;
        }), async updates => { this.peer.applyUpdates(updates); await this.peer.waitUpdates(updates); });
    }
    async start(): Promise<HostedApplicationClient> {
        const response = await this.fetcher(`${this.url}/events?clientId=${encodeURIComponent(this.clientId)}`, { signal: this.abort.signal });
        if (!response.ok || !response.body) throw new FSError('EIO', 'View subscription failed');
        this.listening = this.consume(response.body);
        void this.listening.catch(error => { if (!this.abort.signal.aborted) this.showDisconnected(error); });
        const reply = await this.post({ kind: 'bootstrap' });
        if (reply.error) throw new Error(reply.error.message);
        this.peer.applyUpdates(reply.updates);
        const root = this.peer.decode(reply.value!) as HostedApplicationClient;
        this.initialized();
        await this.callbacks;
        return root;
    }
    private async post(body: object): Promise<Reply & { replies?: Reply[] }> {
        const response = await this.fetcher(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, clientId: this.clientId, version: RPC_VERSION }), signal: this.abort.signal })
            .catch(error => { if (!this.abort.signal.aborted) this.showDisconnected(error); throw error; });
        if (response.headers.get('X-MindOS-View-Expired') === '1') this.showDisconnected(new FSError('ECAPABILITY', 'View expired'));
        const reply = await response.json() as Reply & { replies?: Reply[] };
        if (!response.ok) throw Object.assign(new Error(reply.error?.message ?? 'View request failed'), reply.error);
        return reply;
    }
    private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '';
        try {
            while (!this.abort.signal.aborted) {
                const chunk = await reader.read(); if (chunk.done) throw new FSError('EIO', 'View stream disconnected');
                buffer += decoder.decode(chunk.value, { stream: true });
                let end: number;
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                    if (frame.startsWith('data: ')) {
                        const packet = JSON.parse(frame.slice(6));
                        // Blocking replies remain independent of notification delivery.
                        if (packet.id) void this.callback(packet).catch(error => this.showDisconnected(error));
                        else if (!this.enqueueNotification(packet, frame.length * 2)) return;
                    }
                }
            }
        } finally { reader.releaseLock(); }
    }
    private enqueueNotification(packet: NotificationPacket, bytes: number): boolean {
        const count = Math.max(1, packet.calls?.length ?? 0);
        this.pendingNotifications += count; this.notificationBytes += bytes;
        if (this.pendingNotifications > 256 || this.notificationBytes > 2 * 1024 * 1024) {
            this.showDisconnected(new FSError('EBUSY', 'View notification queue is full')); this.abort.abort(); return false;
        }
        this.callbacks = this.callbacks.then(() => this.callback(packet)).catch(error => this.showDisconnected(error))
            .finally(() => { this.pendingNotifications -= count; this.notificationBytes -= bytes; });
        return true;
    }
    private async callback(packet: NotificationPacket): Promise<void> {
        await this.ready;
        if (this.abort.signal.aborted) return;
        this.peer.applyUpdates(packet.updates);
        await this.peer.waitUpdates(packet.updates);
        for (const call of packet.calls ?? (packet.call ? [packet.call] : [])) {
            const reply = await this.peer.handle(call);
            if (packet.id) await this.post({ kind: 'reply', id: packet.id, reply });
        }
    }
    private showDisconnected(error: unknown): void {
        if (this.closing || this.disconnected) return;
        this.disconnected = true;
        console.error('[View] Connection lost', error);
        this.onDisconnected?.(error);
    }
    async close(): Promise<void> {
        this.closing = true; this.initialized(); this.queries.close(); this.bindings.close();
        try { await this.post({ kind: 'close' }); } finally { this.abort.abort(); await this.peer.close(); }
    }
}
