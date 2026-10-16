import { createMindosFlowLibrary, type ApplicationRuntime } from '@itookit/app-core';
import { openApplicationView, restrictApplicationFiles } from '@itookit/app-core/host';
import { APPLICATION_WORKSPACES } from '@itookit/app-contracts';
import { createMindosLlmPresets } from '@itookit/kernel-adapters/llm/presets';
import type { ApplicationServices, ToolboxResources } from '@itookit/app-contracts/services';
import type { RpcPeer } from '@itookit/app-transport/application';
import type { ViewDomain } from '@itookit/app-transport/application';
import type { HostedApplicationClient } from '@itookit/app-contracts/services';

export interface HostedView { root: HostedApplicationClient; prepare(peer: RpcPeer, domains?: ReadonlySet<ViewDomain>): Promise<void>; close(): Promise<void> }
const ROOTS = ['/etc', '/home/admin', ...APPLICATION_WORKSPACES.map(name => `/home/admin/${name}`)];
/** Each browser owns view resources and bindings; execution remains daemon-owned. */
export async function createHostedView(runtime: ApplicationRuntime): Promise<HostedView> {
    const view = await openApplicationView(runtime, { preload: true });
    const client = restrictApplicationFiles(view, ROOTS);
    try {
        const root: HostedApplicationClient = { ...client, services: { ...client.services, startBackground: undefined },
            flowLibrary: createMindosFlowLibrary(), fileTemplates: { agent: JSON.stringify(createMindosLlmPresets().agents, null, 2) } };
        return { root, prepare: (peer, domains) => prepareSnapshots(peer, root.services, domains, runtime.projects.remoteMounts?.mountedProjectIds() ?? []),
            close: () => view.close() };
    } catch (error) { await view.close(); throw error; }
}
async function prepareSnapshots(peer: RpcPeer, services: ApplicationServices, domains?: ReadonlySet<ViewDomain>, projectIds: readonly string[] = []): Promise<void> {
    for (const id of services.vfs.devices.list()) peer.remember(services.vfs.devices, 'get', [id]);
    if (!domains || domains.has('configuration')) {
        for (const model of peer.localValues<ApplicationServices['agentService']>('IAgentManagementService'))
            for (const agent of model.listAgents()) peer.remember(model, 'getAgentResourceId', [agent.id]);
        for (const resource of peer.localValues<ToolboxResources>('ToolboxResources'))
            for (const provider of services.agentService.getProviders()) peer.remember(resource, 'hasProvider', [provider.id]);
    }
    if (!domains || domains.has('projects')) prepareProjectSnapshots(peer, services, projectIds);
}
function prepareProjectSnapshots(peer: RpcPeer, services: ApplicationServices, projectIds: readonly string[]): void {
    const remote = services.projects.remoteMounts;
    if (!remote) return;
    for (const connection of remote.connections()) for (const name of ['connection', 'connectionName', 'connectionDiagnostic', 'connectionStatus'])
        peer.remember(remote, name, [connection.id]);
    for (const id of projectIds) {
        for (const name of ['list', 'projectOffline', 'degraded']) peer.remember(remote, name, [id]);
        peer.remember(remote.sessionStatus, 'fileVersion', [id]);
        for (const mount of remote.list(id)) peer.remember(remote, 'status', [mount.mountId]);
    }
}
