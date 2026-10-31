import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '@itookit/app-core';
import {RpcPeer, installViewProjections} from '@itookit/app-transport/application';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createHostedView} from '@itookit/node-host/http';

it('carries package management, installation reports, import results and recovery retries over real RPC capabilities', async () => {
    const packages = [{id: 'external', version: '1', tools: [{id: 'external.read'}], status: 'registered' as const, configuration: {enabled: false, defaults: {}, tools: []}, guide: {version: 1 as const, title: 'Setup', steps: [{title: 'Register', description: 'Always available', command: 'example --help'}]}}];
    const configure = vi.fn(async () => {});
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
        toolDependencies: {configure, list: async () => packages, ensure: async dependencies => ({tools: dependencies.map(item => ({...item, status: 'missing' as const, code: 'TOOL_NOT_REGISTERED'}))})}});
    const view = await createHostedView(runtime), calls: string[] = [];
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => {calls.push(call.method); return server.handle(call);}, console.error, installViewProjections);
    server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);}, console.error, undefined, domains => view.prepare(server, domains));
    try {
        const root = client.decode(await server.expose(view.root)); client.applyUpdates(await server.refresh());
        const toolbox = await root.backend.toolboxView();
        expect(await toolbox.resources.toolPackages.list()).toEqual(packages);
        const settings = {enabled: true, defaults: {'external.read': {directory: 'my-files'}}};
        await toolbox.resources.toolPackages.configure('external', '1', settings);
        expect(configure).toHaveBeenCalledWith('external', '1', settings);
        const report = await toolbox.resources.flowInstallations.check('anki-generate');
        expect(await root.backend.flowInstallations.check('anki-generate')).toEqual(report);
        expect(report.status).toBe('missingTools'); expect(report.tools.some((tool: {id: string}) => tool.id === 'anki.package')).toBe(true);
        const initial = await root.backend.initialFiles(), [result] = await initial.restore(['flow:anki-generate']);
        expect(result.status).toBe('restored');
        expect(result.dependencies.status).toBe('missingTools');
        expect((await initial.prepareDependencies(['flow:anki-generate']))[0].flowId).toBe('anki-generate');
        const data = {id: 'imported', name: 'Imported', draftVersion: 1, updatedAt: 0, layout: {}, edges: [],
            toolDependencies: [{id: 'fixture.unregistered', version: '1'}], nodes: [{id: 'value', name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: 'Ready'}}]};
        const imported = await toolbox.resources.importWithReport(JSON.stringify({format: 'itookit.toolbox', version: 1, entries: [{kind: 'flows', data}]}));
        expect(imported.paths).toHaveLength(1); expect(imported.installations[0]).toMatchObject({status: 'missingTools', tools: [{id: 'fixture.unregistered', code: 'TOOL_NOT_REGISTERED'}]});
        const flow = {...data, connections: [{name: 'vision', requirements: {operation: 'chat', inputModalities: ['image']}}]};
        await expect(root.services.commandBus.execute(SessionCommand.CheckFlowConnections, {flow})).rejects.toMatchObject({
            code: 'FLOW_CONNECTION_BINDING_MISSING', field: 'vision',
        });
        await expect(root.services.commandBus.execute(SessionCommand.CheckFlowConnections,
            {flow: {...flow, connections: [{name: '图片识别'}]}})).rejects.toMatchObject({field: '图片识别'});
        expect(calls).toEqual(expect.arrayContaining(['check', 'prepareDependencies', 'importWithReport']));
    } finally {await client.close(); await server.close(); await view.close(); await runtime.dispose();}
});
