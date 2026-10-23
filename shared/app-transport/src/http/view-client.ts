import type {ApplicationViewEvent, OpenViewRequest} from '@itookit/app-contracts/services';
import {SnapshotCache, type CachedReply} from './snapshot-cache';
import {ApplicationObservation} from './application-observation';
import type { HostedApplicationClient } from '@itookit/app-contracts/services';
import { FSError } from '@itookit/vfs-core';
import { RpcPeer } from '../application/peer';
import type { Reply, CallbackRequest, Call } from '../rpc/protocol';
import { RPC_VERSION } from '../rpc/protocol';
import { installViewProjections } from '../application/projections';
import { QueryBatcher } from './query-batcher';
import { installFileTransport } from './file-transport';
import { ViewExpiredError } from './view-expired';

type NotificationPacket = Partial<CallbackRequest> & Pick<Reply, 'updates'> & { calls?: Call[]; viewEvents?: ApplicationViewEvent[] };
export interface HttpViewStartOptions {initialView?: OpenViewRequest; snapshots?: SnapshotCache;}

/** HTTP commands are never automatically replayed after an unknown outcome. */
export class HttpViewClient {
    readonly peer: RpcPeer;
    private readonly applicationObservation = new ApplicationObservation();
    private readonly abort = new AbortController();
    private listening?: Promise<void>;
    private streamAbort = new AbortController();
    private lastEventId = 0;
    private resumable = false;
    private reconnectDelay = 0;
    private lastStreamActivity = 0;
    private streamConnected = false;
    private expired?: ViewExpiredError;
    private wake?: () => void;
    private callbacks: Promise<void> = Promise.resolve();
    private closing = false;
    private closeTask?: Promise<void>;
    private disconnected = false;
    private updateFailed = false;
    private pendingNotifications = 0;
    private notificationBytes = 0;
    private initialized!: () => void;
    private readonly ready = new Promise<void>(resolve => { this.initialized = resolve; });
    private readonly queries: QueryBatcher;
    private readonly bindings: QueryBatcher;
    constructor(private readonly clientId: string, private readonly url = '/api/application', private readonly fetcher = globalThis.fetch.bind(globalThis), private readonly onDisconnected?: (error: unknown) => void,
        private readonly onUpdateError?: (error: unknown) => void, private readonly onReconnected?: () => void) {
        this.queries = this.batcher('queries'); this.bindings = this.batcher('bindings');
        this.peer = new RpcPeer('client', call => this.peer.remoteQuery(call) ? this.queries.query(call)
            : this.peer.remoteBinding(call) ? this.bindings.query(call) : this.post({ kind: 'call', call }),
            error => console.error('[View]', error), installViewProjections);
        installFileTransport(this.peer, this.url, this.clientId, this.abort.signal, (input, init) => this.request(input, init));
    }
    private batcher(kind: 'queries' | 'bindings'): QueryBatcher {
        return new QueryBatcher(calls => this.post({ kind, calls }).then(reply => {
            if (reply.error) throw new Error(reply.error.message);
            const replies = reply.replies!; if (replies[0]) replies[0].updates = reply.updates; return replies;
        }), async updates => { this.peer.applyUpdates(updates); await this.peer.waitUpdates(updates); });
    }
    async start(options: HttpViewStartOptions = {}): Promise<HostedApplicationClient> {
        const snapshots = options.snapshots ?? new SnapshotCache(); await snapshots.load();
        const stream = this.startEventStream(); void stream.catch(() => {});
        const packet = await this.post({kind: 'bootstrap', initialView: options.initialView, knownSnapshots: snapshots.known()});
        const reply = await this.expandBootstrap(packet, snapshots);
        if (reply.error) throw new Error(reply.error.message);
        this.peer.applyUpdates(reply.updates);
        const root = this.peer.decode(reply.value!) as HostedApplicationClient;
        this.bindInitialObservation(root);
        this.initialized(); await stream; await this.callbacks;
        return root;
    }
    private async startEventStream(): Promise<void> {
        const response = await this.subscribe(false);
        this.resumable = response.headers.get('X-MindOS-View-Resume') === '1';
        this.listening = this.listen(response.body!);
        void this.listening.catch(error => this.showUpdateError(error));
    }
    private async expandBootstrap(packet: Reply, snapshots: SnapshotCache): Promise<Reply> {
        if (!('payload' in packet)) return packet;
        try {return await snapshots.unpack(packet as unknown as CachedReply) as unknown as Reply;}
        catch (error) {
            if (!(error instanceof FSError) || error.code !== 'ENOENT') throw error;
            // This only re-reads the already prepared reply; opening and activation are not replayed.
            return this.post({kind: 'bootstrap-data'});
        }
    }
    private bindInitialObservation(root: HostedApplicationClient): void {
        if (!root.initialView) return;
        const remote = root.initialView.observation, observation = this.applicationObservation;
        observation.initialize(root.initialView.cursor);
        root.initialView.observation = {
            getViewCursor: () => observation.getCursor(),
            getSessionBaseline: () => remote.getSessionBaseline(),
            observeView: async (after, listener) => observation.observe(after, listener),
            dispose: () => remote.dispose(),
        };
    }
    private async post(body: object): Promise<Reply & { replies?: Reply[] }> {
        const response = await this.request(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, clientId: this.clientId, version: RPC_VERSION }), signal: this.abort.signal });
        const reply = await response.json() as Reply & { replies?: Reply[] };
        if (!response.ok) throw Object.assign(new Error(reply.error?.message ?? 'View request failed'), reply.error);
        return reply;
    }
    private async request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        if (this.expired) throw this.expired;
        const response = await this.fetcher(input, init).catch(error => {
            if (!this.abort.signal.aborted && !init?.signal?.aborted) this.showDisconnected(error);
            throw error;
        });
        if (response.headers.get('X-MindOS-View-Expired') === '1') {
            await response.body?.cancel(); this.expire(); throw this.expired;
        }
        return response;
    }
    private expire(): void {
        if (this.expired) return;
        this.expired = new ViewExpiredError(); this.abort.abort(); this.wake?.();
        if (!this.closing) this.onDisconnected?.(this.expired);
    }
    private async subscribe(resume: boolean): Promise<Response> {
        this.streamAbort = new AbortController();
        const timer = setTimeout(() => this.streamAbort.abort(), 5000);
        try {
            const response = await this.fetcher(`${this.url}/events?clientId=${encodeURIComponent(this.clientId)}&resume=1${resume ? `&after=${this.lastEventId}&version=${RPC_VERSION}` : ''}`, {
                signal: AbortSignal.any([this.abort.signal, this.streamAbort.signal]), cache: 'no-store', redirect: 'error' });
            if (response.headers.get('X-MindOS-View-Expired') === '1') { await response.body?.cancel(); this.expire(); throw this.expired; }
            if (!response.ok || !response.body) { await response.body?.cancel(); throw new FSError('EIO', `View subscription failed (${response.status})`); }
            if (resume && response.headers.get('X-MindOS-View-Resume') !== '1') { await response.body.cancel(); this.expire(); throw this.expired; }
            this.streamConnected = true; this.lastStreamActivity = Date.now();
            return response;
        } finally { clearTimeout(timer); }
    }
    private async listen(body: ReadableStream<Uint8Array>): Promise<void> {
        while (!this.abort.signal.aborted && !this.updateFailed && !this.closing) {
            const connectedAt = Date.now();
            try { await this.consume(body); } catch (error) {
                if (this.abort.signal.aborted || this.updateFailed || this.closing) return;
                this.showDisconnected(error);
            }
            if (!this.resumable || this.abort.signal.aborted || this.updateFailed || this.closing) return;
            this.streamConnected = false;
            // Headers alone do not prove a healthy stream; reset only after a stable connection.
            if (Date.now() - connectedAt >= 15000) this.reconnectDelay = 0;
            await this.ready;
            const response = await this.reconnect(); if (!response?.body) return;
            body = response.body; this.disconnected = false; this.onReconnected?.();
        }
    }
    private async reconnect(): Promise<Response | undefined> {
        while (!this.abort.signal.aborted && !this.updateFailed && !this.closing) {
            if (this.reconnectDelay) await this.pause(this.reconnectDelay);
            if (this.abort.signal.aborted || this.updateFailed || this.closing) return;
            this.reconnectDelay = this.reconnectDelay ? Math.min(this.reconnectDelay * 2, 15000) : 1000;
            try { return await this.subscribe(true); } catch {
                if (this.abort.signal.aborted) return;
            }
        }
    }
    retryConnection(): void {
        if (this.abort.signal.aborted || this.closing || this.updateFailed) return;
        if (this.wake) {this.wake(); return;}
        if (this.streamConnected && Date.now() - this.lastStreamActivity >= 30000) this.streamAbort.abort();
    }
    private pause(delay: number): Promise<void> {
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); this.wake = undefined; resolve(); };
            const timer = setTimeout(done, delay); this.wake = done;
            this.abort.signal.addEventListener('abort', done, { once: true });
        });
    }
    private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '';
        const signal = AbortSignal.any([this.abort.signal, this.streamAbort.signal]);
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', cancel, {once: true});
        let idle: ReturnType<typeof setTimeout> | undefined;
        try {
            while (!signal.aborted) {
                idle = setTimeout(() => this.streamAbort.abort(), 45000);
                const chunk = await reader.read(); if (chunk.done) throw new FSError('EIO', 'View stream disconnected');
                this.lastStreamActivity = Date.now();
                clearTimeout(idle);
                buffer += decoder.decode(chunk.value, { stream: true });
                if (buffer.length > 2 * 1024 * 1024) { this.showUpdateError(new FSError('EBUSY', 'View event is too large')); return; }
                let end: number;
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                    if (!this.consumeFrame(frame)) return;
                }
            }
        } finally { clearTimeout(idle); signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    private consumeFrame(frame: string): boolean {
        const lines = frame.split('\n'), data = lines.find(line => line.startsWith('data: '));
        if (!data) return true;
        try {
            const sequence = lines.find(line => line.startsWith('id: '));
            if (this.resumable && !sequence) throw new FSError('EIO', 'View event sequence is missing');
            if (sequence) {
                const id = Number(sequence.slice(4));
                if (!Number.isSafeInteger(id) || id < 1 || id > this.lastEventId + 1) throw new FSError('EIO', 'View event sequence gap');
                if (id <= this.lastEventId) return true;
                this.lastEventId = id;
            }
            const packet = JSON.parse(data.slice(6));
            if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new FSError('EIO', 'Invalid view event');
            // Blocking replies remain independent of notification delivery.
            if (packet.id) void this.callback(packet).catch(error => this.showUpdateError(error));
            else return this.enqueueNotification(packet, frame.length * 2);
            return true;
        } catch (error) { this.showUpdateError(error); this.abort.abort(); return false; }
    }
    private enqueueNotification(packet: NotificationPacket, bytes: number): boolean {
        const count = Math.max(1, (packet.calls?.length ?? 0) + (packet.viewEvents?.length ?? 0));
        this.pendingNotifications += count; this.notificationBytes += bytes;
        if (this.pendingNotifications > 256 || this.notificationBytes > 2 * 1024 * 1024) {
            this.showUpdateError(new FSError('EBUSY', 'View notification queue is full')); this.abort.abort(); return false;
        }
        this.callbacks = this.callbacks.then(() => this.callback(packet)).catch(error => this.showUpdateError(error))
            .finally(() => { this.pendingNotifications -= count; this.notificationBytes -= bytes; });
        return true;
    }
    private async callback(packet: NotificationPacket): Promise<void> {
        await this.ready;
        if (this.abort.signal.aborted) return;
        this.peer.applyUpdates(packet.updates);
        await this.peer.waitUpdates(packet.updates);
        for (const event of packet.viewEvents ?? []) this.applicationObservation.receive(event);
        for (const call of packet.calls ?? (packet.call ? [packet.call] : [])) {
            const reply = await this.peer.handle(call);
            if (packet.id) await this.post({ kind: 'reply', id: packet.id, reply });
            else if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
        }
    }
    private showUpdateError(error: unknown): void {
        if (this.closing || this.expired || this.updateFailed) return;
        this.updateFailed = true;
        this.abort.abort(); this.wake?.();
        console.error('[View] Update failed', error);
        this.onUpdateError?.(error);
    }
    private showDisconnected(error: unknown): void {
        if (this.closing || this.disconnected) return;
        this.disconnected = true;
        this.streamAbort.abort();
        console.error('[View] Connection lost', error);
        this.onDisconnected?.(error);
    }
    close(): Promise<void> { return this.closeTask ??= this.closeView(); }
    private async closeView(): Promise<void> {
        this.closing = true; this.initialized(); this.applicationObservation.close(); this.queries.close(); this.bindings.close();
        this.wake?.();
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>(resolve => {
            timer = setTimeout(() => { this.abort.abort(); resolve(); }, 5000);
        });
        const drain = async () => {
            await this.peer.whenIdle();
            if (!this.abort.signal.aborted) await this.post({ kind: 'close' });
        };
        try {
            await Promise.race([drain(), deadline]);
        } finally {
            this.abort.abort();
            try { await Promise.race([Promise.allSettled([this.listening, this.peer.close()]), deadline]); }
            finally { clearTimeout(timer!); }
        }
    }
}
