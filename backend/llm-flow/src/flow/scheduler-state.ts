import type { TaskHandle, SessionHandle } from '@itookit/durable-kernel';
import type { DagRunSpec } from '../contracts';
import type { DelegationGroup, EdgeState } from './delegation-runtime';
import type { SchedulerCheckpoint } from './scheduler-checkpoint';
import { withDispatchWorkspace } from './structured/limits';
import { FlowVariableStore } from './variables';

/** Reconstruct collections from durable data; never select new host policy on resume. */
export function createSchedulerCollections(spec: DagRunSpec, saved: SchedulerCheckpoint | undefined,
    routeEdgeIds: Set<string>, workspaceDirectory?: string) {
    const nodes = saved?.nodes ?? spec.nodes.map(node => withDispatchWorkspace(node, workspaceDirectory));
    const edges = saved?.edges ?? [...spec.edges];
    return {
        nodes, edges,
        delegationDepth: new Map(saved?.delegationDepth ?? nodes.map(node => [String(node.id), 0] as [string, number])),
        delegationGroups: restoreDelegationGroups(saved),
        delegationGroupByChild: new Map<string, string>(saved?.delegationGroupByChild),
        skipped: new Set<string>(saved?.skipped),
        detachedNodes: new Set<string>(saved?.detachedNodes),
        appliedPatches: new Map<string, string>(saved?.appliedPatches),
        appliedGraphRetries: new Set<string>(saved?.appliedGraphRetries),
        completionOrder: saved?.completionOrder ?? [],
        dispatchOrder: saved?.dispatchOrder ?? [],
        nodeGenerations: new Map<string, number>(saved?.nodeGenerations ?? []),
        edgeState: new Map<string, EdgeState>(saved?.edgeState
            ?? edges.map(edge => [edge.id, routeEdgeIds.has(edge.id) ? 'pending' : 'active'])),
        variableStore: new FlowVariableStore(spec, saved?.variables),
    };
}

export type SchedulerCollections = ReturnType<typeof createSchedulerCollections>;
type SnapshotHeader = Pick<SchedulerCheckpoint, 'contextProgramVersion' | 'spec' | 'parameters' | 'sessionContext'
    | 'catalog' | 'consumedTokens' | 'startedAt' | 'nodeDefaults' | 'nodeConnections'>;

/** Preserve the existing version-1 wire format; transient handles serialize as ids. */
export function snapshotSchedulerCollections(state: SchedulerCollections, instances: Map<string, TaskHandle[]>,
    completed: Set<string>, header: SnapshotHeader): SchedulerCheckpoint {
    return {
        ...header, version: 1, variables: state.variableStore.state,
        instances: [...instances].map(([id, handles]) => [id, handles.map(handle => handle.id)]),
        appliedGraphRetries: [...state.appliedGraphRetries],
        completed: [...completed], nodes: state.nodes, edges: state.edges, edgeState: [...state.edgeState],
        delegationDepth: [...state.delegationDepth], delegationGroupByChild: [...state.delegationGroupByChild],
        delegationGroups: [...state.delegationGroups].map(([id, group]) => [id, { ...group,
            children: [...group.children], completed: [...group.completed], succeeded: [...group.succeeded] }]),
        skipped: [...state.skipped], detachedNodes: [...state.detachedNodes], appliedPatches: [...state.appliedPatches],
        completionOrder: state.completionOrder, dispatchOrder: state.dispatchOrder, nodeGenerations: [...state.nodeGenerations],
    };
}

export async function attachSchedulerInstances(session: Pick<SessionHandle, 'attachTask'>,
    saved: SchedulerCheckpoint | undefined, instances: Map<string, TaskHandle[]>): Promise<void> {
    if (!saved) return;
    for (const [id, taskIds] of saved.instances) {
        instances.set(id, await Promise.all(taskIds.map(taskId => session.attachTask(taskId))));
    }
}

function restoreDelegationGroups(saved: SchedulerCheckpoint | undefined): Map<string, DelegationGroup> {
    return new Map(saved?.delegationGroups.map(([id, group]) => [id, { ...group,
        children: new Set(group.children), completed: new Set(group.completed), succeeded: new Set(group.succeeded) }]));
}
