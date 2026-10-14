import type { TaskHandle } from '@itookit/durable-kernel';
import type { DagNodeDefinition, DagEdgeDefinition, DagRunSpec } from '../contracts';
import type { EdgeState } from './delegation-runtime';

/** Live scheduler state; skipping a non-loop node is an explicit state transition. */
export interface SchedulerReadiness {
    spec: Pick<DagRunSpec, 'parameterScopes'>;
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    callInputs: Record<string, unknown>;
    instances: Map<string, TaskHandle[]>;
    skipped: Set<string>;
    detachedNodes: Set<string>;
    loopNodes: Set<string>;
    backEdges: Set<string>;
    routeEdgeIds: Set<string>;
    edgeState: Map<string, EdgeState>;
    dispatchOrder: string[];
    maxIterations(node: DagNodeDefinition): number;
    doneAt(nodeId: string, iteration: number): boolean;
    latestDone(nodeId: string): boolean;
}

export function readyFlowNodes(state: SchedulerReadiness): DagNodeDefinition[] {
    const candidates = state.nodes.filter(node => nodeReady(state, node));
    return candidates.filter(node => {
        if (node.plugin !== 'builtin.return') return true;
        const prefix = node.id.slice(0, node.id.lastIndexOf('/') + 1);
        return !state.nodes.some(member => member.id !== node.id && member.id.startsWith(prefix)
            && !state.detachedNodes.has(member.id) && (candidates.includes(member)
                || (state.instances.get(member.id) ?? []).some((_, index) => !state.doneAt(member.id, index + 1))));
    });
}

function nodeReady(state: SchedulerReadiness, node: DagNodeDefinition): boolean {
    if (Object.entries(state.spec.parameterScopes ?? {}).some(([prefix, scope]) =>
        node.id.startsWith(prefix) && scope.source && !Object.hasOwn(state.callInputs, scope.source))) return false;
    const iteration = (state.instances.get(node.id)?.length ?? 0) + 1;
    if (iteration > state.maxIterations(node) || state.skipped.has(node.id)) return false;
    if (iteration > 1 && !state.doneAt(node.id, iteration - 1)) return false;
    if (node.plugin === 'builtin.loop' && iteration > 1 && loopMembers(node).some(id =>
        (state.instances.get(id)?.length ?? 0) >= iteration - 1 && !state.doneAt(id, iteration - 1))) return false;
    return incomingReady(state, node, iteration);
}

function incomingReady(state: SchedulerReadiness, node: DagNodeDefinition, iteration: number): boolean {
    const incoming = state.edges.filter(edge => edge.to === node.id);
    if (!incoming.length) return true;
    const gates = incoming.filter(edge => state.routeEdgeIds.has(edge.id));
    if (gates.length && gates.every(edge => state.edgeState.get(edge.id) === 'inactive')) return skipNode(state, node);
    const active = incoming.filter(edge => !state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'active');
    const pending = incoming.filter(edge => !state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'pending');
    const backActive = incoming.filter(edge => state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'active');
    const backPending = incoming.filter(edge => state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'pending');
    if (!active.length && !pending.length && !backActive.length && !backPending.length) return skipNode(state, node);
    if (pending.length || (iteration > 1 && backPending.length)) return false;
    return active.every(edge => forwardReady(state, node, edge, iteration))
        && backReady(state, backActive, iteration);
}

function forwardReady(state: SchedulerReadiness, node: DagNodeDefinition, edge: DagEdgeDefinition, iteration: number): boolean {
    if (state.skipped.has(edge.from)) return true;
    const sameLoop = state.loopNodes.has(node.id) && state.loopNodes.has(edge.from);
    if (node.plugin === 'builtin.join' && edge.kind !== 'control') {
        return sameLoop ? (state.instances.get(edge.from)?.length ?? 0) >= iteration : state.instances.has(edge.from);
    }
    return sameLoop ? state.doneAt(edge.from, iteration) : state.latestDone(edge.from);
}

function backReady(state: SchedulerReadiness, edges: DagEdgeDefinition[], iteration: number): boolean {
    if (iteration <= 1 || !edges.length) return true;
    if (state.dispatchOrder.length) return state.dispatchOrder.length >= iteration - 1
        && state.latestDone(state.dispatchOrder[iteration - 2]);
    return edges.every(edge => state.doneAt(edge.from, iteration - 1));
}

function skipNode(state: SchedulerReadiness, node: DagNodeDefinition): false {
    if (!state.loopNodes.has(node.id)) state.skipped.add(node.id);
    return false;
}

function edgeStatus(state: SchedulerReadiness, edge: DagEdgeDefinition): EdgeState {
    return state.edgeState.get(edge.id) ?? 'active';
}

function loopMembers(node: DagNodeDefinition): string[] {
    const config = node.config;
    const members = config && typeof config === 'object' && !Array.isArray(config) && 'members' in config ? config.members : undefined;
    return members as string[];
}
