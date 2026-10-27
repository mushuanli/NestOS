import {expect, it, vi} from 'vitest';
import {Kernel} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {DurableFlowExecutor, createBuiltinDagPluginRegistry, registerDurablePrograms} from '@itookit/llm-flow';
import {ToolProgram, HarnessProgram, HarnessExecutionEffect, ToolCallEffectAdapter} from '@itookit/kernel-adapters';
import {ToolDeviceDriver} from '@itookit/tools';
import type {HarnessConnectionSnapshot} from '@itookit/kernel-adapters/contracts';

it('passes tool material through a Harness and into a final save tool without a local model', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/'), kernel = new Kernel({catalog: {fs}, pollMs: 5});
    kernel.registerStorageResolver({kind: 'test', resolve: async () => ({fs, rootPath: '/run'})});
    registerDurablePrograms(kernel); kernel.registerProgram(new ToolProgram()); kernel.registerProgram(new HarnessProgram());
    const tools = new ToolDeviceDriver([]); await tools.init();
    const saved = vi.fn(async () => JSON.stringify({saved: true}));
    tools.registerTool({id: 'lookup', name: 'lookup', description: 'Lookup', type: 'plugin', enabled: true,
        outputEncoding: 'json', sideEffect: 'none', timeoutMs: 1000}, {name: 'lookup', parameters: {type: 'object'}}, async () => JSON.stringify({material: 'TOOL_MATERIAL'}));
    tools.registerTool({id: 'save', name: 'save', description: 'Save', type: 'plugin', enabled: true,
        outputEncoding: 'json', sideEffect: 'external', timeoutMs: 1000}, {name: 'save', parameters: {type: 'object', properties: {body: {type: 'string'}}, required: ['body']}}, saved);
    kernel.registerEffect(new ToolCallEffectAdapter(tools));
    const execute = vi.fn(async (request: {prompt: string}) => {
        expect(request.prompt).toContain('TOOL_MATERIAL');
        return {text: 'HARNESS_REPORT', sessionId: 'native', turnId: 'turn'};
    });
    kernel.registerEffect(new HarnessExecutionEffect({execute, reconcile: vi.fn(), cancel: vi.fn()}));
    const plugins = createBuiltinDagPluginRegistry();
    const executor = new DurableFlowExecutor({kernel, plugins, resolveTools: async (_session, ids) => ({
        definitions: tools.getToolDefinitions().filter(tool => ids.includes(tool.name!)), externalIds: ['save'],
    })});
    try {
        await kernel.initialize(); await kernel.createSession({id: 's', storage: {kind: 'test', locator: null}});
        const connection: HarnessConnectionSnapshot = {id: 'reviewer', name: 'Reviewer', kind: 'harness', version: 1, revision: 1,
            nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: {id: 'project'}};
        const run = await executor.submit('s', {nodes: [
            {id: 'fetch', name: 'Fetch', plugin: 'builtin.tool', pluginVersion: '1.0.0', inputs: {}, capabilities: ['lookup'],
                config: {toolId: 'lookup', toolVersion: '1', args: {}, approval: 'none'}},
            {id: 'work', name: 'Work', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, capabilities: [],
                config: {execution: {kind: 'harness', connectionId: 'reviewer'}, harnessConnection: connection as never,
                    messages: [{role: 'user', content: 'Summarize the supplied material'}]}},
            {id: 'save', name: 'Save', plugin: 'builtin.tool', pluginVersion: '1.0.0', inputs: {}, capabilities: ['save'],
                config: {toolId: 'save', toolVersion: '1', args: {}, inputArgument: 'body', approval: 'none'}},
        ], edges: [{id: 'input', from: 'fetch', to: 'work', output: 'result', input: 'input', kind: 'data'},
            {id: 'output', from: 'work', to: 'save', output: 'result', input: 'input', kind: 'data'}]});
        expect(await run.root.wait({timeoutMs: 3000})).toMatchObject({status: 'succeeded'});
        expect(execute).toHaveBeenCalledTimes(1);
        expect(saved).toHaveBeenCalledWith({body: 'HARNESS_REPORT'}, expect.anything());
    } finally {kernel.dispose(); await executor.waitIdle(); await kernel.waitIdle(); await tools.dispose(); await manager.dispose();}
});
