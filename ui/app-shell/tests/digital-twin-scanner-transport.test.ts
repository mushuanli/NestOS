import {buildTool, TaskListTool} from '@itookit/tools';
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
    const invoke = vi.fn(async () => ({data: {count: 1}}));
    const tool = buildTool({name: 'fixture.rpc-collect', version: '1', inputSchema: TaskListTool.inputSchema, isReadOnly: () => true,
        async description() {return 'Collect fixture';}, async prompt() {return '';}, call: invoke,
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const runtime = await createApplicationRuntime({kernelPlatform: {additionalTools: [tool]}, backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false, toolConnections: connections,
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
        const selected = (await personal.collectionTools()).find((item: any) => item.target.id === tool.name);
        expect(selected.parameters).toMatchObject({type: 'object'});
        const id = await personal.saveScanRule(null, null, {name: 'RPC collector', collection: {target: selected.target}, mode: 'collect',
            trigger: 'event', include: [], exclude: [], intervalMinutes: 30, enabled: true});
        const run = await personal.triggerScanPlan(id, 'rpc-event');
        expect(await personal.triggerScanPlan(id, 'rpc-event')).toBe(run); await personal.waitScanRun(run);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect((await personal.snapshot()).scans.runs.find((item: any) => item.id === run).data.state).toBe('succeeded');
        const summary = await root.backend.assistantOverview();
        expect(summary.unavailable).toEqual([]);
        expect(summary.scanners).toContainEqual({id, name: 'RPC collector', workspaceId: 'personal', workspaceName: 'Personal'});
        expect(summary.events).toContainEqual(expect.objectContaining({kind: 'scanCompletion', target: {target: 'twin', resourceId: '/workspace/personal/runs/' + encodeURIComponent(run)}}));
        expect(JSON.stringify(summary)).not.toContain('host-private-token');
        expect((await personal.activitySummary()).plans).toContainEqual({id, name: 'RPC collector'});
        expect(personal.setCollector).toBeUndefined();
        await expect(personal.openWorkspace('missing')).rejects.toThrow('TWIN_WORKSPACE_ACCESS_DENIED');
    } finally {await client.close(); await server.close(); await view.close(); await runtime.dispose();}
});
