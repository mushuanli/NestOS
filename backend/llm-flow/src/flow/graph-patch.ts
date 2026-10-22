import { createRunCatalog } from './run-catalog';
import type { DagEdgeDefinition, DagNodeDefinition, DagPluginCatalog, GraphPatch } from '../contracts';
import { findCycles } from './graph';
import { dataEdgeSchemaIssue } from './port-contract';

export function graphPatchFingerprint(patch: GraphPatch): string {
    return JSON.stringify(patch, (_key, value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
}

/** Validate the entire patch before publishing any graph mutation. */
export function validateGraphPatch(
    patch: GraphPatch,
    nodes: DagNodeDefinition[],
    edges: DagEdgeDefinition[],
    parentId: string,
    plugins: DagPluginCatalog,
    unavailableTargets: ReadonlySet<string> = new Set(),
    compiled = false,
): DagEdgeDefinition[] {
    plugins = createRunCatalog(plugins, [...nodes, ...patch.nodes]);
    const fail = (reason: string): never => { throw new Error(`Graph patch ${patch.idempotencyKey}: ${reason}`); };
    if (!patch.idempotencyKey?.trim()) fail('idempotency key is required');
    const known = validatePatchNodes(nodes, patch.nodes, plugins, fail);
    const added = new Set(patch.nodes.map(node => String(node.id)));
    const normalized = validatePatchEdges(patch.edges, edges, { known, added, parentId, unavailableTargets }, plugins, fail);
    const cycles = findCycles([...nodes, ...patch.nodes], [...edges, ...normalized]);
    if (!compiled && [...added].some(id => cycles.loopNodes.has(id))) fail('dynamic cycle is forbidden');
    return normalized;
}

type PatchScope = { known: Map<string, DagNodeDefinition>; added: Set<string>; parentId: string; unavailableTargets: ReadonlySet<string> };

function validatePatchNodes(nodes: DagNodeDefinition[], additions: DagNodeDefinition[], plugins: DagPluginCatalog, fail: (reason: string) => never): Map<string, DagNodeDefinition> {
    const known = new Map(nodes.map(node => [String(node.id), node]));
    for (const node of additions) {
        if (!node.id || known.has(node.id)) fail(`duplicate or empty node id ${node.id}`);
        if (!plugins.getManifest(node.plugin, node.pluginVersion)) fail(`unknown plugin ${node.plugin}`);
        known.set(node.id, node);
    }
    return known;
}

function validatePatchEdges(additions: GraphPatch['edges'], edges: DagEdgeDefinition[], scope: PatchScope,
    plugins: DagPluginCatalog, fail: (reason: string) => never): DagEdgeDefinition[] {
    const { known, added, parentId, unavailableTargets } = scope;
    const allowedSources = new Set([parentId, ...edges.filter(edge => edge.to === parentId).map(edge => edge.from), ...added]);
    const returnTargets = new Set(edges.filter(edge => edge.from === parentId).map(edge => edge.to));
    const edgeIds = new Set(edges.map(edge => String(edge.id)));
    const normalized = additions.map(edge => ({ ...edge, id: edge.id ?? `${edge.from}->${edge.to}`, output: edge.output ?? 'result', input: edge.input ?? 'input' }));
    for (const edge of normalized) {
        if (!edge.id || edgeIds.has(edge.id)) fail(`duplicate or empty edge id ${edge.id}`);
        edgeIds.add(edge.id);
        const internal = allowedSources.has(edge.from) && added.has(edge.to);
        const returning = added.has(edge.from) && returnTargets.has(edge.to);
        if (!internal && !returning) fail(`edge outside spawn scope ${edge.from}->${edge.to}`);
        if (returning && unavailableTargets.has(edge.to)) fail(`return target already started or skipped: ${edge.to}`);
        validatePatchPorts(edge, known, plugins, fail);
    }
    return normalized;
}

function validatePatchPorts(
    edge: DagEdgeDefinition,
    nodes: Map<string, DagNodeDefinition>,
    plugins: DagPluginCatalog,
    fail: (reason: string) => never,
): void {
    if (edge.kind === 'control') return;
    const source = nodes.get(edge.from)!;
    const target = nodes.get(edge.to)!;
    const from = plugins.getManifest(source.plugin, source.pluginVersion);
    const to = plugins.getManifest(target.plugin, target.pluginVersion);
    if (from && !from.outputs.some(port => port.name === edge.output)) fail(`unknown output ${edge.output}`);
    if (to && !to.inputs.some(port => port.name === edge.input)) fail(`unknown input ${edge.input}`);
    const schemaIssue = dataEdgeSchemaIssue(edge, source, target, plugins);
    if (schemaIssue) fail(schemaIssue);
}
