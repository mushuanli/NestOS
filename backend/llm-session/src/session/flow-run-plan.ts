import { simpleHash } from '@itookit/llm-context';
import { isDagRunSpec, type FlowNodeBinder } from '@itookit/llm-flow';
import type { DagRunSpec, FlowRevision } from '@itookit/llm-flow/contracts';
import type { FlowIdentitySnapshot, FlowRunPlan } from '../contracts/flow-run-plan';
import { prepareFlowConnections, type FlowConnectionCatalog } from './flow-connections';
import { withAdmittedConnections } from './flow-agent-connections';

/** Persist admitted choices while preserving source instructions and context policies for dispatch. */
export function freezePlannedFlowConnections(source: DagRunSpec, admitted: DagRunSpec): DagRunSpec {
    const graph = structuredClone(source), nodes = new Map(admitted.nodes.map(node => [node.id, node]));
    for (const node of graph.nodes) {
        const config = nodes.get(node.id)?.config;
        if (record(node.config) && record(config)) node.config = withAdmittedConnections(node.config, config);
    }
    for (const [id, template] of Object.entries(graph.functionCalls ?? {})) {
        template.child = freezePlannedFlowConnections(template.child, admitted.functionCalls![id].child);
    }
    return graph;
}

/** Complete source binding can be replayed with a fresh conversation context and frozen identities. */
export async function bindPlannedFlowGraph(graph: DagRunSpec, bind: FlowNodeBinder): Promise<DagRunSpec> {
    const result = structuredClone(graph);
    result.nodes = await Promise.all(result.nodes.map(async node => {
        const patch = await bind(node as Parameters<FlowNodeBinder>[0], result.nodeDefaults?.[node.id] as never) ?? {};
        return { ...node, ...(patch.config !== undefined ? { config: patch.config } : {}),
            ...(patch.inputs !== undefined ? { inputs: patch.inputs } : {}),
            ...(patch.capabilities ? { capabilities: [...patch.capabilities] } : {}),
            ...(patch.budget ? { budget: { ...node.budget, ...patch.budget } } : {}) };
    }));
    for (const template of Object.values(result.functionCalls ?? {})) template.child = await bindPlannedFlowGraph(template.child, bind);
    return result;
}

/** Recheck authorization and materialize admitted connection fields without choosing new identities. */
export async function validatePlannedFlowConnections(source: DagRunSpec, flow: FlowRevision, catalog: FlowConnectionCatalog,
    defaults?: import('@itookit/kernel-adapters/contracts').ModelDefaults): Promise<DagRunSpec> {
    const graph = structuredClone(source);
    const nodes = graph.nodes.filter(node => {
        const config = node.config as Record<string, unknown> | null;
        return config && typeof config === 'object' && (!!config.connectionId || record(config.execution) && config.execution.kind === 'harness');
    });
    const prepared = await prepareFlowConnections({ ...flow, connections: [], defaultConnection: undefined, nodes: nodes as FlowRevision['nodes'] }, {}, catalog, defaults);
    const admitted = new Map(prepared.nodes.map(node => [String(node.id), node.config]));
    for (const node of graph.nodes) if (admitted.has(node.id)) node.config = admitted.get(node.id)!;
    for (const template of Object.values(graph.functionCalls ?? {})) template.child = await validatePlannedFlowConnections(template.child, flow, catalog, defaults);
    return graph;
}

export function createFlowRunPlan(graph: DagRunSpec, identities: FlowIdentitySnapshot): FlowRunPlan {
    const plan = { version: 1 as const, graph: structuredClone(graph), identities: structuredClone(identities) };
    return { ...plan, digest: planDigest(plan) };
}

export function isFlowRunPlan(value: unknown): value is FlowRunPlan {
    if (!record(value) || value.version !== 1 || !isDagRunSpec(value.graph) || !record(value.identities)
        || typeof value.digest !== 'string' || Object.keys(value).some(key => !['version', 'graph', 'identities', 'digest'].includes(key))
        || Object.keys(value.identities).some(key => !['agents', 'skills', 'prompts', 'mcp'].includes(key))) return false;
    for (const key of ['agents', 'skills', 'prompts', 'mcp']) {
        const entries = value.identities[key], ids = new Set<string>();
        if (!Array.isArray(entries) || entries.some(entry => {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || ids.has(entry[0])) return true;
            ids.add(entry[0]);
            return key === 'mcp' ? !Array.isArray(entry[1]) || entry[1].some(id => typeof id !== 'string')
                : entry[1] !== null && (!record(entry[1]) || entry[1].id !== entry[0]) || key === 'agents' && entry[1] === null;
        })) return false;
    }
    return value.digest === planDigest(value as unknown as FlowRunPlan);
}
function planDigest(plan: Omit<FlowRunPlan, 'digest'>): string {
    return simpleHash(JSON.stringify({ version: plan.version, graph: plan.graph, identities: plan.identities }));
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
