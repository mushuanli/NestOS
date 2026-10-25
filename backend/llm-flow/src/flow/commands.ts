import {taskStat} from '@itookit/durable-kernel';
import {readFlowRunMembers} from './run-members';
import {checkFlowSource, checkFlowSyntax} from './syntax-check';
import { hasLocalScheduler, withFlowControl } from './control-session';
import { workspaceFinalizationKey, type WorkspaceFinalization } from './workspace-finalization';
import type { DagPluginCatalog, DagPluginPresentation, FlowDraft, FlowNodeDefinition, FlowRevision, FlowCommandRegistrar, JsonValue, FlowRunGoal } from '../contracts';
import type { ToolDefinition } from '@itookit/llm-context';
import type { Kernel, SessionHandle, TaskRecord, TaskSnapshot } from '@itookit/durable-kernel';
import { type FlowDefinitionStore } from '../flow-definition-store';
import { submitRun, type GraphRunDefinition } from '../run-submission';
import { expandDispatchDraft } from './structured/expand';
import { type FlowNodeBinder } from './to-dag';
import { FlowCommand } from './command-names';
import { retryFlowTask } from './retry-task';
import { requestFlowGraphRetry } from './graph-retry';
import { restoreFlowHandle } from './restore-handle';
import { readFlowTaskTranscript, type FlowTranscriptQuery } from './transcript';
import { DurableFlowExecutor, type FlowExecutionHandle } from './executor';
import { prepareFlowRun } from './prepare-run';
import { readFlowSchedulerCheckpoint } from './checkpoint-store';
import {traceFlowRetry, traceFlowRunControl, type FlowControlDiagnostic} from './control-diagnostics';
import type {FlowGoalUpdate} from '../contracts/flow-control';
import {invocationFromLabels} from './invocation-identity';
import {readInvocationFrame} from './invocation-projection';
import {assertRootCallable} from '../contracts/callable-exposure';
import {sameTargetRef} from '../contracts/call-target';
import {controlFlowRun, assertCurrentFlowControl, assertFlowRoot, assertPauseWithdrawal} from './run-control';
import {assertFlowControlTree} from './control-tree';

export interface DagCommandServiceOptions {
    validateInputAssets?(sessionId: string, parameters: Record<string, JsonValue>): Promise<void>;
    onControlDiagnostic?(event: FlowControlDiagnostic): void;
    prepareConnections?: (flow: FlowRevision, bindings?: Record<string, string>, runConnectionId?: string) => Promise<FlowRevision>;
    /** Capture host-owned defaults once for this preparation, including nested calls. */
    prepareConnectionResolver?(sessionId: string): Promise<NonNullable<DagCommandServiceOptions['prepareConnections']>>;
    resolveConnection?(sessionId: string, connectionId?: string): Promise<string | undefined>;
    resolveSkillContexts?: import('./executor').DurableFlowExecutorOptions['resolveSkillContexts'];
    canWriteSession?(sessionId: string): Promise<boolean>;
    workspaceManager?: import('./executor').FlowWorkspaceManager;
    flowStore: FlowDefinitionStore;
    bindNode?: (sessionId: string, ...args: Parameters<FlowNodeBinder>) => ReturnType<FlowNodeBinder>;
    kernel: Kernel;
    plugins: DagPluginCatalog;
    resolveSessionContext?: (sessionId: string, userMessage: string) => Promise<{ projectInstructions: string; skillInstructions: string; skillIndex: string }>;
    resolveTools?: (sessionId: string, allowedIds: string[]) => Promise<{
        definitions: ToolDefinition[];
        externalIds: string[];
    }>;
}

export interface FlowRunPreparation {
    sessionId: string;
    flow: FlowRevision;
    parameters?: Record<string, JsonValue>;
    connectionId?: string;
    fallbackConnectionId?: string | null;
    connectionBindings?: Record<string, string>;
}

export interface FlowRunSummary { taskId: string; sessionId: string; name: string; status: string; createdAt: number; invocation?: import('../contracts').InvocationIdentity; }

export interface DurableFlowSnapshot {
    controlStats?: Record<string, import('@itookit/durable-kernel/contracts').TaskStat>;
    invocationIdentityVersion?: 1;
    controlTaskIds?: string[];
    invocation?: import('../contracts').InvocationIdentity;
    variables?: import('./variables').VariableCheckpoint;
    workspaceFinalization?: WorkspaceFinalization;
    attachedFromStorage?: boolean;
    root: TaskSnapshot;
    nodes: Array<{ nodeId: string; snapshot: TaskSnapshot; invocation?: import('../contracts').InvocationIdentity }>;
    /** Per-node execution instance count (loop nodes exceed 1). */
    iterations: Record<string, number>;
    taskTree: TaskRecord[];
    detachedNodes: string[];
    goal?: FlowRunGoal;
    usage: FlowExecutionHandle['usage'];
}

export class DagCommandService {
    private readonly handles = new Map<string, FlowExecutionHandle>();

    constructor(private readonly options: DagCommandServiceOptions) {}

    register(bus: FlowCommandRegistrar): void {
        registerDraftCommands(bus, this.options.flowStore, this.options.plugins);
        bus.register(FlowCommand.Presentations, async () =>
            loadPresentations(this.options.plugins));
        bus.register(FlowCommand.RunResume, async args => {
            const input = args as { sessionId: string; taskId: string };
            return this.resumeRun(input.sessionId, input.taskId);
        });
        bus.register(FlowCommand.RunList, async args => this.listRuns((args as { sessionId?: string } | undefined)?.sessionId));
        bus.register(FlowCommand.RunStart, async args => {
            const input = args as { connectionBindings?: Record<string, string>; connectionId?: string; fallbackConnectionId?: string | null; sessionId: string; flow: FlowRevision; parameters?: Record<string, JsonValue>; goal?: FlowRunGoal; invocation?: import('../contracts').DagRunSpec['invocation'] };
            return this.start(input.sessionId, input.flow, input.parameters, input.goal, input.invocation, input.connectionId, input.fallbackConnectionId, input.connectionBindings);
        });
        bus.register(FlowCommand.RunGet, async args => {
            const input = args as { taskId: string; sessionId?: string };
            return this.snapshot(String(input.taskId), input.sessionId);
        });
        bus.register(FlowCommand.RunTranscript, async args => {
            const input = args as { sessionId: string; taskId: string; targetTaskId: string; query?: FlowTranscriptQuery };
            return readFlowTaskTranscript(this.options.kernel, input.sessionId, input.taskId, input.targetTaskId, input.query);
        });
        bus.register(FlowCommand.RunCancel, async args => this.cancel(String((args as { taskId: string }).taskId)));
        bus.register(FlowCommand.RunPauseWithdraw, args => this.withdrawPause(args as {taskId: string; requestId: string; expectedEpoch: number}));
        bus.register(FlowCommand.RunRespond, async args => {
            const input = args as { taskId: string; requestId: string; value: unknown; targetTaskId?: string };
            return this.respond(String(input.taskId), String(input.requestId), input.value, input.targetTaskId);
        });
        bus.register(FlowCommand.RunSignal, async args => {
            const input = args as { taskId: string; nodeId?: string; targetTaskId?: string; signal: { type: string; payload?: unknown } };
            return this.signal(input);
        });
        bus.register(FlowCommand.RunTaskRetry, async args => {
            const input = args as { sessionId: string; taskId: string; targetTaskId: string; requestId: string;
                downstream?: boolean };
            return traceFlowRetry(input, this.options.onControlDiagnostic, async () => {
                const result = await withFlowControl(this.options.kernel, input.sessionId, input.taskId, this.options.canWriteSession, async session => {
                    if (input.downstream) {
                        const request = await requestFlowGraphRetry(session, input.taskId, input.targetTaskId, input.requestId);
                        await this.snapshot(input.taskId, input.sessionId);
                        return { taskId: input.taskId, targetTaskId: request.retryTaskId, retryOfTaskId: input.targetTaskId,
                            downstream: request.downstream };
                    }
                    const task = await retryFlowTask(session, input.taskId, input.targetTaskId, input.requestId);
                    await this.snapshot(input.taskId, input.sessionId);
                    return { taskId: input.taskId, targetTaskId: task.id, retryOfTaskId: input.targetTaskId };
                });
                if (input.downstream) {
                    const root = await this.options.kernel.task(input.sessionId, input.taskId);
                    if (!['succeeded', 'failed', 'cancelled'].includes(root.status)) await this.resumeRun(input.sessionId, input.taskId);
                }
                return result;
            });
        });
        bus.register(FlowCommand.RunTaskCancel, async args => {
            const input = args as { taskId: string; targetTaskId: string; reason?: string };
            const snapshot = await this.snapshot(String(input.taskId));
            const handle = this.requireHandle(String(input.taskId));
            if (!snapshot.controlTaskIds?.includes(input.targetTaskId)) throw new Error(`Task is outside this run: ${input.targetTaskId}`);
            return withFlowControl(this.options.kernel, handle.sessionId, input.taskId, this.options.canWriteSession, async session => {
                await (await session.attachTask(input.targetTaskId)).cancel(input.reason ?? 'Cancelled from DAG run console');
                return { taskId: input.taskId, targetTaskId: input.targetTaskId, cancelled: true };
            });
        });
        bus.register(FlowCommand.RunGoalUpdate, args => this.updateGoal(args as FlowGoalUpdate));
    }

    private async updateGoal(input: FlowGoalUpdate) {
        const handle = this.requireHandle(String(input.taskId));
        return withFlowControl(this.options.kernel, handle.sessionId, input.taskId, this.options.canWriteSession, async session => {
            const key = `flow.run.${input.taskId}.goal`, saved = await session.getShared(key);
            const requestId = input.requestId ?? `goal:${input.taskId}:${(saved?.version ?? 0) + 1}`;
            const commit = async () => {
                const goal = {...((saved?.value as unknown as FlowRunGoal) ?? handle.goal ?? {objective: ''}), ...input.goal};
                const recovery = input.goal.status === 'paused' || input.goal.status === 'active'
                    ? await controlFlowRun(session, handle.root.id, input.goal.status, requestId, input.expectedEpoch) : {};
                await session.setShared(key, jsonValue(goal), {expectedVersion: saved?.version ?? null});
                handle.goal = goal;
                return {taskId: input.taskId, goal, ...recovery};
            };
            if (input.goal.status !== 'paused' && input.goal.status !== 'active') return commit();
            return traceFlowRunControl({requestId, sessionId: session.id, rootTaskId: handle.root.id,
                mode: input.goal.status === 'paused' ? 'pause' : 'resume'}, this.options.onControlDiagnostic, commit);
        });
    }

    private async withdrawPause(input: {taskId: string; requestId: string; expectedEpoch: number}) {
        assertPauseWithdrawal(input);
        const handle = this.requireHandle(input.taskId);
        return traceFlowRunControl({requestId: input.requestId, sessionId: handle.sessionId, rootTaskId: input.taskId, mode: 'withdraw'},
            this.options.onControlDiagnostic, () => withFlowControl(this.options.kernel, handle.sessionId, input.taskId, this.options.canWriteSession, async session => {
            const task = await session.attachTask(input.taskId), root = (await task.status()).task;
            assertFlowRoot(root, handle.root.id); assertFlowControlTree(root);
            const control = await task.withdrawPause({requestId: input.requestId, expectedEpoch: input.expectedEpoch});
            assertCurrentFlowControl((await task.status()).task, control);
            const key = `flow.run.${input.taskId}.goal`, saved = await session.getShared(key);
            const goal = {...((saved?.value as unknown as FlowRunGoal) ?? handle.goal ?? {objective: ''}), status: 'active' as const};
            await session.setShared(key, jsonValue(goal), {expectedVersion: saved?.version ?? null});
            handle.goal = goal;
            return {taskId: input.taskId, goal, control};
        }));
    }

    private async resumeRun(sessionId: string, taskId: string): Promise<{ taskId: string }> {
        if (this.options.canWriteSession && !await this.options.canWriteSession(sessionId)) throw new Error('Session is read-only on this host');
        if (!await hasLocalScheduler(this.options.kernel, taskId)) {
            const executor = new DurableFlowExecutor({ ...this.options,
                resolveSkillContexts: this.options.resolveSkillContexts,
                bindPatchNode: this.options.bindNode ? async (id, node, defaults) =>
                    this.options.bindNode!(id, node as FlowNodeDefinition, defaults as FlowNodeDefinition['config']) : undefined });
            this.handles.set(taskId, await executor.resume(sessionId, taskId));
        } else await this.snapshot(taskId, sessionId);
        this.requireHandle(taskId).attachedFromStorage = false;
        return { taskId };
    }

    private async listRuns(sessionId?: string): Promise<FlowRunSummary[]> {
        const runs: FlowRunSummary[] = [];
        for await (const session of this.options.kernel.listSessions()) {
            if (sessionId && session.id !== sessionId) continue;
            const inspection = await this.options.kernel.inspectSession(session.id);
            for (const task of await inspection.listTasks()) {
                if (task.program.kind !== 'flow.aggregate' || task.labels?.kind !== 'flow-root') continue;
                const input = task.input as { run?: { goal?: { objective?: string } }; initialScheduler?: { nodes?: { name?: string }[] } };
                const name = input?.run?.goal?.objective || input?.initialScheduler?.nodes?.map(node => node.name).filter(Boolean).join(' → ') || 'Flow';
                const invocation = invocationFromLabels(task.labels);
                runs.push({ taskId: task.id, sessionId: session.id, name, status: task.status, createdAt: task.createdAt,
                    ...(invocation ? {invocation} : {}) });
            }
        }
        return runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    }

    private async start(
        sessionId: string,
        flow: FlowRevision,
        parameters?: Record<string, JsonValue>,
        goal?: FlowRunGoal,
        invocation?: import('../contracts').DagRunSpec['invocation'],
        connectionId?: string,
        fallbackConnectionId?: string | null,
        connectionBindings?: Record<string, string>,
    ) {
        flow = await this.rootDefinition(flow);
        if (invocation?.target && !sameTargetRef(invocation.target, {kind: 'flow', id: flow.id, version: String(flow.revision), digest: flow.digest}))
            throw Object.assign(new Error('Invocation target does not match the published Flow'), {code: 'CALL_TARGET_CHANGED'});
        const compiled = await this.prepareRun({ sessionId, flow, parameters, connectionId, fallbackConnectionId, connectionBindings });
        return this.submitPrepared({ kind: 'graph', sessionId,
            graph: { ...compiled, ...(goal ? { goal } : {}), ...(invocation ? { invocation } : {}) }, parameters });
    }

    /** Public command snapshots cannot override an existing published definition's call scope. */
    private async rootDefinition(flow: FlowRevision): Promise<FlowRevision> {
        assertRootCallable(flow);
        const selected = await this.options.flowStore.loadRevision(String(flow.id), flow.revision);
        if (selected) { assertRootCallable(selected); return selected; }
        if (await this.options.flowStore.loadRevision(String(flow.id))) {
            throw Object.assign(new Error('Published Flow revision is unavailable'), {code: 'FLOW_REVISION_NOT_FOUND'});
        }
        return flow;
    }

    /** Compile without spawning tasks so the host can persist admission before execution. */
    async prepareRun({ sessionId, flow, parameters, connectionId, fallbackConnectionId, connectionBindings }: FlowRunPreparation) {
        if (!sessionId) throw new Error('DAG run requires sessionId');
        if (this.options.canWriteSession && !await this.options.canWriteSession(sessionId)) throw new Error('Session is read-only on this host');
        const resolved = fallbackConnectionId !== undefined ? fallbackConnectionId ?? undefined
            : await this.options.resolveConnection?.(sessionId, connectionId);
        const prepareConnections = await this.options.prepareConnectionResolver?.(sessionId) ?? this.options.prepareConnections;
        return prepareFlowRun(flow, { plugins: this.options.plugins, parameters, fallbackConnectionId: resolved, connectionId, connectionBindings,
            validateInputAssets: values => this.options.validateInputAssets?.(sessionId, values) ?? Promise.resolve(),
            bindNode: this.options.bindNode ? (node, defaults, context) => this.options.bindNode!(sessionId, node, defaults, context) : undefined,
            resolveComposite: (id, revision) => this.options.flowStore.loadRevision(id, revision), prepareConnections });
    }

    /** Submit trusted compiled input; command callers continue through RunStart admission. */
    async submitPrepared(definition: GraphRunDefinition): Promise<{ taskId: string }> {
        const { sessionId } = definition;
        if (!sessionId) throw new Error('DAG run requires sessionId');
        if (this.options.canWriteSession && !await this.options.canWriteSession(sessionId)) throw new Error('Session is read-only on this host');
        const sessionContext = await this.options.resolveSessionContext?.(sessionId, '');
        if (this.options.canWriteSession && !await this.options.canWriteSession(sessionId)) throw new Error('Session is read-only on this host');
        const executor = new DurableFlowExecutor({ ...this.options, sessionContext,
            resolveSkillContexts: this.options.resolveSkillContexts,
            bindPatchNode: this.options.bindNode ? async (id, node, defaults) =>
                this.options.bindNode!(id, node as FlowNodeDefinition, defaults as FlowNodeDefinition['config']) : undefined,
        });
        const { flow: handle } = await submitRun(definition, { kernel: this.options.kernel, flowExecutor: executor });
        this.handles.set(handle.root.id, handle);
        return { taskId: handle.root.id };
    }

    private async snapshot(taskId: string, sessionId?: string): Promise<DurableFlowSnapshot> {
        if (!this.handles.has(taskId) && sessionId) {
            this.handles.set(taskId, await restoreFlowHandle(await this.options.kernel.inspectSession(sessionId), taskId));
        }
        const handle = this.requireHandle(taskId);
        if (sessionId && sessionId !== handle.sessionId) throw new Error('Run Session mismatch');
        const session = await this.options.kernel.inspectSession(handle.sessionId);
        const root = await handle.root.status(), invocation = invocationFromLabels(root.task.labels);
        const {members, latest, history} = await readInvocationFrame(session, root.task, handle.taskIds);
        for (const entry of members) handle.taskIds.add(entry.taskId);
        return {
            ...await this.projectionMetadata(session, handle, taskId), ...(invocation ? {invocation} : {}),
            attachedFromStorage: handle.attachedFromStorage,
            controlTaskIds: [taskId, ...new Set(members.map(member => member.taskId))],
            root,
            nodes: await Promise.all([...latest].map(async ([nodeId, member]) => {
                const snapshot = await (await session.attachTask(member.taskId)).status(), invocation = invocationFromLabels(snapshot.task.labels);
                return {nodeId, snapshot, ...(invocation ? {invocation} : {})};
            })),
            iterations: Object.fromEntries([...latest].map(([nodeId, member]) => [nodeId, member.iteration])),
            taskTree: history,
            controlStats: Object.fromEntries(history.map(task => [task.id, taskStat(task)])),
            detachedNodes: [...new Set(members.filter(member => member.detached).map(member => member.nodeId))],
        };
    }

    private async projectionMetadata(session: Pick<SessionHandle, 'getShared'>, handle: FlowExecutionHandle, taskId: string) {
        const [saved, goal, workspace, scheduler] = await Promise.all([
            session.getShared(`flow.run.${taskId}.metadata`), session.getShared(`flow.run.${taskId}.goal`),
            session.getShared(workspaceFinalizationKey(taskId)), readFlowSchedulerCheckpoint(session, taskId),
        ]);
        const metadata = saved?.value as unknown as {version: number; usage: FlowExecutionHandle['usage']} | undefined;
        if (metadata?.version === 1) handle.usage = metadata.usage;
        if (goal) handle.goal = goal.value as unknown as FlowRunGoal;
        return {invocationIdentityVersion: scheduler?.invocationIdentityVersion, variables: scheduler?.variables, goal: handle.goal, usage: handle.usage,
            workspaceFinalization: handle.workspaceFinalization ?? workspace?.value as unknown as WorkspaceFinalization | undefined};
    }

    private async signal(input: {
        taskId: string;
        nodeId?: string;
        targetTaskId?: string;
        signal: { type: string; payload?: unknown };
    }) {
        const snapshot = await this.snapshot(String(input.taskId));
        const handle = this.requireHandle(String(input.taskId));
        if (input.targetTaskId && !snapshot.controlTaskIds?.includes(input.targetTaskId)) throw new Error(`Task is outside this run: ${input.targetTaskId}`);
        return withFlowControl(this.options.kernel, handle.sessionId, input.taskId, this.options.canWriteSession, async session => {
            const id = input.targetTaskId ?? (input.nodeId ? snapshot.nodes.find(node => node.nodeId === input.nodeId)?.snapshot.task.id : undefined);
            const target = id ? await session.attachTask(id) : undefined;
            if (!target) throw new Error('A valid nodeId or targetTaskId is required');
            await target.signal(input.signal);
            return { taskId: input.taskId, targetTaskId: target.id, signalled: true };
        });
    }

    private async respond(taskId: string, requestId: string, value: unknown, targetTaskId?: string) {
        const snapshot = await this.snapshot(taskId);
        const handle = this.requireHandle(taskId);
        if (targetTaskId && !snapshot.controlTaskIds?.includes(targetTaskId)) throw new Error(`Task is outside this run: ${targetTaskId}`);
        return withFlowControl(this.options.kernel, handle.sessionId, taskId, this.options.canWriteSession, async session => {
            const matches = [];
            for (const id of targetTaskId ? [targetTaskId] : snapshot.controlTaskIds ?? []) {
                const task = await session.attachTask(id);
                const interaction = (await task.status()).task.interactions?.[requestId];
                if (interaction?.status === 'pending' || (targetTaskId && interaction?.status === 'resolved')) matches.push(task);
            }
            if (matches.length > 1) throw new Error(`Ambiguous interaction ${requestId}; targetTaskId is required`);
            if (!matches.length) throw new Error(`No pending interaction ${requestId} for DAG task ${taskId}`);
            await matches[0].respond({ interactionId: requestId, value: jsonValue(value) });
            return { taskId, targetTaskId: matches[0].id, responded: true };
        });
    }

    private async cancel(taskId: string) {
        await this.snapshot(taskId);
        const handle = this.requireHandle(taskId);
        return withFlowControl(this.options.kernel, handle.sessionId, taskId, this.options.canWriteSession, async session => {
            const ids = await currentControlTaskIds(session, handle);
            const results = await Promise.allSettled(ids.map(async id => (await session.attachTask(id)).cancel()));
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Run cancellation failed');
            return { taskId, cancelled: true };
        });
    }

    private requireHandle(taskId: string): FlowExecutionHandle {
        const handle = this.handles.get(taskId);
        if (!handle) throw new Error(`DAG task is not attached: ${taskId}`);
        return handle;
    }
}

async function loadPresentations(
    plugins: DagPluginCatalog,
): Promise<DagPluginPresentation[]> {
    return Promise.all(plugins.listManifests().filter(manifest => manifest.id !== 'builtin.return').map(async manifest => ({
        manifest,
        ui: await plugins.loadUI(manifest.id, manifest.version),
    })));
}

function registerDraftCommands(
    bus: FlowCommandRegistrar,
    store: FlowDefinitionStore,
    plugins: DagPluginCatalog,
): void {
    bus.register(FlowCommand.SourceCheck, async args => {
        const { checkFlowSource } = await import('./syntax-check');
        const {valid, diagnostics} = await checkFlowSource((args as { source?: unknown } | undefined)?.source, { plugins, resolveComposite: (id, revision) => store.loadRevision(id, revision) });
        return {valid, diagnostics};
    });
    bus.register(FlowCommand.DraftList, async () => store.listDrafts());
    for (const command of [FlowCommand.DraftInstall, FlowCommand.DraftRestore]) bus.register(command, async args => {
        const draft = args as FlowDraft;
        const validation = await validateDraft(draft, plugins);
        if (!validation.valid) throw new Error(validation.validationIssues.map(issue => issue.message).join('; '));
        return store.installBuiltinDraft(draft, { restoreMissing: command === FlowCommand.DraftRestore });
    });
    bus.register(FlowCommand.DraftCreate, async args => store.createDraft(args as { id: string; name: string }));
    bus.register(FlowCommand.DraftAdopt, async args => {
        const { nodeId, name } = args as { nodeId: string; name: string };
        return store.adoptDraft(nodeId, name);
    });
    bus.register(FlowCommand.DraftLoad, async args => {
        const input = args as { id: string; expandScopes?: boolean };
        const draft = await store.loadDraft(String(input.id));
        return draft && input.expandScopes ? expandDispatchDraft(draft) : draft;
    });
    bus.register(FlowCommand.DraftSave, async args => saveDraft(
        store,
        plugins,
        args as { draft: FlowDraft; expectedDraftVersion: number },
    ));
    bus.register(FlowCommand.DraftValidate, async args => validateDraft(args as FlowDraft, plugins, store));
    bus.register(FlowCommand.RevisionCreate, async args => createRevision(
        store,
        plugins,
        args as { draftId: string; expectedDraftVersion: number },
    ));
    bus.register(FlowCommand.RevisionGet, async args => {
        const input = args as { id: string; revision?: number };
        return store.loadRevision(input.id, input.revision);
    });
    bus.register(FlowCommand.RevisionList, async args =>
        store.listRevisions(String((args as { id: string }).id)),
    );
}

async function saveDraft(
    store: FlowDefinitionStore,
    plugins: DagPluginCatalog,
    input: { draft: FlowDraft; expectedDraftVersion: number },
) {
    const draft = await store.saveDraft(input.draft, input.expectedDraftVersion);
    return { draft, version: draft.draftVersion, ...await validateDraft(draft, plugins, store) };
}

async function validateDraft(draft: FlowDraft, plugins: DagPluginCatalog, store?: FlowDefinitionStore) {
    const result = store ? await checkFlowSource(draft, { plugins, resolveComposite: (id, revision) => store.loadRevision(id, revision) })
        : checkFlowSyntax(draft, {plugins});
    return {valid: result.valid, validationIssues: result.diagnostics};
}

async function createRevision(
    store: FlowDefinitionStore,
    plugins: DagPluginCatalog,
    input: { draftId: string; expectedDraftVersion: number },
) {
    const draft = await store.loadDraft(input.draftId);
    if (!draft) throw new Error(`Flow draft not found: ${input.draftId}`);
    if (draft.draftVersion !== input.expectedDraftVersion) {
        throw new Error(`Flow draft ${input.draftId} version conflict`);
    }
    const validation = await validateDraft(draft, plugins, store);
    if (!validation.valid) {
        throw new Error(validation.validationIssues.map(issue => issue.message).join('; '));
    }
    const revision = await store.createRevision(draft);
    return { revision, version: revision.revision, ...validation };
}

function jsonValue(value: unknown): import('@itookit/durable-kernel').JsonValue {
    return JSON.parse(JSON.stringify(value ?? null));
}

/** Display caches never expand the set of Tasks eligible for control. */
async function currentControlTaskIds(session: SessionHandle, handle: FlowExecutionHandle): Promise<string[]> {
    const root = (await (await session.attachTask(handle.root.id)).status()).task;
    return [...new Set([root.id, ...(await readFlowRunMembers(session, root)).map(member => member.taskId)])];
}
