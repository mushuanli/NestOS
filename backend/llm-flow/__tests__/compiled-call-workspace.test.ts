import { expect, it } from 'vitest';
import { createBuiltinDagPluginRegistry, flowToDag } from '../src/flow';
import { expandFunctionCalls, functionTemplateNodes } from '../src/flow/function-batch';
import { GraphMutationRuntime, type GraphMutationState } from '../src/flow/graph-mutations';
import { createRunCatalog } from '../src/flow/run-catalog';
import type { FlowRevision } from '../src/contracts';

it('applies the owning isolated Run workspace to compiled call instances', async () => {
    const child: FlowRevision = { id: 'child' as never, name: 'Child', revision: 1, digest: 'child', createdAt: 0,
        nodes: [{ id: 'agent' as never, name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: { instruction: 'Run' } }],
        edges: [], outputs: { result: { value: '${nodes.agent.outputs.result}' } } };
    const parent: FlowRevision = { ...child, id: 'parent' as never, outputs: undefined, nodes: [{ id: 'call' as never, name: 'Call',
        plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {}, config: { flowId: 'child', parameterSets: [{}] } }] };
    const spec = await flowToDag(parent, undefined, undefined, async () => child);
    const output = { outputs: { result: { outputName: 'result', type: 'json', content: { parameters: {}, parameterSets: [{}] } } } };
    const state: GraphMutationState = { spec, parameters: {}, callInputs: { call__input: output }, nodes: [...spec.nodes], edges: [...spec.edges],
        plugins: createRunCatalog(createBuiltinDagPluginRegistry(), functionTemplateNodes(spec)), maxNodes: 1000,
        appliedPatches: new Map(), nodeDefaults: new Map(), nodeConnections: new Map(), edgeState: new Map(),
        backEdges: new Set(), skipped: new Set(), dispatchOrder: [], instances: new Map(), workspaceDirectory: '/isolated/run' };
    const batch = expandFunctionCalls(spec, 'call__input', output, spec.nodes.length, 1000)!;
    new GraphMutationRuntime(state).applyCompiledPatch(batch.patch, 'call__input', batch.scopes);
    expect(state.nodes.find(node => node.id === 'call/0/agent')!.config).toMatchObject({ workingDirectory: '/isolated/run' });
});
