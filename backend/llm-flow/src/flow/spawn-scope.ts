import { remapFlowNodeReferences, type DagNodeDefinition, type DagEdgeDefinition } from '../contracts';
import { namespaceCallConfig } from './function-namespace';

/** Tool-produced graph templates use local identities just like authored child nodes. */
export function scopeSpawn(spawn: Record<string, unknown>, parentId?: string): Record<string, unknown> {
    const prefix = parentId?.slice(0, parentId.lastIndexOf('/') + 1);
    if (!prefix) return spawn;
    const nodes = Array.isArray(spawn.nodes) ? spawn.nodes as Record<string, unknown>[] : [];
    const edges = Array.isArray(spawn.edges) ? spawn.edges as Record<string, unknown>[] : [];
    const graph = {nodes: nodes as unknown as DagNodeDefinition[], edges: edges as unknown as DagEdgeDefinition[]};
    const aliases: Record<string, string> = Object.fromEntries(nodes.map(node => [String(node.id), prefix + node.id]));
    for (const edge of edges) for (const endpoint of [edge.from, edge.to]) {
        if (typeof endpoint !== 'string' || !endpoint.startsWith('$upstream:')) continue;
        const local = endpoint.slice('$upstream:'.length);
        aliases[local] = local.startsWith(prefix) ? local : prefix + local;
    }
    const endpoint = (raw: unknown) => typeof raw === 'string' && raw.startsWith('$upstream:')
        ? `$upstream:${aliases[raw.slice('$upstream:'.length)]}` : aliases[String(raw)] ?? raw;
    return { ...spawn, idempotencyKey: `${parentId}:${spawn.idempotencyKey ?? 'spawn'}`,
        nodes: nodes.map(node => ({ ...node, id: aliases[String(node.id)],
            config: namespaceCallConfig(node as unknown as DagNodeDefinition, graph, prefix, aliases),
            inputs: remapFlowNodeReferences(node.inputs, aliases),
            assign: remapFlowNodeReferences(node.assign, aliases),
            ...(typeof node.compensate === 'string' ? { compensate: aliases[node.compensate] ?? node.compensate } : {}) })),
        edges: edges.map(edge => ({ ...edge, ...(edge.id !== undefined ? { id: prefix + edge.id } : {}),
            from: endpoint(edge.from), to: endpoint(edge.to) })) };
}
