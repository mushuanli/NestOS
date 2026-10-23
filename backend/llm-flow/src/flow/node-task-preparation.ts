import type { TaskHandle } from '@itookit/durable-kernel';
import type { DagEdgeDefinition, DagNodeDefinition, DagPluginCatalog, DagRunSpec, DagTaskDefinition, DagTaskDependencyBinding, FlowTemplateContext, JsonValue } from '../contracts';
import type { EdgeState } from './delegation-runtime';
import type { DispatchInput } from './structured/types';
import { invocationReferenceContext, resolveExecutionNode, scopedParameters } from './structured/references';
import { resolveNodeConnection } from './connections';
import { validateDataEdgeValue } from './port-contract';
import { variableDefinitions, FlowVariableStore } from './variables';
import { validateDispatchCapacity } from './structured/limits';

export interface NodeTaskPreparationState {
    sessionId: string;
    spec: DagRunSpec;
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    instances: Map<string, TaskHandle[]>;
    skipped: Set<string>;
    detachedNodes: Set<string>;
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
    toleratedFailureNodes(): Set<string>;
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
    const dependencies = incoming.map(edge => ({ taskId: upstream(edge).id, nodeId: edge.from,
        input: edge.input, output: edge.output, edgeId: edge.id, onFailure: edge.onFailure, injectOutput: edge.kind !== 'control' }));
    const snapshots = await Promise.all(incoming.map(async edge => (await upstream(edge).status()).task));
    if (incoming.some((edge, index) => blocksDependency(node, edge, snapshots[index].status))) {
        return blockedNodeTask(node, iteration, dependencies);
    }
    const parameters = scopedParameters(state.spec, node.id, state.parameters ?? {}, state.callInputs);
    const outputs: Record<string, unknown> = {};
    for (const [index, edge] of incoming.entries()) {
        const task = snapshots[index];
        if (task.status === 'succeeded') validateDataEdgeValue(edge, node, state.plugins, task.output);
        outputs[edge.from] = task.output;
    }
    state.variableStore.prune(new Set([...state.instances.values()].flat().map(handle => handle.id)));
    const context = state.variableStore.snapshot(node, invocationReferenceContext(state.nodes, outputs, parameters, iteration, node.id, state.spec.input));
    if (state.spec.templateVersion === 1) node = resolveExecutionNode(node, context);
    if (node.plugin === 'builtin.route' && node.pluginVersion === '2.0.0' && context.vars) {
        node = { ...node, config: { ...record(node.config), variables: variableDefinitions(state.spec, node.id) } };
    }
    const task = await createPluginTask(state, node, iteration, dependencies);
    return { node, iteration, task, dependencies, parameters, context };
}

async function createPluginTask(state: NodeTaskPreparationState, node: DagNodeDefinition, iteration: number,
    dependencies: DagTaskDependencyBinding[]): Promise<DagTaskDefinition> {
    if (['builtin.agent', 'builtin.media'].includes(node.plugin) && record(node.config).connectionId === ''
        && record(record(node.config).execution).kind !== 'harness') {
        throw new Error(`Missing connection binding for Flow node: ${node.id}`);
    }
    const runtime = await state.plugins.loadRuntime(node.plugin, node.pluginVersion);
    const task = runtime.createTask({ sessionId: state.sessionId, nodeRunId: iteration === 1 ? node.id : `${node.id}#${iteration}`,
        config: node.plugin === 'builtin.agent' && state.sessionContext ? { ...record(node.config), sessionContext: state.sessionContext } : node.config,
        inputs: node.inputs, dependencies });
    if (task.programKind === 'flow.dispatch') {
        validateDispatchCapacity({ ...state.spec, nodes: state.nodes, edges: state.edges }, state.parameters, state.callInputs);
        prepareDispatchConnections(state, node.id, task.input as DispatchInput);
    }
    return task;
}

function blocksDependency(node: DagNodeDefinition, edge: DagEdgeDefinition, status: string): boolean {
    if (node.plugin === 'builtin.join' && edge.kind !== 'control') return false;
    return ['failed', 'cancelled'].includes(status) && edge.onFailure !== 'continue';
}

/** Preserve the durable dependent identity; Kernel commits fail/skip without executing a program. */
function blockedNodeTask(node: DagNodeDefinition, iteration: number, dependencies: DagTaskDependencyBinding[]): PreparedNodeTask {
    return { node, iteration, dependencies, parameters: {}, context: {}, task: {
        programKind: 'flow.value', programVersion: '1',
        input: { operation: 'transform', config: { value: null }, inputs: {}, dependencies: [] },
    } };
}

function incomingDependencies(state: NodeTaskPreparationState, node: DagNodeDefinition, iteration: number): DagEdgeDefinition[] {
    return [...state.edges.filter(edge => edge.to === node.id), ...dynamicReturnDependencies(state, node)]
        .filter(edge => (state.edgeState.get(edge.id) ?? 'active') === 'active')
        .filter(edge => !state.backEdges.has(edge.id) || iteration > 1)
        .filter(edge => !state.backEdges.has(edge.id) || state.latestDone(edge.from))
        .filter(edge => state.instances.has(edge.from) && !state.skipped.has(edge.from));
}

/** Reconstruct dynamic members from the checkpoint; a return must observe their durable exits. */
function dynamicReturnDependencies(state: NodeTaskPreparationState, node: DagNodeDefinition): DagEdgeDefinition[] {
    if (node.plugin !== 'builtin.return') return [];
    const prefix = node.id.slice(0, node.id.lastIndexOf('/') + 1);
    const declared = new Set(state.spec.nodes.map(item => item.id));
    const existing = new Set(state.edges.filter(edge => edge.to === node.id).map(edge => edge.from));
    const tolerated = state.toleratedFailureNodes();
    return state.nodes.filter(member => member.id !== node.id && member.id.startsWith(prefix)
        && !declared.has(member.id) && !existing.has(member.id) && !state.detachedNodes.has(member.id))
        .map(member => ({ id: `return-member:${node.id}:${member.id}`, from: member.id, to: node.id,
            output: 'result', input: 'input', kind: 'control', dependencyOnly: true,
            ...(tolerated.has(member.id) ? { onFailure: 'continue' as const } : {}) }));
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
