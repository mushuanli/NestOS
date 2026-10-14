import type { TaskHandle } from '@itookit/durable-kernel';
import type { DagEdgeDefinition, DagNodeDefinition, DagPluginCatalog, DagRunSpec, DagTaskDefinition, DagTaskDependencyBinding, FlowTemplateContext, JsonValue } from '../contracts';
import type { EdgeState } from './delegation-runtime';
import type { DispatchInput } from './structured/types';
import { invocationReferenceContext, resolveExecutionNode, scopedParameters } from './structured/references';
import { resolveNodeConnection } from './connections';
import { validateDataEdgeValue } from './port-contract';
import { variableDefinitions, FlowVariableStore } from './variables';

export interface NodeTaskPreparationState {
    sessionId: string;
    spec: DagRunSpec;
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    instances: Map<string, TaskHandle[]>;
    skipped: Set<string>;
    backEdges: Set<string>;
    loopNodes: Set<string>;
    edgeState: Map<string, EdgeState>;
    plugins: DagPluginCatalog;
    parameters?: Record<string, JsonValue>;
    callInputs: Record<string, unknown>;
    variableStore: FlowVariableStore;
    nodeConnections: Map<string, NonNullable<DagRunSpec['nodeConnections']>[string]>;
    sessionContext?: { projectInstructions: string; skillInstructions: string; skillIndex: string };
    maxConcurrency: number;
    latestDone(nodeId: string): boolean;
}

export interface PreparedNodeTask {
    node: DagNodeDefinition;
    iteration: number;
    task: DagTaskDefinition;
    dependencies: DagTaskDependencyBinding[];
    parameters: Record<string, JsonValue>;
    context: FlowTemplateContext;
}

/** Resolve inputs and plugin requests without submitting or binding Kernel tasks. */
export async function prepareNodeTask(state: NodeTaskPreparationState, node: DagNodeDefinition): Promise<PreparedNodeTask> {
    const iteration = (state.instances.get(node.id)?.length ?? 0) + 1;
    const incoming = incomingDependencies(state, node, iteration);
    const upstream = (edge: DagEdgeDefinition) => upstreamHandle(state, node, edge, iteration);
    for (const edge of incoming) {
        const task = (await upstream(edge).status()).task;
        if (task.status === 'succeeded') validateDataEdgeValue(edge, node, state.plugins, task.output);
    }
    const dependencies = incoming.map(edge => ({ taskId: upstream(edge).id, nodeId: edge.from,
        input: edge.input, output: edge.output, edgeId: edge.id, onFailure: edge.onFailure, injectOutput: edge.kind !== 'control' }));
    const parameters = scopedParameters(state.spec, node.id, state.parameters ?? {}, state.callInputs);
    const outputs: Record<string, unknown> = {};
    for (const edge of incoming) outputs[edge.from] = (await upstream(edge).status()).task.output;
    state.variableStore.prune(new Set([...state.instances.values()].flat().map(handle => handle.id)));
    const context = state.variableStore.snapshot(node, invocationReferenceContext(state.nodes, outputs, parameters, iteration, node.id));
    if (state.spec.templateVersion === 1) node = resolveExecutionNode(node, context);
    if (node.plugin === 'builtin.route' && node.pluginVersion === '2.0.0' && context.vars) {
        node = { ...node, config: { ...record(node.config), variables: variableDefinitions(state.spec, node.id) } };
    }
    const runtime = await state.plugins.loadRuntime(node.plugin, node.pluginVersion);
    const task = runtime.createTask({ sessionId: state.sessionId, nodeRunId: iteration === 1 ? node.id : `${node.id}#${iteration}`,
        config: node.plugin === 'builtin.agent' && state.sessionContext ? { ...record(node.config), sessionContext: state.sessionContext } : node.config,
        inputs: node.inputs, dependencies });
    if (task.programKind === 'flow.dispatch') prepareDispatchConnections(state, node.id, task.input as DispatchInput);
    return { node, iteration, task, dependencies, parameters, context };
}

function incomingDependencies(state: NodeTaskPreparationState, node: DagNodeDefinition, iteration: number): DagEdgeDefinition[] {
    return state.edges.filter(edge => edge.to === node.id)
        .filter(edge => (state.edgeState.get(edge.id) ?? 'active') === 'active')
        .filter(edge => !state.backEdges.has(edge.id) || iteration > 1)
        .filter(edge => !state.backEdges.has(edge.id) || state.latestDone(edge.from))
        .filter(edge => state.instances.has(edge.from) && !state.skipped.has(edge.from));
}

function upstreamHandle(state: NodeTaskPreparationState, node: DagNodeDefinition, edge: DagEdgeDefinition, iteration: number): TaskHandle {
    // Back edges consume the latest completed instance; forward loop edges stay in the same round.
    const upstreamIteration = state.backEdges.has(edge.id) ? state.instances.get(edge.from)?.length ?? 0
        : state.loopNodes.has(node.id) && state.loopNodes.has(edge.from) ? iteration : state.instances.get(edge.from)?.length ?? 1;
    const handle = state.instances.get(edge.from)?.[upstreamIteration - 1];
    if (!handle) throw new Error(`Flow node has no instance ${upstreamIteration}: ${edge.from}`);
    return handle;
}

function prepareDispatchConnections(state: NodeTaskPreparationState, nodeId: string, input: DispatchInput): void {
    input.maxConcurrency = Math.min(input.maxConcurrency ?? state.maxConcurrency, state.maxConcurrency);
    const scope = state.nodeConnections.get(nodeId);
    const defaults = input.invocationDefaults;
    if (!scope) return;
    const resolve = (config: JsonValue) => resolveNodeConnection(config,
        scope.connections, scope.defaultConnection, scope.fallbackConnectionId, scope.runConnectionId);
    if (defaults) resolve(defaults as unknown as JsonValue);
    for (const branch of [...input.branches, ...(input.revision?.invocation ? [input.revision.invocation] : [])]) {
        if (defaults?.connectionId && !record(branch.target.config).connectionId) {
            branch.target.config = { ...record(branch.target.config), connectionId: defaults.connectionId } as JsonValue;
        }
        resolve(branch.target.config);
    }
}

function record(value: unknown): Record<string, JsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
