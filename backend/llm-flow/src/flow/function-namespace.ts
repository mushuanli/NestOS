import type { DagNodeDefinition, DagRunSpec } from '../contracts';
import { remapFlowNodeReferences } from '../contracts';
import { object } from './structured/value';

/** Rename control identities while preserving user data and public join result keys. */
export function namespaceCallConfig(node: DagNodeDefinition, child: DagRunSpec, prefix: string): unknown {
    const config = object(remapFlowNodeReferences(node.config, Object.fromEntries(child.nodes.map(item => [item.id, prefix + item.id]))));
    if (['builtin.taskGroup', 'builtin.loop'].includes(node.plugin) && Array.isArray(config.members)) {
        config.members = config.members.map(id => prefix + id);
    }
    if (node.plugin === 'builtin.taskGroup' && typeof config.joinId === 'string') config.joinId = prefix + config.joinId;
    if (node.plugin === 'builtin.join') {
        if (typeof config.groupId === 'string') config.groupId = prefix + config.groupId;
        const keys = object(config.keys);
        config.keys = Object.fromEntries(child.edges.filter(edge => edge.to === node.id && edge.kind !== 'control')
            .map(edge => [prefix + edge.from, keys[edge.from] ?? edge.from]));
    }
    return remapRouteEdges(node, config, Object.fromEntries(child.edges.map(edge => [edge.id, prefix + edge.id])));
}

export function remapRouteEdges(node: DagNodeDefinition, value: unknown, edges: Record<string, string>): unknown {
    if (node.plugin !== 'builtin.route' || node.pluginVersion !== '1.0.0') return value;
    const config = object(value);
    if (typeof config.defaultEdgeId === 'string') config.defaultEdgeId = edges[config.defaultEdgeId] ?? config.defaultEdgeId;
    if (Array.isArray(config.rules)) config.rules = config.rules.map(rule => {
        const item = object(rule);
        return { ...item, ...(typeof item.edgeId === 'string' ? { edgeId: edges[item.edgeId] ?? item.edgeId } : {}) };
    });
    return config;
}
