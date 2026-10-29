import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {RpcPeer, installViewProjections} from '@itookit/app-transport/application';
import {createHostedView} from '@itookit/node-host/http';

it('exposes independently authorized Twin workspace handles and scanner catalogs through RPC', async () => {
    const save = vi.fn(async () => {});
    const connections = {snapshot: async () => ({types: [{id: 'fixture', name: 'Fixture', description: '',
        fields: [{name: 'token', label: 'Token', secret: true}]}], connections: [{id: 'personal', type: 'fixture', name: 'Personal', values: {}, configuredSecrets: ['token']}]}),
        save, remove: async () => {}, register() {}, resolve: async () => ({token: 'host-private-token'})};
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false, toolConnections: connections,
        digitalTwinWorkspaces: [{twinId: 'team', ownerId: 'org:team', name: 'Team', kind: 'organization', authorize: async () => {}}]});
    const view = await createHostedView(runtime);
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), console.error, installViewProjections);
    server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);}, console.error, undefined, domains => view.prepare(server, domains));
    try {
        const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
        const personal = root.services.digitalTwin;
        const toolbox = await root.backend.toolboxView();
        expect(toolbox.resources.toolPackages.installFlows).toBeTypeOf('function');
        const accountPort = toolbox.resources.toolPackages.connections;
        expect((await accountPort.snapshot()).connections[0].configuredSecrets).toEqual(['token']);
        expect(accountPort.resolve).toBeUndefined(); expect(accountPort.register).toBeUndefined();
        await accountPort.save({id: 'personal', type: 'fixture', name: 'Personal', values: {token: 'from-tool-panel'}});
        expect(save).toHaveBeenCalledWith({id: 'personal', type: 'fixture', name: 'Personal', values: {token: 'from-tool-panel'}});
        expect((await personal.listSourceConnections()).connections[0]).toMatchObject({values: {}, configuredSecrets: ['token']});
        await personal.saveSourceConnection({id: 'personal', type: 'fixture', name: 'Personal', values: {token: 'private-token'}});
        expect(save).toHaveBeenCalledWith({id: 'personal', type: 'fixture', name: 'Personal', values: {token: 'private-token'}});
        expect(personal.resolve).toBeUndefined();
        expect(personal.sourceConnections).toBeUndefined();
        expect((await personal.workspaces()).map((item: {id: string}) => item.id)).toEqual(['personal', 'team']);
        const org = await personal.openWorkspace('team');
        await org.addMemory({content: 'Shared through RPC'});
        expect((await org.snapshot()).memories[0].data.content).toBe('Shared through RPC');
        expect((await personal.snapshot()).memories).toHaveLength(0);
        expect(Array.isArray(await org.scannerTargets())).toBe(true);
        await expect(personal.openWorkspace('missing')).rejects.toThrow('TWIN_WORKSPACE_ACCESS_DENIED');
    } finally {await client.close(); await server.close(); await view.close(); await runtime.dispose();}
});
