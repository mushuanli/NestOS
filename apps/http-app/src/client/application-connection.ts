import { randomUUID } from '@itookit/common';
import {HttpViewClient, SnapshotCache, ViewExpiredError} from '@itookit/app-transport/http';
import {initialView} from './initial-view';

export type ConnectionState = 'connected' | 'reconnecting' | 'expired' | 'view-error';
/** A late UI subscriber receives the latest connection state before further notifications. */
class ConnectionStatus {
    private state: ConnectionState = 'connected';
    private readonly listeners = new Set<(state: ConnectionState) => void>();
    subscribe(listener: (state: ConnectionState) => void): () => void {
        this.listeners.add(listener); listener(this.state);
        return () => {this.listeners.delete(listener);};
    }
    publish(state: ConnectionState): void {
        if (this.state === state || this.state === 'view-error' || this.state === 'expired') return;
        this.state = state;
        for (const listener of this.listeners) {
            try {listener(state);} catch {console.warn('[HTTP] Status observer failed');}
        }
        const event = state === 'connected' ? new Event('nestos:http-reconnected') : state === 'view-error'
            ? new Event('nestos:http-view-error') : new CustomEvent('nestos:http-disconnected', {detail: {state}});
        window.dispatchEvent(event);
    }
    close(): void {this.listeners.clear();}
}

/** Begin data transfer before importing the DOM shell and editor implementation. */
export function connectApplication() {
    const listeners = new AbortController(), route = initialView(location.hash), status = new ConnectionStatus();
    const client = new HttpViewClient(randomUUID(), '/api/application', globalThis.fetch.bind(globalThis),
        error => status.publish(error instanceof ViewExpiredError ? 'expired' : 'reconnecting'),
        () => status.publish('view-error'), () => status.publish('connected'));
    for (const event of ['online', 'focus', 'nestos:http-retry']) window.addEventListener(event, () => client.retryConnection(), {signal: listeners.signal});
    document.addEventListener('visibilitychange', () => {if (!document.hidden) client.retryConnection();}, {signal: listeners.signal});
    window.addEventListener('pageshow', () => client.retryConnection(), {signal: listeners.signal});
    const snapshots = new SnapshotCache({read: () => sessionStorage.getItem('mindos.snapshot-cache.v14'),
        write: value => sessionStorage.setItem('mindos.snapshot-cache.v14', value)});
    const ready = client.start({initialView: route.request, snapshots}).then(root => {performance.mark('nestos:data-ready'); return root;});
    return {ready, editor: route.editor, subscribeStatus: (listener: (state: ConnectionState) => void) => status.subscribe(listener),
        close: async () => {listeners.abort(); status.close(); await client.close();}};
}
export type ApplicationConnection = ReturnType<typeof connectApplication>;
