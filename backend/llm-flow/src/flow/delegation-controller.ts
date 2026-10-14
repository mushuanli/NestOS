import type { TaskHandle } from '@itookit/durable-kernel';
import type { DagRunSpec, FlowWorkspacePolicy, JsonValue } from '../contracts';
import { delegationPlan, materializeDelegation } from './delegation-runtime';
import type { DelegationGroup, DelegationPlan, DelegationRuntimeState } from './delegation-runtime';
import type { createRunCatalog } from './run-catalog';
import { resolveNodeConnection } from './connections';
import { instanceKey, parseInstanceKey } from './node-instance';

/** One run's delegation state; the scheduler owns persistence and task submission. */
export interface DelegationControllerState extends DelegationRuntimeState {
    maxNodes: number;
    plugins: ReturnType<typeof createRunCatalog>;
    nodeDefaults: Map<string, Record<string, unknown>>;
    nodeConnections: Map<string, NonNullable<DagRunSpec['nodeConnections']>[string]>;
    instances: Map<string, TaskHandle[]>;
    completed: Set<string>;
    skipped: Set<string>;
    detachedNodes: Set<string>;
    isolatedWorkspace: boolean;
    workspaceCleanup?: FlowWorkspacePolicy['cleanup'];
    spawned(event: { parentNodeId: string; groupId: string; count: number }): Promise<void>;
}

/** Enforce the persisted wait/failure declarations without choosing host policy. */
export class DelegationController {
    constructor(private readonly state: DelegationControllerState) {}

    async apply(key: string, output: unknown): Promise<void> {
        const state = this.state;
        const { nodeId, iteration } = parseInstanceKey(key);
        const node = state.nodes.find(item => String(item.id) === nodeId);
        if (!node) return;
        const plan = delegationPlan(node, key, iteration, state.depths.get(nodeId) ?? 0, output);
        if (!plan) return;
        this.assertPlan(plan);
        materializeDelegation(node, plan, state);
        state.plugins.addNodes(state.nodes.filter(item => state.groups.get(plan.groupId)?.children.has(item.id)));
        await state.spawned({ parentNodeId: node.id, groupId: plan.groupId, count: plan.payloads.length });
        const group = state.groups.get(plan.groupId);
        if (!group) return;
        this.inheritBindings(node.id, group);
        this.markDetached(group);
    }

    async settle(key: string, succeeded: boolean): Promise<void> {
        const { nodeId } = parseInstanceKey(key);
        const group = this.groupFor(nodeId);
        if (!group) return;
        group.completed.add(nodeId);
        if (succeeded) group.succeeded.add(nodeId);
        const satisfied = groupSatisfied(group);
        if (!satisfied && group.completed.size >= group.children.size
            && (group.waitMode === 'first-success' || group.waitMode === 'quorum')) {
            throw new Error(`Delegation ${group.waitMode} condition could not be satisfied`);
        }
        if (!satisfied || group.waitMode === 'all' || group.remaining === 'continue') return;
        await this.cancelChildren(group, `Delegation ${group.waitMode} condition satisfied`,
            childId => !group.completed.has(childId), false);
    }

    async fail(key: string, message?: string): Promise<void> {
        const { nodeId } = parseInstanceKey(key);
        const group = this.groupFor(nodeId);
        if (!group || group.policy === 'continue') return;
        await this.cancelChildren(group, `Delegation sibling failed: ${nodeId}`, childId => childId !== nodeId);
        throw new Error(message ?? `Delegated task failed: ${nodeId}`);
    }

    async enforceDeadlines(): Promise<void> {
        for (const [groupId, group] of this.state.groups) {
            if (!group.deadline || Date.now() < group.deadline) continue;
            await this.cancelChildren(group, `Delegation timeout: ${groupId}`);
            if (!group.detached) throw new Error(`Delegation group timed out: ${groupId}`);
        }
    }

    toleratedChildren(): Set<string> {
        const tolerated = new Set<string>();
        for (const group of this.state.groups.values()) {
            if (group.policy !== 'continue' && group.waitMode === 'all') continue;
            for (const child of group.children) tolerated.add(child);
        }
        return tolerated;
    }

    private assertPlan(plan: DelegationPlan): void {
        if (plan.detached && !plan.waitTimeoutMs) {
            throw new Error(`Detached delegation requires wait.timeoutMs: ${plan.groupId}`);
        }
        const state = this.state;
        const additions = plan.payloads.filter((_, index) =>
            !state.nodes.some(node => node.id === `${plan.parentId}:delegate:${plan.parentIteration}:${index}`));
        if (state.nodes.length + additions.length > state.maxNodes) {
            throw new Error(`Flow node limit exceeded by delegation ${plan.groupId}: ${state.nodes.length + additions.length}/${state.maxNodes}`);
        }
    }

    private inheritBindings(parentId: string, group: DelegationGroup): void {
        const state = this.state;
        const defaults = state.nodeDefaults.get(parentId);
        if (defaults) for (const child of group.children) state.nodeDefaults.set(child, defaults);
        const connection = state.nodeConnections.get(parentId);
        if (!connection) return;
        for (const child of state.nodes.filter(node => group.children.has(node.id))) {
            state.nodeConnections.set(child.id, connection);
            resolveNodeConnection(child.config as JsonValue,
                connection.connections, connection.defaultConnection, connection.fallbackConnectionId, connection.runConnectionId);
        }
    }

    private markDetached(group: DelegationGroup): void {
        if (!group.detached) return;
        const state = this.state;
        if (state.isolatedWorkspace && state.workspaceCleanup !== 'keep') {
            throw new Error('Detached delegation requires workspace.cleanup=keep when using an isolated workspace');
        }
        for (const child of group.children) state.detachedNodes.add(child);
    }

    private groupFor(nodeId: string): DelegationGroup | undefined {
        const groupId = this.state.groupByChild.get(nodeId);
        return groupId ? this.state.groups.get(groupId) : undefined;
    }

    private async cancelChildren(group: DelegationGroup, reason: string,
        include: (childId: string) => boolean = () => true, pendingOnly = true): Promise<void> {
        const state = this.state;
        const cancellations: Promise<void>[] = [];
        for (const childId of group.children) {
            if (!include(childId)) continue;
            state.skipped.add(childId);
            for (const [index, handle] of (state.instances.get(childId) ?? []).entries()) {
                if (!pendingOnly || !state.completed.has(instanceKey(childId, index + 1))) {
                    cancellations.push(handle.cancel(reason));
                }
            }
        }
        await Promise.allSettled(cancellations);
    }
}

function groupSatisfied(group: DelegationGroup): boolean {
    if (group.waitMode === 'all') return group.completed.size >= group.children.size;
    if (group.waitMode === 'any') return group.completed.size >= 1;
    return group.succeeded.size >= group.quorum;
}
