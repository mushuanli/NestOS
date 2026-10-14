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
): DagEdgeDefinition[] {
    plugins = createRunCatalog(plugins, [...nodes, ...patch.nodes]);
    const fail = (reason: string): never => { throw new Error(`Graph patch ${patch.idempotencyKey}: ${reason}`); };
    if (!patch.idempotencyKey?.trim()) fail('idempotency key is required');
    const known = new Map(nodes.map(node => [String(node.id), node]));
    const added = new Set<string>();
    for (const node of patch.nodes) {
        if (!node.id || known.has(node.id)) fail(`duplicate or empty node id ${node.id}`);
        if (!plugins.getManifest(node.plugin, node.pluginVersion)) fail(`unknown plugin ${node.plugin}`);
        known.set(node.id, node);
        added.add(node.id);
    }
    const allowedSources = new Set([parentId, ...edges.filter(edge => edge.to === parentId).map(edge => edge.from), ...added]);
    const edgeIds = new Set(edges.map(edge => String(edge.id)));
    const normalized = patch.edges.map(edge => ({ ...edge, id: edge.id ?? `${edge.from}->${edge.to}`, output: edge.output ?? 'result', input: edge.input ?? 'input' }));
    for (const edge of normalized) {
        if (!edge.id || edgeIds.has(edge.id)) fail(`duplicate or empty edge id ${edge.id}`);
        edgeIds.add(edge.id);
        if (!allowedSources.has(edge.from) || !added.has(edge.to)) fail(`edge outside spawn scope ${edge.from}->${edge.to}`);
        validatePatchPorts(edge, known, plugins, fail);
    }
    if (findCycles(patch.nodes, normalized.filter(edge => added.has(edge.from))).backEdges.size) fail('dynamic cycle is forbidden');
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
