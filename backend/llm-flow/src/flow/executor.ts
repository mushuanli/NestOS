import { memberGroup } from './control/scheduling';
import { decodeSchedulerCheckpoint } from './checkpoint-decoder';
import { FlowScheduler } from './scheduler';
import { FlowRunAggregation, runMembers } from './run-aggregation';
import { FlowRunLifecycle, workspaceLeaseKey, cancelPendingFlowTasks } from './run-lifecycle';
import type { FlowWorkspaceLease, FlowWorkspaceManager } from './run-lifecycle';
import { createSchedulerCollections, snapshotSchedulerCollections, attachSchedulerInstances } from './scheduler-state';
import { GraphRetryController } from './graph-retry-controller';
import { FlowTaskFactory } from './task-factory';
import { prepareNodeTask } from './node-task-preparation';
import { DelegationController } from './delegation-controller';
import { instanceKey, parseInstanceKey } from './node-instance';
import { GraphMutationRuntime } from './graph-mutations';
import { readyFlowNodes } from './scheduler-readiness';
import { validateVariableGraph } from './variables';
import { rememberSchedulerLease } from './control-session';
import { fenceSchedulerSession } from './fenced-session';
import type { SchedulerCheckpoint } from './scheduler-checkpoint';
import { compileReferenceGraph, scopedParameters } from './structured/references';
import { compileDispatchGraph } from './structured/graph';
import { compileControlGraph } from './control/graph';
import { validateDispatchCapacity } from './structured/limits';
import { restoreFlowHandle } from './restore-handle';
import { acquireSchedulerLease, isSchedulerOwnershipLost, type SchedulerLease } from './scheduler-lease';
import type { WorkspaceFinalization } from './workspace-finalization';
import { createRunCatalog } from './run-catalog';
import type { DagEdgeDefinition, DagNodeDefinition, DagPluginCatalog, DagRunSpec, JsonValue as CommonJsonValue } from '../contracts';
import type { ToolDefinition } from '@itookit/llm-context';
import {
    type Kernel,
    type JsonValue,
    type SessionHandle,
    type TaskHandle,
} from '@itookit/durable-kernel';
import type { HarnessHookEvent, HarnessHookRunner } from '../contracts';
import type { SkillContext } from '@itookit/llm-tasks';

export { workspaceLeaseKey } from './run-lifecycle';
export type { FlowWorkspaceLease, FlowWorkspaceManager, FlowWorkspaceRestoreOptions } from './run-lifecycle';
import { findCycles } from './graph';
import { dataEdgeSchemaIssue } from './port-contract';
import { bindFlowTaskCapabilities } from './task-capabilities';
import { resolveFlowParameters, prepareFlowParameters } from './parameters';

export interface FlowExecutionHandle {
    /** Reattached records only; no scheduler continuation was restored. */
    attachedFromStorage?: boolean;
    sessionId: string;
    root: TaskHandle<JsonValue>;
    nodes: Map<string, TaskHandle>;
    childTasks?: Map<string, TaskHandle>;
    /** 每个节点实际执行的实例数（Loop 节点会大于 1）。 */
    iterations: Map<string, number>;
    goal?: import('../contracts').FlowRunGoal;
    detachedNodes: Set<string>;
    taskIds: Set<string>;
    /** Host workspace finalization; rejection is observable without an unhandled background promise. */
    workspaceCompletion?: Promise<void>;
    workspaceFinalization?: WorkspaceFinalization;
    usage: { tokens: number; startedAt: number; elapsedMs: number };
}

export interface DurableFlowExecutorOptions {
    kernel: Kernel;
    plugins: DagPluginCatalog;
    /** Trusted run snapshot applied to every Agent instance, including dynamically added nodes. */
    sessionContext?: { projectInstructions: string; skillInstructions: string; skillIndex: string };
    /** Resolve once for a new run only; resume always uses its persisted snapshot. */
    resolveNewRunContext?(sessionId: string): Promise<NonNullable<DurableFlowExecutorOptions['sessionContext']>>;
    /** Resolve runtime identities without granting capabilities or changing graph structure. */
    bindPatchNode?(sessionId: string, node: DagNodeDefinition, defaults?: Record<string, unknown>): Promise<Partial<Pick<DagNodeDefinition, 'config' | 'inputs'>>>;
    resolveTools?(sessionId: string, allowedIds: string[]): Promise<{
        definitions: ToolDefinition[];
        externalIds: string[];
    }>;
    /** Trusted host hooks. Flow documents can trigger events but cannot install code. */
    hooks?: HarnessHookRunner;
    workspaceManager?: FlowWorkspaceManager;
    /** Run 级调度租约有效期（默认 30s）；到期后其他宿主可接管。 */
    schedulerLeaseTtlMs?: number;
    /** 跨主机时钟误差预算（默认 0）：接管在旧租约到期后再等这么久。 */
    schedulerLeaseSkewMs?: number;
    /** 测试或宿主指定的调度者身份。 */
    schedulerOwnerId?: string;
    /**
     * Skill snapshots for a node's initially selected Skills. Implementations must keep
     * every activated tool inside the node's declared capability set.
     */
    resolveSkillContexts?: (sessionId: string, skillIds: string[], allowedToolIds: string[]) => Promise<SkillContext[]>;
}

const MAX_LOOP_ITERATIONS = 100;

export class DurableFlowExecutor {
    private readonly active = new Set<Promise<unknown>>();

    /** Drain scheduler continuations before the host closes their storage. */
    async waitIdle(): Promise<void> {
        while (this.active.size) await Promise.allSettled([...this.active]);
    }

    /** Wait for scheduled tasks, or the scheduled ancestors of durable spawned tasks. */
    async waitForCheckpoint(sessionId: string, rootTaskId: string, taskIds: string[], timeoutMs = 5_000): Promise<void> {
        const session = await this.options.kernel.openSession(sessionId);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const saved = await session.getShared(`flow.run.${rootTaskId}.scheduler`);
            const checkpoint = decodeSchedulerCheckpoint(saved?.value);
            const ids = new Set<string>((checkpoint?.instances ?? []).flatMap(([, handles]) => handles));
            // Spawned tasks are persisted by Kernel, while the scheduler owns their ancestors.
            const tasks = await session.listTasks();
            let added = true;
            while (added) {
                added = false;
                for (const task of tasks) {
                    if (!task.parentTaskId || !ids.has(task.parentTaskId) || ids.has(task.id)) continue;
                    ids.add(task.id); added = true;
                }
            }
            if (taskIds.every(id => ids.has(id))) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Flow scheduler checkpoint did not include tasks: ${taskIds.join(', ')}`);
    }

    private track(work: Promise<FlowExecutionHandle>): Promise<FlowExecutionHandle> {
        this.active.add(work);
        void work.then(() => this.active.delete(work), () => this.active.delete(work));
        return work;
    }

    private readonly lifecycle: FlowRunLifecycle;

    constructor(private readonly options: DurableFlowExecutorOptions) {
        this.lifecycle = new FlowRunLifecycle({ manager: options.workspaceManager, isDisposed: () => this.options.kernel.isDisposed });
    }

    submit(sessionId: string, spec: DagRunSpec, parameters?: Record<string, CommonJsonValue>): Promise<FlowExecutionHandle> {
        return new Promise((resolve, reject) => {
            void this.track(this.execute(sessionId, spec, parameters, resolve)).then(resolve, reject);
        });
    }

    async resume(sessionId: string, rootTaskId: string): Promise<FlowExecutionHandle> {
        const session = await this.options.kernel.openSession(sessionId);
        const handle = await restoreFlowHandle(session, rootTaskId);
        if (await handle.root.poll()) {
            // A crash during workspace finalization leaves the record pending; a new host
            // completes it instead of leaking the workspace.
            const lease = await this.acquireLease(session, rootTaskId);
            try {
                const fenced = fenceSchedulerSession(session, lease.condition);
                await this.lifecycle.resumeWorkspaceFinalization(fenced, handle.root, rootTaskId);
                await this.lifecycle.drainDetached(fenced, rootTaskId, lease);
            }
            finally { await lease.release(); }
            return handle;
        }
        const root = (await handle.root.status()).task;
        if (!record(root.state ?? root.input).awaitingSchedule) return handle;
        const saved = await session.getShared(`flow.run.${rootTaskId}.scheduler`);
        const checkpoint = decodeSchedulerCheckpoint(saved?.value ?? record(root.input).initialScheduler);
        if (!checkpoint) throw new Error('Flow scheduler checkpoint is missing');
        if (checkpoint.version !== 1) throw new Error('Unsupported Flow scheduler checkpoint');
        handle.attachedFromStorage = false;
        return new Promise((resolve, reject) => {
            void this.track(this.execute(sessionId, checkpoint.spec, checkpoint.parameters, resolve,
                { checkpoint, handle })).then(resolve, reject);
        });
    }

    private async execute(
        sessionId: string,
        spec: DagRunSpec,
        parameters: Record<string, CommonJsonValue> | undefined,
        publish: (handle: FlowExecutionHandle) => void,
        restored?: { checkpoint: SchedulerCheckpoint; handle: FlowExecutionHandle },
    ): Promise<FlowExecutionHandle> {
        const saved = restored?.checkpoint;
        const contextProgramVersion = saved ? saved.contextProgramVersion ?? '1'
            : this.options.kernel.programs?.has('llm.agent', '2') && this.options.kernel.programs?.has('llm.chat', '2') ? '2' : '1';
        spec = saved || spec.templateVersion === 1 ? structuredClone(spec) : compileReferenceGraph(compileControlGraph(compileDispatchGraph(structuredClone(spec))));
        parameters = prepareFlowParameters(spec.parameterSchema, parameters);
        validateDispatchCapacity(spec, parameters);
        validateVariableGraph(spec);
        const plugins = createRunCatalog(this.options.plugins, saved?.nodes ?? spec.nodes, saved?.catalog);
        const sessionContext = structuredClone(saved ? saved.sessionContext
            : this.options.resolveNewRunContext ? await this.options.resolveNewRunContext(sessionId) : this.options.sessionContext);
        const nodeDefaults = new Map(Object.entries(structuredClone(spec.nodeDefaults ?? {}))
            .map(([id, defaults]) => [id, parameters ? resolveFlowParameters(defaults, parameters) as Record<string, unknown> : defaults]));
        const nodeConnections = new Map(Object.entries(structuredClone(spec.nodeConnections ?? {})));
        const declaredNodes = new Map(spec.nodes.map(node => [node.id, node]));
        for (const edge of spec.edges) {
            const source = declaredNodes.get(edge.from), target = declaredNodes.get(edge.to);
            if (!source || !target) throw new Error(`Flow edge ${edge.id} references an unknown node`);
            const issue = dataEdgeSchemaIssue(edge, source, target, plugins);
            if (issue) throw new Error(`Flow edge ${edge.id}: ${issue}`);
        }
        const maxNodes = positiveInteger(spec.maxNodes ?? spec.runPolicy?.maxNodes) ?? 1_000;
        if (spec.nodes.length > maxNodes) throw new Error(`Flow node limit exceeded: ${spec.nodes.length}/${maxNodes}`);
        let session = await this.options.kernel.openSession(sessionId);
        if (!restored) await this.emitHook('run.started', sessionId, { nodeCount: spec.nodes.length });
        // A resumed Run claims scheduler ownership before touching the workspace or the
        // checkpoint, so a live owner is never overridden.
        let lease = restored ? await this.acquireLease(session, restored.handle.root.id) : undefined;
        if (lease) session = fenceSchedulerSession(session, lease.condition);
        const workspacePolicy = spec.runPolicy?.workspace;
        // A restored Run re-attaches the workspace lease recorded before the crash instead
        // of preparing a second isolated directory.
        let workspace: FlowWorkspaceLease | undefined;
        const instances = new Map<string, TaskHandle[]>();
        let published = restored?.handle;
        const completed = new Set<string>(saved?.completed);
        try {
            workspace = workspacePolicy && workspacePolicy.mode !== 'shared'
                ? restored
                    ? await this.lifecycle.restoreWorkspace(session, restored.handle.root.id, workspacePolicy)
                    : await this.lifecycle.prepareWorkspace(sessionId, workspacePolicy)
                : undefined;
            await attachSchedulerInstances(session, saved, instances);
            const maxConcurrency = positiveInteger(spec.maxConcurrency ?? spec.runPolicy?.maxConcurrency) ?? Number.MAX_SAFE_INTEGER;
            const timeoutMs = positiveInteger(spec.timeoutMs ?? spec.runPolicy?.timeoutMs);
            const maxTokens = positiveInteger(spec.maxTokens ?? spec.runPolicy?.maxTokens);
            const startedAt = saved?.startedAt ?? Date.now();
            const routeEdgeIds = collectRouteEdgeIds(spec);
            const { backEdges, loopNodes } = findCycles(spec.nodes, spec.edges);
            const collections = createSchedulerCollections(spec, saved, routeEdgeIds, workspace?.directory);
            const { nodes, edges, delegationDepth, delegationGroups, delegationGroupByChild, skipped,
                detachedNodes, appliedPatches, appliedGraphRetries, completionOrder, dispatchOrder, variableStore, nodeGenerations, edgeState } = collections;
            let consumedTokens = saved?.consumedTokens ?? 0;
            const callInputs: Record<string, unknown> = {};
            const refreshCallInputs = async () => {
                for (const scope of Object.values(spec.parameterScopes ?? {})) {
                    if (!scope.source) continue;
                    const handle = instances.get(scope.source)?.at(-1);
                    const task = handle ? (await handle.status()).task : undefined;
                    if (task?.status === 'succeeded') callInputs[scope.source] = task.output;
                    else delete callInputs[scope.source];
                }
            };
            if (saved) {
                for (const [id, value] of saved.nodeDefaults) nodeDefaults.set(id, value);
                for (const [id, value] of saved.nodeConnections) nodeConnections.set(id, value);
            }
            const checkpointSnapshot = () => snapshotSchedulerCollections(collections, instances, completed, {
                contextProgramVersion, spec, parameters, sessionContext, catalog: plugins.snapshot(),
                consumedTokens, startedAt, nodeDefaults: [...nodeDefaults], nodeConnections: [...nodeConnections],
            });
            const saveCheckpoint = async (): Promise<void> => {
                variableStore.prune(new Set([...instances.values()].flat().map(handle => handle.id)));
                if (published) await session.setShared(`flow.run.${published.root.id}.scheduler`, jsonValue(checkpointSnapshot()));
            };

            const latestDone = (nodeId: string): boolean => {
                const handles = instances.get(nodeId);
                if (!handles?.length) return false;
                return completed.has(instanceKey(nodeId, handles.length));
            };
            const doneAt = (nodeId: string, iteration: number): boolean =>
                completed.has(instanceKey(nodeId, iteration));
            // 环上的节点共享同一个迭代上限（任一环上节点声明即可），非环节点单次执行。
            const loopMaxIterations = (): number => {
                let maximum = 0;
                for (const id of loopNodes) {
                    const config = nodes.find(n => n.id === id)?.config;
                    if (isRecord(config) && typeof config.maxIterations === 'number' && config.maxIterations > 0) {
                        maximum = Math.max(maximum, config.maxIterations);
                    }
                }
                return maximum || MAX_LOOP_ITERATIONS;
            };
            const maxIterations = (node: DagNodeDefinition): number => {
                const resolved = resolveFlowParameters(node.config, scopedParameters(spec, node.id, parameters ?? {}, callInputs));
                const config = isRecord(resolved) ? resolved : {};
                if (typeof config.maxIterations === 'number' && config.maxIterations > 0) return config.maxIterations;
                return loopNodes.has(node.id) ? loopMaxIterations() : 1;
            };

            const readyNodes = () => readyFlowNodes({ spec, nodes, edges, callInputs, instances, skipped,
                detachedNodes, loopNodes, backEdges, routeEdgeIds, edgeState, dispatchOrder, maxIterations, doneAt, latestDone });

            const taskFactory = new FlowTaskFactory({
                sessionId, plugins: this.options.plugins, contextProgramVersion,
                resolveTools: this.options.resolveTools ? (id, allowed) => this.options.resolveTools!(id, allowed) : undefined,
                resolveSkillContexts: this.options.resolveSkillContexts
                    ? (id, skills, allowed) => this.options.resolveSkillContexts!(id, skills, allowed) : undefined,
                bindPatchNode: this.options.bindPatchNode
                    ? (id, node, defaults) => this.options.bindPatchNode!(id, node, defaults) : undefined,
            });
            const preparation = { sessionId, spec, nodes, edges, instances, skipped, backEdges, loopNodes,
                edgeState, plugins, parameters, callInputs, variableStore, nodeConnections, sessionContext, maxConcurrency, latestDone };
            const submitNode = async (source: DagNodeDefinition, historyGroup?: string): Promise<void> => {
                const { node, iteration, task, dependencies, parameters: localParameters, context } = await prepareNodeTask(preparation, source);
                await this.emitHook('task.started', sessionId, { nodeId: node.id, iteration });
                // The generation keeps re-submissions after a graph retry distinct, while a
                // crash-recovery re-submission (same generation) still deduplicates.
                const requestId = published
                    ? `flow:${published.root.id}:${node.id}#${iteration}@${nodeGenerations.get(node.id) ?? 0}`
                    : undefined;
                const taskSpec = await taskFactory.create(node, task, dependencies, localParameters, requestId);
                if (memberGroup(nodes, node.id)) taskSpec.deferStart = true;
                if (historyGroup) taskSpec.labels = { ...taskSpec.labels, flowHistoryGroup: historyGroup };
                const handle = await session.submit(taskSpec);
                variableStore.remember(handle.id, context);
                if (!instances.has(node.id)) instances.set(node.id, []);
                instances.get(node.id)!.push(handle);
                if (published) {
                    published.nodes.set(node.id, handle);
                    published.iterations.set(node.id, iteration);
                    published.taskIds.add(handle.id);
                    await session.setShared(`flow.run.${published.root.id}.members`, jsonValue(runMembers(instances, nodes, detachedNodes)));
                }
                if (!memberGroup(nodes, node.id)) await bindFlowTaskCapabilities(session, handle, task.programKind, node.capabilities ?? [], node.budget);
                if (published) await saveCheckpoint();
            };

            const graphMutations = new GraphMutationRuntime({
                spec, parameters, nodes, edges, plugins, maxNodes, appliedPatches, nodeDefaults, nodeConnections,
                edgeState, backEdges, skipped, dispatchOrder, instances, workspaceDirectory: workspace?.directory,
                bindNode: this.options.bindPatchNode
                    ? (node, defaults) => this.options.bindPatchNode!(sessionId, node, defaults) : undefined,
            });
            const applyEffects = (output: unknown, parentId: string) => graphMutations.applyEffects(output, parentId);

            const delegation = new DelegationController({
                nodes, edges, edgeState, depths: delegationDepth, groups: delegationGroups,
                groupByChild: delegationGroupByChild, maxNodes, plugins, nodeDefaults, nodeConnections,
                instances, completed, skipped, detachedNodes, isolatedWorkspace: Boolean(workspace),
                workspaceCleanup: workspacePolicy?.cleanup,
                spawned: event => this.emitHook('agent.spawned', sessionId, event),
            });
            const enforceDeadlines = async (): Promise<void> => {
                if (timeoutMs && Date.now() - startedAt >= timeoutMs) {
                    await cancelPendingFlowTasks(instances, completed, 'Flow timeout exceeded');
                    throw new Error(`Flow timeout exceeded after ${timeoutMs}ms`);
                }
                await delegation.enforceDeadlines();
            };

            // Saga 补偿链：节点失败时，先补偿失败节点自身，再沿依赖链反向补偿
            // 所有已成功的上游节点（最后成功的先补偿），对应 Compensate B → Compensate A。
            const compensateChain = async (key: string): Promise<void> => {
                const failedNodeId = parseInstanceKey(key).nodeId;
                const failedNode = nodes.find(item => item.id === failedNodeId);
                const compensations: string[] = [];
                if (failedNode?.compensate) compensations.push(failedNode.compensate);
                for (const upstreamId of upstreamOf(edges, failedNodeId)) {
                    const upstream = nodes.find(item => item.id === upstreamId);
                    if (upstream?.compensate) compensations.push(upstream.compensate);
                }
                for (const compensateId of compensations) {
                    const compensation = nodes.find(item => item.id === compensateId);
                    if (!compensation || instances.has(compensateId)) continue;
                    await submitNode(compensation);
                }
            };

            // A node failure is explicitly tolerated when an outgoing edge says
            // onFailure=continue, or when it belongs to a continue delegation group.
            const toleratedFailureNodes = (): Set<string> => {
                const tolerated = new Set<string>();
                for (const node of nodes) {
                    if (edges.some(edge => edge.from === node.id && edge.onFailure === 'continue')) {
                        tolerated.add(String(node.id));
                    }
                }
                for (const child of delegation.toleratedChildren()) tolerated.add(child);
                return tolerated;
            };

            // Resolve the active fenced session lazily: root creation precedes lease acquisition.
            const aggregateState = { instances, nodes, detachedNodes, groups: delegationGroups, completionOrder };
            const aggregate = (request: Parameters<FlowRunAggregation['finish']>[0]) =>
                new FlowRunAggregation(session, aggregateState).finish(request);
            // Persist the aggregate root before the first node is scheduled: it is the
            // Run's durable anchor, and the scheduler checkpoint is keyed by its id, so
            // creating it up front lets a crash at any later point resume from committed
            // state instead of restarting the whole graph.
            if (!published) {
                published = await aggregate({ goal: spec.goal,
                    usage: { tokens: consumedTokens, startedAt, elapsedMs: Date.now() - startedAt },
                    awaitingSchedule: true, toleratedFailures: toleratedFailureNodes(),
                    initial: { initialScheduler: jsonValue(checkpointSnapshot()), ...(workspace?.record !== undefined ? { initialWorkspace: workspace.record } : {}) },
                });
                lease = await this.acquireLease(session, published.root.id);
                session = fenceSchedulerSession(session, lease.condition);
                await saveCheckpoint();
                // The lease record is what lets a new host restore this workspace.
                if (workspace?.record !== undefined) {
                    await session.setShared(workspaceLeaseKey(published.root.id), workspace.record);
                }
            }
            // Publish as soon as the durable root exists and this host owns the scheduler,
            // before any node is dispatched. Hosts need a live handle to monitor progress,
            // enforce per-task timeouts, react to interrupts and follow events; a handle
            // that only resolves after the whole graph finished offers no monitoring window
            // at all. The handle stays live: node/task maps are filled as the scheduler
            // dispatches, so consumers read final state from `root.wait()`.
            publish(published);
            // Graph retries accepted while no scheduler owned the Run are applied before the
            // next scheduling turn: attach the retry instance and drop stale downstream work.
            const graphRetries = new GraphRetryController({
                session, run: published, nodes, edges, instances, completed, skipped, detachedNodes,
                groups: delegationGroups, depths: delegationDepth, groupByChild: delegationGroupByChild,
                nodeGenerations, appliedGraphRetries, nodeDefaults, nodeConnections, edgeState, routeEdgeIds, variables: variableStore,
                refund: output => { consumedTokens = Math.max(0, consumedTokens - outputTokens(output)); },
                persist: async () => {
                    await session.setShared(`flow.run.${published!.root.id}.members`, jsonValue(runMembers(instances, nodes, detachedNodes)));
                    await saveCheckpoint();
                },
            });
            await graphRetries.consume();
            const scheduler = new FlowScheduler({
                session, run: published, lease, nodes, instances, completed, detachedNodes,
                nodeGenerations, completionOrder, delegationGroupByChild, maxConcurrency,
                variableStore, plugins, delegation, enforceDeadlines, refreshCallInputs,
                readyNodes, submitNode, compensateChain, applyEffects, saveCheckpoint, publish,
                isDisposed: () => this.options.kernel.isDisposed,
                emitHook: (event, payload) => this.emitHook(event, sessionId, payload),
                accountTokens: async output => {
                    consumedTokens += outputTokens(output);
                    if (maxTokens && consumedTokens > maxTokens) {
                        await cancelPendingFlowTasks(instances, completed, 'Flow token budget exceeded');
                        throw new Error(`Flow token budget exceeded: ${consumedTokens}/${maxTokens}`);
                    }
                },
            });
            if (await scheduler.run() === 'detached') return published;

            const result = await aggregate({ goal: spec.goal,
                usage: { tokens: consumedTokens, startedAt, elapsedMs: Date.now() - startedAt },
                existing: published, toleratedFailures: toleratedFailureNodes(),
            });
            if (workspace) await this.lifecycle.finalizeWorkspace(session, result, workspace);
            void result.root.wait().then(exit => this.emitHook('run.completed', sessionId, {
                taskId: result.root.id, status: exit.status,
            })).catch(() => undefined);
            await this.lifecycle.drainDetached(session, result.root.id, lease!);
            return result;
        } catch (error) {
            if (published && isSchedulerOwnershipLost(error)) return published;
            if (published && lease) {
                try { await lease.assertOwned(); }
                catch (ownershipError) {
                    if (isSchedulerOwnershipLost(ownershipError)) return published;
                    throw ownershipError;
                }
            }
            // A host may already hold the published handle (submit resolved), so a scheduler
            // failure must be observable on the Run itself, not only as a rejected promise.
            // Cancel and clean up first, then report the combined message on the root.
            const failure = await this.lifecycle.cleanupFailedSubmission(instances, completed, workspace, error, published?.root.id);
            if (published && !this.options.kernel.isDisposed) {
                const message = failure instanceof AggregateError
                    ? failure.errors.map(item => item instanceof Error ? item.message : String(item)).join('; ')
                    : String(error);
                await session.signal(published.root.id, { type: 'flow.schedule.failed', payload: message });
            }
            throw failure;
        } finally {
            // Releasing lets the next host resume without waiting for the TTL; a crashed
            // host cannot run this, so its lease expires instead.
            await lease?.release();
        }
    }

    private async acquireLease(session: SessionHandle, rootTaskId: string): Promise<SchedulerLease> {
        const lease = await acquireSchedulerLease(session, rootTaskId, {
            ...(this.options.schedulerLeaseTtlMs ? { ttlMs: this.options.schedulerLeaseTtlMs } : {}),
            ...(this.options.schedulerLeaseSkewMs !== undefined ? { skewMs: this.options.schedulerLeaseSkewMs } : {}),
            ...(this.options.schedulerOwnerId ? { ownerId: this.options.schedulerOwnerId } : {}),
        });
        return rememberSchedulerLease(this.options.kernel, rootTaskId, lease);
    }

    private async emitHook(
        event: HarnessHookEvent,
        sessionId: string,
        payload: Record<string, unknown>,
    ): Promise<void> {
        if (!this.options.hooks) return;
        const hook = this.options.hooks;
        if (!hook.descriptor.trusted || !hook.descriptor.contentHash || !hook.descriptor.source) {
            throw new Error(`Harness hook is not trusted: ${hook.descriptor.source || 'unknown source'}`);
        }
        const result = await withTimeout(
            hook.emit({ event, sessionId, payload: jsonValue(payload) }),
            positiveInteger(hook.descriptor.timeoutMs) ?? 5_000,
            `Harness hook timed out: ${event}`,
        );
        if (result?.message && result.message.length > (positiveInteger(hook.descriptor.maxMessageLength) ?? 4_096)) {
            throw new Error(`Harness hook output is too large: ${event}`);
        }
        if (result?.action === 'deny') throw new Error(result.message ?? `Harness hook denied ${event}`);
    }


}


/** 收集 route 节点声明的出边 id（含默认边；这些边默认 pending，等 route 决定激活/禁用）。 */
function collectRouteEdgeIds(spec: DagRunSpec): Set<string> {
    const ids = new Set<string>();
    for (const node of spec.nodes) {
        if (node.plugin !== 'builtin.route' || !isRecord(node.config)) continue;
        const rules = Array.isArray(node.config.rules) ? node.config.rules : [];
        for (const rule of rules.filter(isRecord)) {
            const edgeId = String(rule.edgeId ?? '').trim();
            if (edgeId) ids.add(edgeId);
        }
        if (typeof node.config.defaultEdgeId === 'string' && node.config.defaultEdgeId.trim()) {
            ids.add(node.config.defaultEdgeId.trim());
        }
    }
    return ids;
}

/** 反向 BFS：返回 nodeId 的所有祖先（入边可达），距离近的在前。 */
export function upstreamOf(edges: DagEdgeDefinition[], nodeId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>([nodeId]);
    const queue = [nodeId];
    while (queue.length) {
        const current = queue.shift()!;
        for (const edge of edges) {
            if (edge.to !== current || visited.has(edge.from)) continue;
            visited.add(edge.from);
            result.push(edge.from);
            queue.push(edge.from);
        }
    }
    return result;
}

function jsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function record(value: unknown): Record<string, CommonJsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, CommonJsonValue>
        : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function outputTokens(output: unknown): number {
    if (!isRecord(output) || !isRecord(output.usage)) return 0;
    const total = output.usage.totalTokens ?? output.usage.total_tokens;
    return typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 0;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
