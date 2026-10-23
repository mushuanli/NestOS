import { afterEach, expect, it, vi } from 'vitest';
import { createApplicationRuntime } from '@itookit/app-core';
import { MemoryBackend } from '@itookit/vfs-core';
import { RpcPeer, installViewProjections } from '@itookit/app-transport/application';
import { createHostedView } from '@itookit/node-host/http';
import type { HarnessExecutionConnection } from '@itookit/kernel-adapters/contracts';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });

async function setup() {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli',
        startupMode: 'interactive', digitalTwinAutoStart: false });
    releases.push(() => runtime.dispose());
    const targetQuery = vi.spyOn(runtime.agentService, 'getHarnessConnectionTargets').mockResolvedValue([
        { nodeConnectionId: 'node', projectId: 'project', projectName: 'Authorized project', available: true,
            profiles: [{ id: 'fixture', kind: 'fixture' }] },
    ]);
    const view = await createHostedView(runtime); releases.push(() => view.close());
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
    server = new RpcPeer('server', async call => { client.applyUpdates(await server.refresh()); return client.handle(call); },
        console.error, undefined, domains => view.prepare(server, domains));
    releases.push(() => client.close(), () => server.close());
    const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
    return { root, runtime, targetQuery };
}

it('manages nonsecret execution targets through the explicit application RPC port with CAS', async () => {
    const { root, runtime, targetQuery } = await setup(), service = root.services.agentService;
    const definition: HarnessExecutionConnection = { id: 'rpc-target', name: 'Remote fixture', kind: 'harness',
        nodeConnectionId: 'node', projectId: 'project', profileId: 'fixture', enabled: false };
    expect(targetQuery).not.toHaveBeenCalled();
    expect(await service.getHarnessConnectionTargets()).toEqual([{ nodeConnectionId: 'node', projectId: 'project',
        projectName: 'Authorized project', available: true, profiles: [{ id: 'fixture', kind: 'fixture' }] }]);
    expect(targetQuery).toHaveBeenCalledOnce();
    expect(await service.saveHarnessConnection(definition, 0)).toEqual({ version: 1, revision: 1, connection: definition });
    expect(await service.getHarnessConnections()).toEqual([definition]);
    expect(await service.getHarnessConnectionRecord(definition.id)).toMatchObject({ revision: 1, connection: definition });
    expect(await service.getHarnessConnection(definition.id)).toBeUndefined();
    await expect(service.saveHarnessConnection({ ...definition, name: 'Stale' }, 0)).rejects.toMatchObject({ code: 'ECONFLICT' });
    await expect(service.saveHarnessConnection({ ...definition, apiKey: 'do-not-persist' }, 1)).rejects.toMatchObject({ code: 'EINVAL' });
    expect((await runtime.executionConnections.get(definition.id))?.connection).toEqual(definition);
    expect(await service.removeHarnessConnection(definition.id, 1)).toMatchObject({ revision: 2, connection: null });
    expect(await service.getHarnessConnections()).toEqual([]);
    expect(service.configureHarnessConnections).toBeUndefined();
    expect(root.services.kernel.toolCatalog.saveHarnessConnection).toBeUndefined();
});
