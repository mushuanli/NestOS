import { ApplicationEventStream, type EventSourceFactory } from './application-event-stream';
import { FSError, type FSErrorCode } from '@itookit/vfs-core';
import type { ApplicationPort, ApplicationQueries, ApplicationCommands, ApplicationEvent } from '@itookit/app-contracts/application';

/** Only this adapter knows HTTP. Failed or ambiguous commands are never replayed. */
export class HttpApplicationPort implements ApplicationPort {
    private closed = false;
    private closing?: Promise<void>;
    private readonly events: ApplicationEventStream;
    private readonly listeners = new Set<(event: ApplicationEvent) => void>();
    constructor(private readonly endpoint = '/api/application', private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
        private readonly clientId: string = globalThis.crypto.randomUUID(), eventSource?: EventSourceFactory) {
        this.events = new ApplicationEventStream(endpoint, clientId, event => this.publish(event), eventSource);
    }
    private publish(event: ApplicationEvent): void {
        for (const listener of this.listeners) {
            try { listener(event); } catch (error) { console.warn('[Application] Event listener failed', error); }
        }
    }
    query<K extends keyof ApplicationQueries>(name: K, input: ApplicationQueries[K]['input'], signal?: AbortSignal): Promise<ApplicationQueries[K]['output']> {
        return this.call('query', name, input, signal);
    }
    command<K extends keyof ApplicationCommands>(name: K, input: ApplicationCommands[K]['input'], signal?: AbortSignal, requestId: string = globalThis.crypto.randomUUID()): Promise<ApplicationCommands[K]['output']> {
        return this.call('command', name, input, signal, requestId);
    }
    subscribe(listener: (event: ApplicationEvent) => void): () => void {
        if (this.closed) throw new FSError('EIO', 'Application client is closed');
        this.listeners.add(listener); this.events.start();
        return () => { this.listeners.delete(listener); if (!this.listeners.size) this.events.close(); };
    }
    private async call<T>(kind: 'query' | 'command' | 'close', name?: string, input?: unknown, signal?: AbortSignal, requestId?: string): Promise<T> {
        if (this.closed && kind !== 'close') throw new FSError('EIO', 'Application client is closed');
        signal?.throwIfAborted();
        const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, name, input, requestId, clientId: this.clientId }), signal });
        const payload = await response.json().catch(() => { throw new FSError('EIO', `Invalid application response (HTTP ${response.status})`); }) as { result?: T; error?: { code: FSErrorCode; message: string } };
        if (!response.ok) throw new FSError(payload.error?.code ?? 'EIO', payload.error?.message ?? `HTTP ${response.status}`);
        return payload.result as T;
    }
    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true; this.listeners.clear(); this.events.close(); this.closing = this.call('close');
        }
        return this.closing;
    }
}
