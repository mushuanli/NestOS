import type { TaskHandle } from '@itookit/durable-kernel';
import type { DagNodeDefinition, DagEdgeDefinition, DagRunSpec } from '../contracts';
import type { EdgeState } from './delegation-runtime';
import { recordFlowSkip, type FlowSkipCause, type FlowSkipReason, type FlowSkipRecords } from './skip-state';

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
    /** Optional so readiness tests without a scheduler ledger keep working. */
    skipRecords?: FlowSkipRecords;
    maxIterations(node: DagNodeDefinition): number;
    doneAt(nodeId: string, iteration: number): boolean;
    latestDone(nodeId: string): boolean;
}

export function readyFlowNodes(state: SchedulerReadiness): DagNodeDefinition[] {
    let candidates: DagNodeDefinition[], skippedCount: number;
    do {
        skippedCount = state.skipped.size;
        candidates = state.nodes.filter(node => nodeReady(state, node));
    } while (state.skipped.size !== skippedCount);
    return candidates.filter(node => {
        if (node.plugin !== 'builtin.return') return true;
        const prefix = node.id.slice(0, node.id.lastIndexOf('/') + 1);
        return !state.nodes.some(member => member.id !== node.id && member.id.startsWith(prefix)
            && !state.detachedNodes.has(member.id) && (candidates.includes(member)
                || (state.instances.get(member.id) ?? []).some((_, index) => !state.doneAt(member.id, index + 1))));
    });
}

function nodeReady(state: SchedulerReadiness, node: DagNodeDefinition): boolean {
    const calls = Object.entries(state.spec.parameterScopes ?? {}).filter(([prefix]) => node.id.startsWith(prefix));
    const iteration = (state.instances.get(node.id)?.length ?? 0) + 1;
    const skippedSource = calls.find(([, scope]) => scope.source && state.skipped.has(scope.source))?.[1].source;
    if (skippedSource) return skipNode(state, node, iteration, 'call-source-skipped', { nodeId: skippedSource });
    if (calls.some(([, scope]) => scope.source && !Object.hasOwn(state.callInputs, scope.source))) return false;
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
    if (gates.length && gates.every(edge => edgeStatus(state, edge) === 'inactive')) {
        return skipNode(state, node, iteration, 'branch-not-selected', edgeCause(gates[0]));
    }
    // Reference and function input barriers cannot reactivate a disabled branch.
    const branchEdges = incoming.filter(edge => !edge.dependencyOnly && !isCallInputBarrier(state, node, edge));
    if (branchEdges.length && branchEdges.every(edge => edgeStatus(state, edge) === 'inactive')) {
        // A deselected route edge differs from a branch whose producer was itself skipped.
        const deciding = branchEdges[0];
        const reason: FlowSkipReason = state.skipped.has(deciding.from) ? 'upstream-skipped' : 'branch-not-selected';
        return skipNode(state, node, iteration, reason, edgeCause(deciding));
    }
    const active = incoming.filter(edge => !state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'active');
    const pending = incoming.filter(edge => !state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'pending');
    const backActive = incoming.filter(edge => state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'active');
    const backPending = incoming.filter(edge => state.backEdges.has(edge.id) && edgeStatus(state, edge) === 'pending');
    if (!active.length && !pending.length && !backActive.length && !backPending.length) {
        return skipNode(state, node, iteration, 'upstream-skipped', incoming[0] ? edgeCause(incoming[0]) : undefined);
    }
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

/** Loop members re-enter instead of terminating; everything else records why it never ran. */
function skipNode(state: SchedulerReadiness, node: DagNodeDefinition, iteration: number,
    reason: FlowSkipReason, cause?: FlowSkipCause): false {
    if (state.loopNodes.has(node.id)) return false;
    state.skipped.add(node.id);
    if (state.skipRecords) {
        recordFlowSkip(state.skipRecords, String(node.id), { reason, iteration, ...(cause ? { cause } : {}) });
    }
    return false;
}

function edgeCause(edge: DagEdgeDefinition): FlowSkipCause {
    return { nodeId: String(edge.from), edgeId: String(edge.id) };
}

function edgeStatus(state: SchedulerReadiness, edge: DagEdgeDefinition): EdgeState {
    return state.skipped.has(edge.from) ? 'inactive' : state.edgeState.get(edge.id) ?? 'active';
}

function isCallInputBarrier(state: SchedulerReadiness, node: DagNodeDefinition, edge: DagEdgeDefinition): boolean {
    return edge.kind === 'control' && Object.entries(state.spec.parameterScopes ?? {})
        .some(([prefix, scope]) => node.id.startsWith(prefix) && scope.source === edge.from);
}

function loopMembers(node: DagNodeDefinition): string[] {
    const config = node.config;
    const members = config && typeof config === 'object' && !Array.isArray(config) && 'members' in config ? config.members : undefined;
    return members as string[];
}
