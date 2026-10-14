import { remapFlowNodeReferences } from '../../contracts';
import type { DagNodeDefinition, DagEdgeDefinition, DispatchBranch, DispatchConfig, SerializableExpression } from '../../contracts';
import { compileCondition, conditionOperand } from './condition';
import { object } from './value';
import { validateDispatch } from './validation';

type GraphEdge = Omit<DagEdgeDefinition, 'input' | 'output'> & { input?: string; output?: string };
type Graph = { nodes: DagNodeDefinition[]; edges: GraphEdge[] };
interface Scope { route: DagNodeDefinition; checks: DagNodeDefinition[]; aggregate: DagNodeDefinition; judge: DagNodeDefinition; revise?: DagNodeDefinition; }
export const isSplitRoute = (node: DagNodeDefinition) => node.plugin === 'builtin.route' && node.pluginVersion === '3.0.0';

/** Compile visible route/check/aggregate/judge nodes into one durable loop scope. */
export function compileDispatchGraph<T extends Graph>(graph: T): T {
    const routes = graph.nodes.filter(isSplitRoute);
    if (!routes.length) {
        if (graph.nodes.some(isScopeOperator)) throw new Error('Unconnected dispatch scope node');
        return graph;
    }
    if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length) throw new Error('Duplicate split graph node id');
    const scopes = routes.map(route => readScope(graph, route));
    const owners = new Map<string, Scope>();
    for (const scope of scopes) for (const node of [scope.route, ...scope.checks, scope.aggregate, scope.judge, ...(scope.revise ? [scope.revise] : [])]) {
        if (owners.has(node.id)) throw new Error(`Node belongs to multiple dispatch scopes: ${node.id}`);
        owners.set(node.id, scope);
    }
    const nodes = graph.nodes.filter(node => !owners.has(node.id) || isSplitRoute(node)).map(node =>
        isSplitRoute(node) ? compileScope(owners.get(node.id)!) : node);
    const edges = graph.edges.flatMap(edge => {
        const from = owners.get(edge.from), to = owners.get(edge.to);
        if (from && from === to) return [];
        return [{ ...edge, ...(from ? { from: from.route.id, output: 'result' } : {}) }];
    });
    if (nodes.some(isScopeOperator)) throw new Error('Unconnected dispatch scope node');
    const aliases = Object.fromEntries(scopes.map(scope => [scope.judge.id, scope.route.id]));
    return { ...graph, nodes: nodes.map(node => ({ ...node, assign: remapFlowNodeReferences(node.assign, aliases) as typeof node.assign, config: remapFlowNodeReferences(node.config, aliases), inputs: remapFlowNodeReferences(node.inputs, aliases) as typeof node.inputs })), edges };
}

function isScopeOperator(node: DagNodeDefinition): boolean {
    return ['builtin.check', 'builtin.judge', 'builtin.revise'].includes(node.plugin)
        || (node.plugin === 'builtin.aggregate' && node.pluginVersion === '2.0.0');
}

function targets(graph: Graph, id: string): DagNodeDefinition[] {
    return graph.edges.filter(edge => edge.from === id).map(edge => {
        const target = graph.nodes.find(node => node.id === edge.to);
        if (!target) throw new Error(`Missing graph node: ${edge.to}`);
        return target;
    });
}
function single(nodes: DagNodeDefinition[], plugin: string, version: string): DagNodeDefinition {
    if (!nodes.length || new Set(nodes.map(node => node.id)).size !== 1 || nodes[0].plugin !== plugin || nodes[0].pluginVersion !== version) {
        throw new Error(`Expected one connected ${plugin}@${version} node`);
    }
    return nodes[0];
}
function readScope(graph: Graph, route: DagNodeDefinition): Scope {
    const checks = targets(graph, route.id);
    if (!checks.length || checks.some(node => node.plugin !== 'builtin.check' || node.pluginVersion !== '1.0.0')
        || new Set(checks.map(node => node.id)).size !== checks.length) throw new Error('Route must connect to distinct check nodes');
    const aggregate = single(checks.flatMap(node => targets(graph, node.id)), 'builtin.aggregate', '2.0.0');
    const judge = single(targets(graph, aggregate.id), 'builtin.judge', '1.0.0');
    const repeats = graph.edges.filter(edge => edge.from === judge.id && edge.output === 'repeat');
    if (repeats.length !== 1) throw new Error('Judge requires one repeat edge');
    const revise = repeats[0].to === route.id ? undefined : single(targets(graph, judge.id).filter(node => node.id === repeats[0].to), 'builtin.revise', '1.0.0');
    const scope = { route, checks, aggregate, judge, revise };
    validateWiring(graph, scope);
    return scope;
}
function validateWiring(graph: Graph, scope: Scope): void {
    const { route, checks, aggregate, judge, revise } = scope;
    const ids = new Set([route, ...checks, aggregate, judge, ...(revise ? [revise] : [])].map(node => node.id));
    for (const check of checks) assertIncoming(graph, check.id, [route.id]);
    assertIncoming(graph, aggregate.id, checks.map(node => node.id));
    assertIncoming(graph, judge.id, [aggregate.id]);
    const feedback = graph.edges.filter(edge => edge.from === judge.id && edge.to === (revise?.id ?? route.id));
    if (feedback.length !== 1 || feedback[0].kind !== 'control' || feedback[0].output !== 'repeat') throw new Error('Judge requires one repeat control edge to its route or revision node');
    const revisionEdges = revise ? graph.edges.filter(edge => edge.from === revise.id) : [];
    if (revise) {
        assertIncoming(graph, revise.id, [judge.id]);
        if (revisionEdges.length !== 1 || revisionEdges[0].to !== route.id) throw new Error('Revision must return inputs to its route');
    }
    for (const node of [aggregate, judge]) validateOperator(node);
    for (const edge of graph.edges) {
        if (ids.has(edge.from) && ids.has(edge.to) && edge !== feedback[0]) {
            if (edge.kind === 'control' || edge.output !== 'result' || edge.input !== 'input') throw new Error('Scope data edges require result → input');
        }
        if (ids.has(edge.from) && ids.has(edge.to) && edge.onFailure && edge.onFailure !== 'fail') throw new Error('Scope edges require fail propagation');
        if (ids.has(edge.from) && !ids.has(edge.to) && edge.from !== judge.id) throw new Error('Only judge can expose a dispatch scope result');
        if (!ids.has(edge.from) && ids.has(edge.to) && edge.to !== route.id) throw new Error('Dispatch scope inputs must enter through route');
        if (edge.from === judge.id && edge.to !== (revise?.id ?? route.id) && edge.output && edge.output !== 'result') throw new Error('Judge output must use result or repeat');
    }
}
function validateOperator(node: DagNodeDefinition): void {
    if (Object.keys(node.assign ?? {}).length || Object.keys(node.retry ?? {}).length || Object.keys(node.budget ?? {}).length || node.compensate || (node.priority !== undefined && node.priority !== 0) || node.capabilities?.length
        || Object.keys(node.inputs ?? {}).length || node.portSchemas) {
        throw new Error(`Configure task execution on route or check nodes: ${node.id}`);
    }
}
function assertIncoming(graph: Graph, id: string, expected: string[]): void {
    const edges = graph.edges.filter(edge => edge.to === id);
    if (edges.length !== expected.length || edges.some(edge => !expected.includes(edge.from))) throw new Error(`Invalid incoming edges: ${id}`);
}
function compileScope(scope: Scope): DagNodeDefinition {
    const route = object(scope.route.config), judge = object(scope.judge.config), aggregate = object(scope.aggregate.config);
    if (aggregate.strategy !== undefined && !['latest', 'append'].includes(String(aggregate.strategy))) throw new Error('Unsupported aggregate strategy');
    const branches = scope.checks.map(node => compileCheck(node, judge));
    const until = (judge.condition ? compileCondition(judge.condition as import('../../contracts').FlowCondition) : judge.until) ?? { kind: 'and', args: branches.map(branch => criterion(branch.key, judge)) };
    const config = { ...route, branches, until, maxRounds: judge.maxRounds,
        logicNodes: { aggregate: { id: scope.aggregate.id, name: scope.aggregate.name },
            judge: { id: scope.judge.id, name: scope.judge.name } },
        join: { failure: aggregate.failure ?? 'fail', reducer: aggregate.reducer ?? `${aggregate.strategy ?? 'latest'}@1`, ...(aggregate.projection ? { projection: aggregate.projection } : {}) },
        ...(scope.revise ? { revision: { fields: object(scope.revise.config).fields, prompt: '',
            invocation: compileCheck(scope.revise, judge, true) } } : judge.revision ? { revision: judge.revision } : {}),
        ...(aggregate.initialResults ? { initialResults: aggregate.initialResults } : {}) };
    validateDispatch(config as unknown as DispatchConfig, true);
    return { ...scope.route, pluginVersion: '2.0.0', config, outputPolicy: scope.judge.outputPolicy ?? scope.route.outputPolicy };
}
function compileCheck(node: DagNodeDefinition, judge: Record<string, unknown>, revision = false): DispatchBranch {
    const { fields: _fields, key, bindings, when, prompt, outputContract, output, outputFormat, outputSchema, validate, context, publishToHistory, ...agent } = object(node.config);
    if (typeof agent.systemPrompt === 'string') agent.systemPrompt = [agent.systemPrompt];
    const branchKey = typeof key === 'string' ? key : node.id;
    return { assign: node.assign, key: branchKey, prompt: prompt as string | undefined, outputContract: outputContract as DispatchBranch['outputContract'], input: (bindings ?? {}) as DispatchBranch['input'],
        target: { ...node, plugin: 'builtin.agent', config: agent } as DispatchBranch['target'],
        when: (revision ? undefined : when ?? ((judge.until || judge.condition) ? undefined : { kind: 'not', args: [criterion(branchKey, judge)] })) as SerializableExpression | undefined,
        output: output as SerializableExpression | undefined, outputFormat: outputFormat as DispatchBranch['outputFormat'],
        outputSchema: outputSchema as DispatchBranch['outputSchema'], validate: validate as SerializableExpression | undefined,
        context: context as DispatchBranch['context'], publishToHistory: publishToHistory as boolean | undefined };
}
function criterion(key: string, judge: Record<string, unknown>): SerializableExpression {
    if (judge.threshold === undefined) throw new Error('Judge requires threshold or until');
    const metric = typeof judge.metric === 'string' ? judge.metric.split('.') : ['score'];
    return { kind: 'and', args: [
        { kind: 'eq', args: [{ kind: 'path', path: ['results', key, 'current'] }, { kind: 'literal', value: true }] },
        { kind: 'gte', args: [{ kind: 'path', path: ['results', key, 'value', ...metric] },
            conditionOperand(judge.threshold)] },
    ] };
}
