import { randomUUID } from '@itookit/common';
import {HttpViewClient, SnapshotCache, ViewExpiredError} from '@itookit/app-transport/http';
import {RPC_VERSION} from '@itookit/app-transport/rpc';
import {setFileRecoveryOwner} from '@itookit/app-shell/startup';
import {initialView} from './initial-view';

let pageUser: string | undefined;

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
    const identity = resolveUser();
    const fetcher: typeof fetch = async (input, init) => {
        const userId = await identity;
        const headers = new Headers(init?.headers); headers.set('X-NestOS-User', userId);
        return globalThis.fetch(input, {...init, headers});
    };
    const client = new HttpViewClient(randomUUID(), '/api/application', fetcher,
        error => status.publish(error instanceof ViewExpiredError ? 'expired' : 'reconnecting'),
        () => status.publish('view-error'), () => status.publish('connected'));
    for (const event of ['online', 'focus', 'nestos:http-retry']) window.addEventListener(event, () => client.retryConnection(), {signal: listeners.signal});
    document.addEventListener('visibilitychange', () => {if (!document.hidden) client.retryConnection();}, {signal: listeners.signal});
    window.addEventListener('pageshow', () => client.retryConnection(), {signal: listeners.signal});
    let started = false;
    const ready = identity.then(userId => {
        setFileRecoveryOwner(userId);
        const key = `mindos.snapshot-cache.v${RPC_VERSION}:${userId}`;
        const snapshots = new SnapshotCache({read: () => sessionStorage.getItem(key), write: value => sessionStorage.setItem(key, value)});
        started = true;
        return client.start({initialView: route.request, snapshots});
    }).then(root => {performance.mark('nestos:data-ready'); return root;});
    return {ready, editor: route.editor, subscribeStatus: (listener: (state: ConnectionState) => void) => status.subscribe(listener),
        close: async () => {listeners.abort(); status.close(); await client.close().catch(error => {if (started) throw error;});}};
}
export type ApplicationConnection = ReturnType<typeof connectApplication>;

async function resolveUser(): Promise<string> {
    const response = await globalThis.fetch('/api/identity', {cache: 'no-store'});
    if (!response.ok) throw new Error('Cannot verify certificate user; reload after checking certificate enrollment');
    const identity = await response.json() as {userId?: unknown};
    if (typeof identity.userId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(identity.userId)) throw new Error('Invalid certificate user');
    if (pageUser !== undefined && pageUser !== identity.userId) throw new Error('Certificate user changed; reload this page before continuing');
    pageUser = identity.userId;
    return identity.userId;
}
