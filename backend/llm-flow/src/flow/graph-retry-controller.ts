import type { SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import type { DagEdgeDefinition, DagNodeDefinition, DagRunSpec } from '../contracts';
import type { DelegationGroup, EdgeState } from './delegation-runtime';
import type { FlowVariableStore } from './variables';
import { consumeGraphRetryIntents, type FlowGraphRetryIntent } from './graph-retry';
import { instanceKey } from './node-instance';

export interface RetryRunView {
    root: { id: string };
    nodes: Map<string, TaskHandle>;
    iterations: Map<string, number>;
    taskIds: Set<string>;
}

export interface GraphRetryState {
    session: Pick<SessionHandle, 'getShared' | 'setShared' | 'attachTask'>;
    run: RetryRunView;
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    instances: Map<string, TaskHandle[]>;
    completed: Set<string>;
    skipped: Set<string>;
    detachedNodes: Set<string>;
    groups: Map<string, DelegationGroup>;
    depths: Map<string, number>;
    groupByChild: Map<string, string>;
    nodeGenerations: Map<string, number>;
    appliedGraphRetries: Set<string>;
    nodeDefaults: Map<string, Record<string, unknown>>;
    nodeConnections: Map<string, NonNullable<DagRunSpec['nodeConnections']>[string]>;
    edgeState: Map<string, EdgeState>;
    routeEdgeIds: Set<string>;
    variables: FlowVariableStore;
    refund(output: unknown): void;
    persist(): Promise<void>;
}

/** Reconcile accepted retry intents with the scheduler's live graph. */
export class GraphRetryController {
    constructor(private readonly state: GraphRetryState) {}

    async consume(): Promise<number> {
        return consumeGraphRetryIntents(this.state.session, this.state.run.root.id,
            intent => this.apply(intent), () => this.state.persist());
    }

    private async apply(intent: FlowGraphRetryIntent): Promise<void> {
        const state = this.state;
        if (state.appliedGraphRetries.has(intent.requestId)) return;
        const source = String(intent.sourceNodeId);
        const reason = `Graph retry of ${source}`;
        state.variables.retry(intent.sourceTaskId, intent.retryTaskId);
        await this.discardGroups(source, reason);
        const handles = state.instances.get(source) ?? [];
        if (!handles.some(handle => handle.id === intent.retryTaskId)) {
            const retry = await state.session.attachTask(intent.retryTaskId);
            handles.push(retry);
            state.instances.set(source, handles);
            state.run.nodes.set(source, retry);
            state.run.iterations.set(source, handles.length);
            state.run.taskIds.add(intent.retryTaskId);
        }
        for (const nodeId of intent.downstream) await this.resetDownstream(nodeId, reason);
        state.appliedGraphRetries.add(intent.requestId);
    }

    private async resetDownstream(nodeId: string, reason: string): Promise<void> {
        const state = this.state;
        this.nextGeneration(nodeId);
        await this.discardGroups(nodeId, reason);
        await this.discardInstances(nodeId, reason, false);
        this.clearNodeView(nodeId);
        for (const edge of state.edges.filter(item => String(item.to) === nodeId)) {
            state.edgeState.set(edge.id, state.routeEdgeIds.has(edge.id) ? 'pending' : 'active');
        }
    }

    private async discardGroups(parentNodeId: string, reason: string): Promise<void> {
        const state = this.state;
        for (const [groupId, group] of [...state.groups]) {
            if (!groupId.startsWith(`${parentNodeId}#`)) continue;
            for (const childId of group.children) {
                await this.discardGroups(childId, reason);
                await this.discardInstances(childId, reason, true);
                this.removeDelegatedNode(childId);
            }
            const removed = state.edges.filter(edge => group.children.has(String(edge.from)) || group.children.has(String(edge.to)));
            for (const edge of removed) state.edgeState.delete(edge.id);
            state.edges.splice(0, state.edges.length, ...state.edges.filter(edge => !removed.includes(edge)));
            state.groups.delete(groupId);
        }
    }

    private async discardInstances(nodeId: string, reason: string, removeMembership: boolean): Promise<void> {
        const state = this.state;
        for (const [index, handle] of (state.instances.get(nodeId) ?? []).entries()) {
            const key = instanceKey(nodeId, index + 1);
            if (state.completed.has(key)) {
                const snapshot = await handle.status().catch(() => undefined);
                if (snapshot) state.refund(snapshot.task.output);
            } else await handle.cancel(reason).catch(() => undefined);
            if (removeMembership) state.run.taskIds.delete(handle.id);
            state.completed.delete(key);
        }
        state.instances.delete(nodeId);
    }

    private removeDelegatedNode(nodeId: string): void {
        const state = this.state;
        this.clearNodeView(nodeId);
        state.detachedNodes.delete(nodeId);
        state.depths.delete(nodeId);
        state.groupByChild.delete(nodeId);
        this.nextGeneration(nodeId);
        state.nodeDefaults.delete(nodeId);
        state.nodeConnections.delete(nodeId);
        const index = state.nodes.findIndex(node => String(node.id) === nodeId);
        if (index >= 0) state.nodes.splice(index, 1);
    }

    private clearNodeView(nodeId: string): void {
        this.state.run.nodes.delete(nodeId);
        this.state.run.iterations.delete(nodeId);
        this.state.skipped.delete(nodeId);
    }

    private nextGeneration(nodeId: string): void {
        const generations = this.state.nodeGenerations;
        generations.set(nodeId, (generations.get(nodeId) ?? 0) + 1);
    }
}
