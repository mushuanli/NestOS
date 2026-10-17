import {FSError} from '@itookit/vfs-core';
import {SnapshotCache} from '@itookit/app-transport/http';
import type {Reply, WireValue} from '@itookit/app-transport/rpc';
import type {RpcPeer} from '@itookit/app-transport/application';
import type {OpenViewRequest} from '@itookit/app-contracts/services';
import type {HostedView} from './view-services';
import type {ViewNotifications} from './view-notifications';

export interface BootstrapClient {
    peer: RpcPeer; view: HostedView; notifications: ViewNotifications; initialized: boolean;
    bootstrap?: Promise<Reply>; stopObservation?: () => void;
}
export interface BootstrapRequest {initialView?: OpenViewRequest; knownSnapshots?: string[];}

/** Establish the target and observation before exposing the first client capability graph. */
export async function bootstrapView(client: BootstrapClient, request: BootstrapRequest, cache: SnapshotCache): Promise<object> {
    if (client.bootstrap) throw new FSError('EBUSY', 'Application view is already initialized');
    client.bootstrap = prepareBootstrap(client, request.initialView);
    const reply = await client.bootstrap;
    client.initialized = true;
    return request.knownSnapshots ? cache.pack(reply as unknown as WireValue, request.knownSnapshots) : reply;
}
async function prepareBootstrap(client: BootstrapClient, request?: OpenViewRequest): Promise<Reply> {
    const initialView = request ? await client.view.root.backend.openView(request) : undefined;
    if (initialView) client.stopObservation = await initialView.observation.observeView(initialView.cursor, event => client.notifications.enqueueView(event));
    return client.peer.bootstrap({...client.view.root, ...(initialView ? {initialView} : {})});
}
