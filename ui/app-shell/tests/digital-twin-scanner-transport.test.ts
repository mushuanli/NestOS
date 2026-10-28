import {expect, it} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {RpcPeer, installViewProjections} from '@itookit/app-transport/application';
import {createHostedView} from '@itookit/node-host/http';

it('exposes independently authorized Twin workspace handles and scanner catalogs through RPC', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
        digitalTwinWorkspaces: [{twinId: 'team', ownerId: 'org:team', name: 'Team', kind: 'organization', authorize: async () => {}}]});
    const view = await createHostedView(runtime);
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
    server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);}, console.error, undefined, domains => view.prepare(server, domains));
    try {
        const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
        const personal = root.services.digitalTwin;
        expect((await personal.workspaces()).map((item: {id: string}) => item.id)).toEqual(['personal', 'team']);
        const org = await personal.openWorkspace('team');
        await org.addMemory({content: 'Shared through RPC'});
        expect((await org.snapshot()).memories[0].data.content).toBe('Shared through RPC');
        expect((await personal.snapshot()).memories).toHaveLength(0);
        expect(Array.isArray(await org.scannerTargets())).toBe(true);
        await expect(personal.openWorkspace('missing')).rejects.toThrow('TWIN_WORKSPACE_ACCESS_DENIED');
    } finally {await client.close(); await server.close(); await view.close(); await runtime.dispose();}
});
