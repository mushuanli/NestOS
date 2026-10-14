import type { DagNodeDefinition, DagEdgeDefinition } from '../../contracts';
import { object } from '../structured/value';

type Graph = { nodes: DagNodeDefinition[]; edges: Array<Omit<DagEdgeDefinition, 'input' | 'output'> & { input?: string; output?: string }> };

/** Annotate ownership without collapsing ordinary graph nodes into a controller. */
export function compileControlGraph<T extends Graph>(source: T): T {
    const graph = structuredClone(source);
    for (const group of graph.nodes.filter(node => node.plugin === 'builtin.taskGroup')) annotateGroup(graph, group);
    for (const loop of graph.nodes.filter(node => node.plugin === 'builtin.loop')) annotateLoop(graph, loop);
    for (const join of graph.nodes.filter(node => node.plugin === 'builtin.join')) {
        const inputs = graph.edges.filter(edge => edge.to === join.id && edge.kind !== 'control');
        const keys = object(object(join.config).keys);
        if (!inputs.length || new Set(inputs.map(edge => keys[edge.from] ?? edge.from)).size !== inputs.length) throw new Error(`Join requires distinct result keys: ${join.id}`);
        for (const edge of inputs) edge.onFailure = 'continue';
    }
    return graph;
}

function annotateGroup(graph: Graph, group: DagNodeDefinition): void {
    const members = graph.edges.filter(edge => edge.from === group.id).map(edge => graph.nodes.find(node => node.id === edge.to)!);
    if (!members.length || members.some(node => !node || ['builtin.taskGroup', 'builtin.loop', 'builtin.join'].includes(node.plugin))) throw new Error(`Task group requires ordinary worker nodes: ${group.id}`);
    const joins = members.map(node => graph.edges.filter(edge => edge.from === node.id).map(edge => graph.nodes.find(item => item.id === edge.to)).filter(node => node?.plugin === 'builtin.join'));
    const join = joins[0][0];
    if (!join || joins.some(items => items.length !== 1 || items[0]?.id !== join.id)) throw new Error(`Task group workers require a common join: ${group.id}`);
    const otherGroups = new Set(graph.nodes.filter(node => node.plugin === 'builtin.taskGroup' && node.id !== group.id).map(node => node.id));
    const owned = graph.edges.filter(edge => otherGroups.has(edge.from)).map(edge => edge.to);
    if (members.some(node => owned.includes(node.id)) || new Set(members.map(node => node.id)).size !== members.length) throw new Error('Task group member belongs to multiple groups/edges');
    group.config = { ...object(group.config), members: members.map(node => node.id), joinId: join.id };
    join.config = { ...object(join.config), groupId: group.id };
}

function annotateLoop(graph: Graph, loop: DagNodeDefinition): void {
    const forward = reachable(graph, loop.id, false), backward = reachable(graph, loop.id, true);
    const members = graph.nodes.filter(node => forward.has(node.id) && backward.has(node.id));
    if (members.length < 2) throw new Error(`Loop requires a feedback cycle: ${loop.id}`);
    if (members.some(node => node.plugin === 'builtin.loop' && node.id !== loop.id)) throw new Error('Nested/overlapping loop cycles require separate scopes');
    const rounds = object(loop.config).maxRounds;
    if (!(typeof rounds === 'string' && /^\$\{(?:param|params)\.[\w.-]+\}$/.test(rounds)) && (!Number.isSafeInteger(rounds) || Number(rounds) < 1 || Number(rounds) > 1000)) throw new Error('Loop maxRounds must be between 1 and 1000');
    for (const node of members) {
        const config = object(node.config);
        if (config.maxIterations !== undefined && config.maxIterations !== rounds) throw new Error(`Conflicting loop iteration limit: ${node.id}`);
        node.config = { ...config, maxIterations: rounds };
    }
    loop.config = { ...object(loop.config), members: members.map(node => node.id) };
}

function reachable(graph: Graph, id: string, reverse: boolean): Set<string> {
    const visited = new Set<string>(), pending = [id];
    while (pending.length) {
        const next = pending.pop()!;
        if (visited.has(next)) continue;
        visited.add(next);
        for (const edge of graph.edges) if ((reverse ? edge.to : edge.from) === next) pending.push(reverse ? edge.from : edge.to);
    }
    return visited;
}
