import type { SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import type { DagNodeDefinition, DagPluginCatalog, HarnessHookEvent } from '../contracts';
import type { FlowExecutionHandle } from './executor';
import type { SchedulerLease } from './scheduler-lease';
import type { DelegationController } from './delegation-controller';
import type { FlowVariableStore } from './variables';
import { isSchedulerOwnershipLost } from './scheduler-lease';
import { instanceKey, parseInstanceKey } from './node-instance';
import { memberGroup, startReservedWorkers } from './control/scheduling';
import { reconcileDispatchChildren } from './structured/reconcile';
import { assertNodeOutputs } from './port-contract';

type Pending = { key: string; handle: TaskHandle };
type Exit = Awaited<ReturnType<TaskHandle['wait']>>;
interface SchedulerPorts {
    session: SessionHandle;
    run: FlowExecutionHandle;
    lease?: SchedulerLease;
    nodes: DagNodeDefinition[];
    instances: Map<string, TaskHandle[]>;
    completed: Set<string>;
    detachedNodes: Set<string>;
    nodeGenerations: Map<string, number>;
    completionOrder: string[];
    delegationGroupByChild: Map<string, string>;
    maxConcurrency: number;
    variableStore: FlowVariableStore;
    plugins: DagPluginCatalog;
    delegation: DelegationController;
    isDisposed(): boolean;
    enforceDeadlines(): Promise<void>;
    refreshCallInputs(): Promise<void>;
    readyNodes(): DagNodeDefinition[];
    submitNode(node: DagNodeDefinition, historyGroup?: string): Promise<void>;
    accountTokens(output: unknown): Promise<void>;
    emitHook(event: HarnessHookEvent, payload: Record<string, unknown>): Promise<void>;
    compensateChain(key: string): Promise<void>;
    applyEffects(output: unknown, nodeId: string): Promise<void>;
    saveCheckpoint(): Promise<void>;
    publish(run: FlowExecutionHandle): void;
}

/** Schedule live instances through explicit ports; the executor owns durable assembly. */
export class FlowScheduler {
    constructor(private readonly state: SchedulerPorts) {}

    async run(): Promise<'completed' | 'detached'> {
        while (true) {
            const permission = await this.permission();
            if (permission === 'detached') return 'detached';
            if (permission === 'paused') continue;
            await this.state.enforceDeadlines();
            await this.dispatch();
            const pending = this.pending();
            if (!pending.length) {
        if (this.state.readyNodes().length) continue;
        return 'completed';
            }
            const settled = await Promise.race(pending.map(task => this.wait(task)));
            if (this.state.isDisposed()) return 'detached';
            if ('interaction' in settled) {
        await this.state.saveCheckpoint();
        this.state.publish(this.state.run);
            } else if ('exit' in settled) await this.settle(settled, pending);
        }
    }

    private async permission(): Promise<'run' | 'paused' | 'detached'> {
        try { await this.state.lease?.assertOwned(); }
        catch (error) {
            if (!isSchedulerOwnershipLost(error)) throw error;
            return 'detached';
        }
        if (this.state.isDisposed()) return 'detached';
        const root = (await this.state.run.root.status()).task;
        if (root.status === 'cancelled') throw new Error('Flow run cancelled');
        if (root.control && root.control.mode !== 'run') {
            await new Promise(resolve => setTimeout(resolve, 25));
            return 'paused';
        }
        return 'run';
    }

    private async dispatch(): Promise<void> {
        const state = this.state;
        const scopedActive = await reconcileDispatchChildren(state.session, [...state.instances.values()].flat(), task => {
            state.run.taskIds.add(task.id);
            (state.run.childTasks ??= new Map()).set(task.id, task);
        }, state.maxConcurrency);
        const groupedActive = await startReservedWorkers(state.session, state.nodes, state.instances, state.maxConcurrency, state.detachedNodes);
        const activeCount = groupedActive ?? scopedActive ?? [...state.instances.entries()].reduce((count, [nodeId, handles]) =>
            count + (state.detachedNodes.has(nodeId) ? 0 : handles.filter((_, index) =>
                !state.completed.has(instanceKey(nodeId, index + 1))).length), 0);
        const capacity = Math.max(0, state.maxConcurrency - activeCount);
        await state.refreshCallInputs();
        const candidates = state.readyNodes();
        const reserved = candidates.filter(node => memberGroup(state.nodes, node.id) || node.plugin === 'builtin.join');
        const ready = [...reserved, ...candidates.filter(node => !reserved.includes(node)).slice(0, capacity)];
        const historyGroup = ready.length > 1 ? `${state.run.root.id}:${ready.map(node => `${node.id}#${state.instances.get(node.id)?.length ?? 0}@${state.nodeGenerations.get(node.id) ?? 0}`).join(',')}` : undefined;
        for (const node of ready) await state.submitNode(node, historyGroup);
    }

    private pending(): Pending[] {
        const { instances, detachedNodes, completed } = this.state;
        return [...instances].flatMap(([nodeId, handles]) => detachedNodes.has(nodeId) ? [] :
            handles.map((handle, index) => ({ key: instanceKey(nodeId, index + 1), handle }))
                .filter(({ key }) => !completed.has(key)));
    }

    private async wait({ key, handle }: Pending): Promise<{ key: string; exit: Exit } | { key: string; interaction: true } | { key: string; tick: true }> {
        try { return { key, exit: await handle.wait({ timeoutMs: 100 }) }; }
        catch {
            const snapshot = await handle.status();
            return Object.values(snapshot.task.interactions ?? {}).some(record => record.status === 'pending')
                ? { key, interaction: true } : { key, tick: true };
        }
    }

    private async settle(settled: { key: string; exit: Exit }, pending: Pending[]): Promise<void> {
        const state = this.state;
        state.completed.add(settled.key);
        state.completionOrder.push(parseInstanceKey(settled.key).nodeId);
        if (settled.exit.status === 'succeeded') {
            const settledNode = state.nodes.find(candidate => candidate.id === parseInstanceKey(settled.key).nodeId);
            // Validate the producer contract even when consumers accept a wider schema.
            if (settledNode) {
                state.variableStore.prune(new Set([...state.instances.values()].flat().map(handle => handle.id)));
                assertNodeOutputs(settledNode, state.plugins, settled.exit.output);
                state.variableStore.commit(settledNode, pending.find(item => item.key === settled.key)!.handle.id, settled.exit.output);
            }
        }
        await state.accountTokens(settled.exit.output);
        await state.delegation.settle(settled.key, settled.exit.status === 'succeeded');
        await state.emitHook(settled.exit.status === 'failed' ? 'task.failed' : 'task.completed', {
            nodeId: parseInstanceKey(settled.key).nodeId,
            taskId: pending.find(item => item.key === settled.key)?.handle.id,
            status: settled.exit.status,
        });
        await this.notifyDelegatedChild(settled);
        if (settled.exit.status === 'failed') {
            await state.compensateChain(settled.key);
            await state.delegation.fail(settled.key, settled.exit.error?.message);
        }
        await state.applyEffects(settled.exit.output, parseInstanceKey(settled.key).nodeId);
        await state.delegation.apply(settled.key, settled.exit.output);
        await state.saveCheckpoint();
    }

    private async notifyDelegatedChild(settled: { key: string; exit: Exit }): Promise<void> {
        const state = this.state;
        if (state.delegationGroupByChild.has(parseInstanceKey(settled.key).nodeId)) {
            await state.emitHook('agent.stopped', {
                nodeId: parseInstanceKey(settled.key).nodeId,
                status: settled.exit.status,
            });
        }
    }

}
