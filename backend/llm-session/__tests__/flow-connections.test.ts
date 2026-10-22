import { expect, it } from 'vitest';
import type { FlowRevision } from '@itookit/llm-flow/contracts';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import { flowToDag } from '@itookit/llm-flow';
import { prepareFlowConnections } from '../src/session/flow-connections';
import { bindStandaloneFlowNode } from '../src/session/flow-node-binder';
import { checkFlowConnections } from '../src/session/flow-connection-check';
const provider: LLMProvider = { id: 'p', name: 'P', baseURL: 'https://example.test', implementation: 'openai-compatible',
    media: { 'image.generate': { adapter: 'openai-images' } }, models: [{ id: 'picture', name: 'Picture', operations: { 'image.generate': {
        inputModalities: ['text'], outputModalities: ['image'], formats: ['png'],
    } } }, { id: 'text', name: 'Text', supportsVision: false }] };
const catalog = { getProvider: () => provider, getConnection: async (id: string): Promise<ConnectionMeta> => ({
    id, name: id, providerId: 'p', model: id === 'pictures' ? 'picture' : 'text', enabled: true, hasApiKey: true, protocol: 'openai-chat',
}) };
const preflightCatalog = {...catalog, getDefaultConnection: async () => undefined};

it('resolves required media slots from purpose defaults and freezes the admitted selection', async () => {
    let defaults = { 'image.generate': 'pictures' };
    const models = { ...catalog, getModelDefaults: async () => defaults };
    const admitted = await prepareFlowConnections(flow(), {}, models);
    expect(admitted.connections![0]).toMatchObject({ connectionId: 'pictures', resolved: { modelId: 'picture' } });
    defaults = { 'image.generate': 'text' };
    const replay = await prepareFlowConnections(admitted, {}, models);
    expect(replay.connections![0].connectionId).toBe('pictures');
    await expect(prepareFlowConnections(flow(), { illustrations: 'text' }, models)).rejects.toThrow();
    await expect(prepareFlowConnections(flow(), { illustrations: '' }, models)).rejects.toThrow('Invalid connection');
});

it('honors a queued defaults snapshot and leaves optional media slots unbound', async () => {
    const models = { ...catalog, getModelDefaults: async () => ({ 'image.generate': 'text' }) };
    const admitted = await prepareFlowConnections(flow(), {}, models, { 'image.generate': 'pictures' });
    expect(admitted.connections![0].connectionId).toBe('pictures');
    const optional = flow(); optional.connections![0].required = false;
    expect((await prepareFlowConnections(optional, {}, models, { 'image.generate': 'pictures' })).connections![0].connectionId).toBeUndefined();
    const direct = flow(); direct.connections = []; delete (direct.nodes[0].config as any).connectionSlot;
    const resolved = await prepareFlowConnections(direct, {}, models, { 'image.generate': 'pictures' });
    expect(resolved.nodes[0].config).toMatchObject({ connectionId: 'pictures', modelName: 'picture' });
    await expect(prepareFlowConnections(flow(), {}, models, {})).rejects.toThrow('Missing connection');
});

it('admits an explicit run connection before consulting a purpose default for an unslotted node', async () => {
    const direct = flow(); direct.connections = []; delete (direct.nodes[0].config as any).connectionSlot;
    const models = { ...catalog, getModelDefaults: async () => ({ 'image.generate': 'text' }) };
    const dag = await flowToDag(direct, undefined, undefined, undefined, [], undefined, false, 'pictures', {},
        (definition, bindings, runConnectionId) => prepareFlowConnections(definition, bindings, models, undefined, runConnectionId));
    expect(dag.nodes[0].config).toMatchObject({ connectionId: 'pictures', modelName: 'picture' });
    await expect(flowToDag(direct, undefined, undefined, undefined, [], undefined, false, 'text', {},
        (definition, bindings, runConnectionId) => prepareFlowConnections(definition, bindings, { ...models, getModelDefaults: async () => ({ 'image.generate': 'pictures' }) }, undefined, runConnectionId))).rejects.toThrow();
});

it('preflights required and optional slots without creating a Session or calling a model', async () => {
    const definition = flow();
    await expect(checkFlowConnections({flow: definition}, preflightCatalog as never)).rejects.toMatchObject({code: 'FLOW_CONNECTION_INVALID'});
    await expect(checkFlowConnections({flow: definition, connectionBindings: {illustrations: 'text'}}, preflightCatalog as never)).rejects.toThrow('illustrations');
    await expect(checkFlowConnections({flow: definition, connectionBindings: {illustrations: 'pictures'}}, preflightCatalog as never)).resolves.toEqual({valid: true});
    definition.connections![0].required = false;
    await expect(checkFlowConnections({flow: definition}, preflightCatalog as never)).resolves.toEqual({valid: true});
});

it.each([{enabled: false}, {hasApiKey: false, credentialsReady: false}])('preflight rejects unavailable credentials or disabled connections: %j', async overrides => {
    await expect(checkFlowConnections({flow: flow(), connectionBindings: {illustrations: 'pictures'}}, {
        ...preflightCatalog, getConnection: async id => ({...await catalog.getConnection(id), ...overrides}),
    } as never)).rejects.toThrow('illustrations');
});
function flow(): FlowRevision {
    return { id: 'f' as never, name: 'F', revision: 1, digest: 'f', createdAt: 0, edges: [], connections: [{ name: 'illustrations' }], nodes: [
        { id: 'picture' as never, name: 'Picture', plugin: 'builtin.media', pluginVersion: '1.0.0', inputs: {}, config: {
            connectionSlot: 'illustrations', operation: 'image.generate', request: { prompt: 'A square', format: 'png' },
        } },
    ] };
}
it('binds media slots independently of the run connection and freezes actual models and routes', async () => {
    const dag = await flowToDag(flow(), undefined, 'text', undefined, [], undefined, false, 'text', { illustrations: 'pictures' },
        (definition, bindings) => prepareFlowConnections(definition, bindings, catalog));
    expect(dag.nodes[0].config).toMatchObject({ connectionId: 'pictures', modelName: 'picture', frozenConnection: { mediaEndpoint: expect.stringContaining('openai-images') } });
});
it('rejects missing bindings, wrong operations, unsupported formats and unknown binding names', async () => {
    await expect(prepareFlowConnections(flow(), {}, catalog)).rejects.toThrow('Missing connection');
    await expect(prepareFlowConnections(flow(), { illustrations: 'text' }, catalog)).rejects.toThrow('unknown');
    await expect(prepareFlowConnections(flow(), { unknown: 'pictures' }, catalog)).rejects.toThrow('Invalid connection');
    const invalid = flow(); (invalid.nodes[0].config as any).request.format = 'webp';
    await expect(prepareFlowConnections(invalid, { illustrations: 'pictures' }, catalog)).rejects.toThrow('format');
});
it('also freezes direct nodes and rejects a later route change', async () => {
    const definition = flow(); definition.connections = [];
    (definition.nodes[0].config as any).connectionSlot = undefined; (definition.nodes[0].config as any).connectionId = 'pictures';
    const admitted = await prepareFlowConnections(definition, {}, catalog); provider.baseURL = 'https://changed.test';
    try { await expect(prepareFlowConnections(admitted, {}, catalog)).rejects.toThrow('changed after admission'); }
    finally { provider.baseURL = 'https://example.test'; }
});
it('keeps an unbound optional media slot empty instead of inheriting a text connection', async () => {
    const definition = flow(); definition.connections![0].required = false;
    const dag = await flowToDag(definition, undefined, 'text', undefined, [], undefined, false, 'text', {},
        (value, bindings) => prepareFlowConnections(value, bindings, catalog));
    expect(dag.nodes[0].config).toMatchObject({ connectionId: '' });
    expect((dag.nodes[0].config as any).modelName).toBeUndefined();
});

it('allows an optional default binding to be explicitly cleared, including nested bindings', async () => {
    const definition = flow(); definition.connections![0] = { name: 'illustrations', required: false, connectionId: 'pictures' };
    const dag = await flowToDag(definition, undefined, 'text', undefined, [], undefined, false, 'text', { illustrations: '' },
        (value, bindings) => prepareFlowConnections(value, bindings, catalog));
    expect(dag.nodes[0].config).toMatchObject({ connectionId: '' });
    expect(definition.connections![0].connectionId).toBe('pictures');
    const parent = { ...definition, connections: [], nodes: [{ ...definition.nodes[0], id: 'child' as never,
        plugin: 'builtin.flow', config: { flowId: 'child' } }] };
    const nested = await flowToDag(parent, undefined, undefined, async () => definition, [], undefined, false, undefined,
        { 'child/illustrations': '' }, (value, bindings) => prepareFlowConnections(value, bindings, catalog));
    expect(nested.nodes[0].config).toMatchObject({ connectionId: '' });
    definition.connections![0].required = true;
    await expect(prepareFlowConnections(definition, { illustrations: '' }, catalog)).rejects.toThrow('Invalid connection');
});

it('checks Agent requirements on named slots and rejects media models for chat', async () => {
    const definition = flow();
    definition.nodes = [{ ...definition.nodes[0], plugin: 'builtin.agent', config: {
        connectionSlot: 'illustrations', connectionRequirements: { operation: 'chat', inputModalities: ['image'] },
    } }];
    await expect(prepareFlowConnections(definition, { illustrations: 'text' }, catalog)).rejects.toThrow('input capability');
    definition.nodes[0].config = { connectionSlot: 'illustrations' };
    // A media model with unknown chat support must not pass as a chat connection.
    provider.models[0].category = 'image';
    try { await expect(prepareFlowConnections(definition, { illustrations: 'pictures' }, catalog)).rejects.toThrow('chat'); }
    finally { delete provider.models[0].category; }
});

it('merges all node requirements on a shared slot and freezes them for execution', async () => {
    const definition = flow();
    definition.connections![0].requirements = { operation: 'chat', features: ['structuredOutput'] };
    definition.nodes = [{ ...definition.nodes[0], plugin: 'builtin.agent', config: { connectionSlot: 'illustrations' } }];
    await expect(prepareFlowConnections(definition, { illustrations: 'text' }, catalog)).rejects.toThrow('feature');
    provider.models[1].supportsStructuredOutput = true;
    try {
        const admitted = await prepareFlowConnections(definition, { illustrations: 'text' }, catalog);
        expect(admitted.nodes[0].config).toMatchObject({ connectionRequirements: { operation: 'chat', features: ['structuredOutput'] } });
    } finally { delete provider.models[1].supportsStructuredOutput; }
});

function agentFlow(): FlowRevision {
    const definition = flow();
    definition.connections = [];
    definition.nodes = [{ ...definition.nodes[0], plugin: 'builtin.agent', config: {
        connectionRequirements: { operation: 'chat', inputModalities: ['text', 'image'] },
    } }];
    return definition;
}

it.each(['defaults', 'run', 'fallback', 'binder'] as const)('validates the final connection selected by %s', async source => {
    const definition = agentFlow();
    if (source === 'defaults') definition.defaults = { connectionId: 'text' };
    const bind = source === 'binder' ? () => ({ config: { ...definition.nodes[0].config as object, connectionId: 'text' } }) : undefined;
    await expect(flowToDag(definition, bind, source === 'fallback' ? 'text' : undefined, undefined, [], undefined,
        false, source === 'run' ? 'text' : undefined, {}, (value, bindings) => prepareFlowConnections(value, bindings, catalog)))
        .rejects.toThrow('input capability');
});

it('freezes inherited connections and does not admit a connection replaced by the binder', async () => {
    const definition = agentFlow();
    definition.nodes[0].config = { connectionId: 'missing' };
    const dag = await flowToDag(definition, () => ({ config: {} }), 'text', undefined, [], undefined, false, undefined, {},
        (value, bindings) => prepareFlowConnections(value, bindings, {
            ...catalog, getConnection: async id => id === 'missing' ? null : catalog.getConnection(id),
        }));
    expect(dag.nodes[0].config).toMatchObject({ connectionId: 'text', modelName: 'text',
        frozenConnection: { providerId: 'p', modelId: 'text', requirements: { operation: 'chat' } } });
});

it('validates requirements inherited through the default slot without changing the definition', async () => {
    const definition = agentFlow();
    definition.connections = [{ name: 'default', connectionId: 'text' }];
    const saved = structuredClone(definition);
    await expect(flowToDag(definition, undefined, undefined, undefined, [], undefined, false, undefined, {},
        (value, bindings) => prepareFlowConnections(value, bindings, catalog))).rejects.toThrow('input capability');
    expect(definition).toEqual(saved);
});

it('retains requirements from an implicit default slot in the execution snapshot', async () => {
    const definition = agentFlow();
    definition.nodes[0].config = {};
    definition.connections = [{ name: 'default', connectionId: 'text', requirements: { operation: 'chat', features: ['structuredOutput'] } }];
    provider.models[1].supportsStructuredOutput = true;
    try {
        const dag = await flowToDag(definition, undefined, undefined, undefined, [], undefined, false, undefined, {},
            (value, bindings) => prepareFlowConnections(value, bindings, catalog));
        expect(dag.nodes[0].config).toMatchObject({ frozenConnection: { requirements: { features: ['structuredOutput'] } } });
    } finally { delete provider.models[1].supportsStructuredOutput; }
});

it('keeps nested slot bindings scoped and run connection ids distinct from slot aliases', async () => {
    const parent = agentFlow();
    parent.nodes[0].config = {};
    parent.connections = [{ name: 'text', connectionId: 'other', required: false }];
    parent.nodes.push({ ...parent.nodes[0], id: 'child' as never, plugin: 'builtin.flow', config: { flowId: 'child' } });
    const dag = await flowToDag(parent, undefined, undefined, async () => flow(), [], undefined, false, 'text',
        { 'child/illustrations': 'pictures' }, (value, bindings) => prepareFlowConnections(value, bindings, catalog));
    expect(dag.nodes.find(node => node.id === 'picture')!.config).toMatchObject({ connectionId: 'text', modelName: 'text' });
    expect(dag.nodes.find(node => node.id === 'child/picture')!.config).toMatchObject({ connectionId: 'pictures', modelName: 'picture' });
});

it.each([false, true])('does not inherit a different default model into an explicit slot (isolated=%s)', async isolated => {
    const definition = agentFlow();
    definition.defaults = { connectionId: 'obsolete', modelName: 'obsolete-model' };
    definition.connections = [{ name: 'worker', connectionId: 'text' }];
    definition.nodes[0].config = { connectionSlot: 'worker', instruction: 'Hello' };
    const resolver = { getSkills: async () => [], getSystemPrompt: async () => undefined, resolveExact: async () => ({}) };
    const bind = (node: FlowRevision['nodes'][number], defaults?: FlowRevision['nodes'][number]['config']) =>
        bindStandaloneFlowNode(node, defaults, 's', resolver as never);
    const dag = await flowToDag(definition, bind, undefined, undefined, [], undefined, isolated, undefined, {},
        (value, bindings) => prepareFlowConnections(value, bindings, catalog));
    expect(dag.nodes[0].config).toMatchObject({ connectionId: 'text', modelName: 'text' });
    expect(definition.defaults).toEqual({ connectionId: 'obsolete', modelName: 'obsolete-model' });
});

it('infers image capability from Agent message templates without relying on a manually declared requirement', async () => {
    const definition = agentFlow();
    definition.nodes[0].config = { connectionId: 'text', messageTemplates: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: '${param.image}' } }] }] };
    await expect(prepareFlowConnections(definition, {}, catalog)).rejects.toThrow('input capability');
});

it('forwards explicit parent slots to child slots and preserves nested runtime overrides', async () => {
    const child = agentFlow();
    child.nodes[0].config = { connectionId: 'writer' };
    child.connections = [{ name: 'writer', requirements: { operation: 'chat', inputModalities: ['text'] } }];
    child.outputs = { result: { value: 'done' } };
    const parent = { ...child, connections: [{ name: 'text' }], outputs: undefined, nodes: [{
        ...child.nodes[0], id: 'call' as never, plugin: 'builtin.flow', pluginVersion: '2.0.0',
        config: { flowId: 'child', connectionBindings: { writer: 'text' } },
    }] };
    const prepare = (value: FlowRevision, bindings?: Record<string, string>) => prepareFlowConnections(value, bindings, catalog);
    const dag = await flowToDag(parent, undefined, undefined, async () => child, [], undefined, false, undefined, { text: 'text' }, prepare);
    expect(dag.nodes.find(node => node.id.startsWith('call/'))?.config).toMatchObject({ connectionId: 'text' });
    const overridden = await flowToDag(parent, undefined, undefined, async () => child, [], undefined, false, undefined,
        { text: 'text', 'call/writer': 'pictures' }, prepare);
    expect(overridden.nodes.find(node => node.id.startsWith('call/'))?.config).toMatchObject({ connectionId: 'pictures' });
    parent.nodes[0].config.connectionBindings.writer = 'missing';
    await expect(flowToDag(parent, undefined, undefined, async () => child, [], undefined, false, undefined, { text: 'text' }, prepare)).rejects.toThrow('Unknown parent connection slot');
});

it.each([false, true])('keeps an unbound optional parent slot empty in a required child (multiple=%s)', async multiple => {
    const child = agentFlow();
    child.nodes[0].config = { connectionId: 'writer' };
    child.connections = [{ name: 'writer', required: true, connectionId: 'text' }];
    child.outputs = { result: { value: 'done' } };
    const parent = { ...child, connections: [{ name: 'secondary', required: false }], outputs: undefined, nodes: [{
        ...child.nodes[0], id: 'call' as never, plugin: 'builtin.flow', pluginVersion: '2.0.0',
        config: { flowId: 'child', connectionBindings: { writer: 'secondary' }, ...(multiple ? { parameterSets: [{}] } : {}) },
    }] };
    const prepare = (value: FlowRevision, bindings?: Record<string, string>) => prepareFlowConnections(value, bindings, {
        ...catalog, getModelDefaults: async () => ({ chat: 'text' }),
    });
    const dag = await flowToDag(parent, undefined, 'text', async () => child, [], undefined, false, 'text', {}, prepare);
    const nodes = multiple ? dag.functionCalls!['call__input'].child.nodes : dag.nodes;
    expect(nodes.find(node => node.plugin === 'builtin.agent')?.config).toMatchObject({ connectionId: '' });
    expect(child.connections[0]).toEqual({ name: 'writer', required: true, connectionId: 'text' });
});

it.each([false, true])('checks an unbound required child only when its branch executes (multiple=%s)', async multiple => {
    const { Kernel } = await import('@itookit/durable-kernel');
    const { createVFS, MemoryBackend } = await import('@itookit/vfs-core');
    const { DurableFlowExecutor, createBuiltinDagPluginRegistry, registerDurablePrograms } = await import('@itookit/llm-flow');
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/test');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve(descriptor) { return { fs, rootPath: '/s/' + String(descriptor.locator) }; } });
    registerDurablePrograms(kernel); await kernel.initialize();
    const executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry() });
    try {
        for (const selected of [false, true]) {
            const child = agentFlow();
            child.nodes[0].config = { connectionId: 'writer' };
            child.connections = [{ name: 'writer', required: true }];
            child.outputs = { result: { value: 'done' } };
            const parent = { ...child, connections: [{ name: 'secondary', required: false }], outputs: undefined,
                nodes: [{ id: 'choose', name: 'Choose', plugin: 'builtin.route', pluginVersion: '1.0.0', inputs: {},
                    config: { rules: [{ edgeId: 'take-call', expression: { kind: 'literal', value: selected } }], defaultEdgeId: 'take-safe' } },
                { id: 'call', name: 'Call', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
                    config: { flowId: 'child', connectionBindings: { writer: 'secondary' }, ...(multiple ? { parameterSets: [{}] } : {}) } },
                { id: 'safe', name: 'Safe', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'safe' } }],
                edges: [{ id: 'take-call', from: 'choose', to: 'call', kind: 'control' },
                    { id: 'take-safe', from: 'choose', to: 'safe', kind: 'control' }] } as FlowRevision;
            const sessionId = 's-' + selected;
            await kernel.createSession({ id: sessionId, storage: { kind: 'test', locator: sessionId } });
            const dag = await flowToDag(parent, undefined, 'text', async () => child, [], undefined, false, 'text', {},
                (value, bindings) => prepareFlowConnections(value, bindings, catalog));
            const run = await executor.submit(sessionId, dag);
            const exit = await run.root.wait({ timeoutMs: 5000 });
            expect(exit.status).toBe(selected ? 'failed' : 'succeeded');
            if (selected) expect(exit.error?.message).toContain('Missing connection binding');
            expect((await kernel.listSessionTasks(sessionId)).some(task => task.program.kind === 'llm.agent')).toBe(false);
        }
    } finally { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); }
});
