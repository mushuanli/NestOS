import { hasLocalScheduler, withFlowControl } from './control-session';
import { workspaceFinalizationKey, type WorkspaceFinalization } from './workspace-finalization';
import type { DagPluginCatalog, DagPluginPresentation, FlowDraft, FlowNodeDefinition, FlowRevision, FlowCommandRegistrar, JsonValue, FlowRunGoal } from '../contracts';
import type { ToolDefinition } from '@itookit/llm-context';
import type { Kernel, SessionHandle, TaskRecord, TaskSnapshot } from '@itookit/durable-kernel';
import { createFlowRevision, type FlowDefinitionStore } from '../flow-definition-store';
import { submitRun } from '../run-submission';
import { expandDispatchDraft } from './structured/expand';
import { flowToDag, type FlowNodeBinder } from './to-dag';
import { hasValidationErrors, validateFlowRevision } from './validation';
import { validateFlowParameters } from './parameters';
import { FlowCommand } from './command-names';
import { retryFlowTask } from './retry-task';
import { requestFlowGraphRetry } from './graph-retry';
import { readFlowRunMembers } from './run-members';
import { restoreFlowHandle } from './restore-handle';
import { readFlowTaskTranscript, type FlowTranscriptQuery } from './transcript';
import { DurableFlowExecutor, type FlowExecutionHandle } from './executor';

export interface DagCommandServiceOptions {
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

export interface FlowRunSummary { taskId: string; sessionId: string; name: string; status: string; createdAt: number; }

export interface DurableFlowSnapshot {
    variables?: import('./variables').VariableCheckpoint;
    workspaceFinalization?: WorkspaceFinalization;
    attachedFromStorage?: boolean;
    root: TaskSnapshot;
    nodes: Array<{ nodeId: string; snapshot: TaskSnapshot }>;
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
            const input = args as { connectionId?: string; fallbackConnectionId?: string | null; sessionId: string; flow: FlowRevision; parameters?: Record<string, JsonValue>; goal?: FlowRunGoal; invocation?: import('../contracts').DagRunSpec['invocation'] };
            return this.start(input.sessionId, input.flow, input.parameters, input.goal, input.invocation, input.connectionId, input.fallbackConnectionId);
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
            const result = await withFlowControl(this.options.kernel, input.sessionId, input.taskId, this.options.canWriteSession, async session => {
                if (input.downstream) {
                    // Graph retry: the retry plus a durable intent to recompute its downstream
                    // closure, applied by the next scheduling turn.
                    const request = await requestFlowGraphRetry(session, input.taskId, input.targetTaskId, input.requestId);
                    await this.snapshot(input.taskId, input.sessionId);
                    return { taskId: input.taskId, targetTaskId: request.retryTaskId, retryOfTaskId: input.targetTaskId,
                        downstream: request.downstream };
                }
                const task = await retryFlowTask(session, input.taskId, input.targetTaskId, input.requestId);
                await this.snapshot(input.taskId, input.sessionId);
                return { taskId: input.taskId, targetTaskId: task.id, retryOfTaskId: input.targetTaskId };
            });
            if (input.downstream) await this.resumeRun(input.sessionId, input.taskId);
            return result;
        });
        bus.register(FlowCommand.RunTaskCancel, async args => {
            const input = args as { taskId: string; targetTaskId: string; reason?: string };
            await this.snapshot(String(input.taskId));
            const handle = this.requireHandle(String(input.taskId));
            if (!handle.taskIds.has(input.targetTaskId)) throw new Error(`Task is outside this run: ${input.targetTaskId}`);
            return withFlowControl(this.options.kernel, handle.sessionId, input.taskId, this.options.canWriteSession, async session => {
                await (await session.attachTask(input.targetTaskId)).cancel(input.reason ?? 'Cancelled from DAG run console');
                return { taskId: input.taskId, targetTaskId: input.targetTaskId, cancelled: true };
            });
        });
        bus.register(FlowCommand.RunGoalUpdate, async args => {
            const input = args as { taskId: string; goal: Partial<FlowRunGoal> };
            const handle = this.requireHandle(String(input.taskId));
            return withFlowControl(this.options.kernel, handle.sessionId, input.taskId, this.options.canWriteSession, async session => {
                const key = `flow.run.${input.taskId}.goal`;
                const saved = await session.getShared(key);
                const goal = { ...((saved?.value as unknown as FlowRunGoal) ?? handle.goal ?? { objective: '' }), ...input.goal };
                await session.setShared(key, jsonValue(goal), { expectedVersion: saved?.version ?? null });
                handle.goal = goal;
                if (handle.goal.status === 'paused' || handle.goal.status === 'active') {
                    await controlRunTasks(session, handle, handle.goal.status, `goal:${input.taskId}:${(saved?.version ?? 0) + 1}`);
                }
                return { taskId: input.taskId, goal: handle.goal };
            });
        });
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
                runs.push({ taskId: task.id, sessionId: session.id, name, status: task.status, createdAt: task.createdAt });
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
    ) {
        if (!sessionId) throw new Error('DAG run requires sessionId');
        if (this.options.canWriteSession && !await this.options.canWriteSession(sessionId)) throw new Error('Session is read-only on this host');
        const issues = [
            ...validateFlowRevision(flow, this.options.plugins),
            ...validateFlowParameters(flow.parameters, parameters),
        ];
        if (hasValidationErrors(issues)) throw new Error(issues.map(issue => issue.message).join('; '));
        const resolved = fallbackConnectionId !== undefined ? fallbackConnectionId ?? undefined
            : await this.options.resolveConnection?.(sessionId, connectionId);
        const compiled = await flowToDag(flow, this.options.bindNode ? (node, defaults) => this.options.bindNode!(sessionId, node, defaults) : undefined, resolved, (id, revision) =>
            this.options.flowStore.loadRevision(id, revision), [], flow.dependencyLocks, false, connectionId);
        const sessionContext = await this.options.resolveSessionContext?.(sessionId, '');
        if (this.options.canWriteSession && !await this.options.canWriteSession(sessionId)) throw new Error('Session is read-only on this host');
        const executor = new DurableFlowExecutor({ ...this.options, sessionContext,
            resolveSkillContexts: this.options.resolveSkillContexts,
            bindPatchNode: this.options.bindNode ? async (id, node, defaults) =>
                this.options.bindNode!(id, node as FlowNodeDefinition, defaults as FlowNodeDefinition['config']) : undefined,
        });
        const { flow: handle } = await submitRun({ kind: 'graph', sessionId,
            graph: { ...compiled, ...(goal ? { goal } : {}), ...(invocation ? { invocation } : {}) }, parameters,
        }, { kernel: this.options.kernel, flowExecutor: executor });
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
        for (const entry of await readFlowRunMembers(session, (await handle.root.status()).task)) {
            handle.taskIds.add(entry.taskId);
            if (entry.detached) handle.detachedNodes.add(entry.nodeId);
            if (entry.iteration <= (handle.iterations.get(entry.nodeId) ?? 0)) continue;
            handle.iterations.set(entry.nodeId, entry.iteration);
            handle.nodes.set(entry.nodeId, await session.attachTask(entry.taskId));
        }
        const metadata = (await session.getShared(`flow.run.${taskId}.metadata`))?.value as unknown as
            { version: number; usage: FlowExecutionHandle['usage'] } | undefined;
        if (metadata?.version === 1) handle.usage = metadata.usage;
        const savedGoal = await session.getShared(`flow.run.${taskId}.goal`);
        if (savedGoal) handle.goal = savedGoal.value as unknown as FlowRunGoal;
        const savedWorkspace = await session.getShared(workspaceFinalizationKey(taskId));
        const scheduler = (await session.getShared(`flow.run.${taskId}.scheduler`))?.value as unknown as import('./scheduler-checkpoint').SchedulerCheckpoint | undefined;
        return {
            variables: scheduler?.variables,
            workspaceFinalization: handle.workspaceFinalization ?? savedWorkspace?.value as unknown as WorkspaceFinalization | undefined,
            attachedFromStorage: handle.attachedFromStorage,
            root: await handle.root.status(),
            nodes: await Promise.all([...handle.nodes].map(async ([nodeId, task]) => ({
                nodeId, snapshot: await task.status(),
            }))),
            iterations: Object.fromEntries(handle.iterations),
            taskTree: await Promise.all([...handle.taskIds].map(async id => (await (await session.attachTask(id)).status()).task)),
            detachedNodes: [...handle.detachedNodes],
            goal: handle.goal,
            usage: handle.usage,
        };
    }

    private async signal(input: {
        taskId: string;
        nodeId?: string;
        targetTaskId?: string;
        signal: { type: string; payload?: unknown };
    }) {
        await this.snapshot(String(input.taskId));
        const handle = this.requireHandle(String(input.taskId));
        if (input.targetTaskId && !handle.taskIds.has(input.targetTaskId)) throw new Error(`Task is outside this run: ${input.targetTaskId}`);
        return withFlowControl(this.options.kernel, handle.sessionId, input.taskId, this.options.canWriteSession, async session => {
            const id = input.targetTaskId ?? (input.nodeId ? handle.nodes.get(input.nodeId)?.id : undefined);
            const target = id ? await session.attachTask(id) : undefined;
            if (!target) throw new Error('A valid nodeId or targetTaskId is required');
            await target.signal(input.signal);
            return { taskId: input.taskId, targetTaskId: target.id, signalled: true };
        });
    }

    private async respond(taskId: string, requestId: string, value: unknown, targetTaskId?: string) {
        await this.snapshot(taskId);
        const handle = this.requireHandle(taskId);
        if (targetTaskId && !handle.taskIds.has(targetTaskId)) throw new Error(`Task is outside this run: ${targetTaskId}`);
        return withFlowControl(this.options.kernel, handle.sessionId, taskId, this.options.canWriteSession, async session => {
            const matches = [];
            for (const id of targetTaskId ? [targetTaskId] : handle.taskIds) {
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
            const results = await Promise.allSettled([...handle.taskIds].map(async id => (await session.attachTask(id)).cancel()));
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
    bus.register(FlowCommand.DraftList, async () => store.listDrafts());
    for (const command of [FlowCommand.DraftInstall, FlowCommand.DraftRestore]) bus.register(command, async args => {
        const draft = args as FlowDraft;
        const validation = validateDraft(draft, plugins);
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
    bus.register(FlowCommand.DraftValidate, async args => validateDraft(args as FlowDraft, plugins));
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
    return { draft, version: draft.draftVersion, ...validateDraft(draft, plugins) };
}

function validateDraft(draft: FlowDraft, plugins: DagPluginCatalog) {
    const revision = createFlowRevision(draft, draft.baseRevision ?? 0, draft.updatedAt);
    const validationIssues = validateFlowRevision(revision, plugins);
    return { valid: !hasValidationErrors(validationIssues), validationIssues };
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
    const validation = validateDraft(draft, plugins);
    if (!validation.valid) {
        throw new Error(validation.validationIssues.map(issue => issue.message).join('; '));
    }
    const revision = await store.createRevision(draft);
    return { revision, version: revision.revision, ...validation };
}

function jsonValue(value: unknown): import('@itookit/durable-kernel').JsonValue {
    return JSON.parse(JSON.stringify(value ?? null));
}

/** Pause the root first to stop dispatch; resume it only after its members are ready. */
async function controlRunTasks(session: SessionHandle, handle: FlowExecutionHandle, status: 'paused' | 'active', requestId: string): Promise<void> {
    const ids = [handle.root.id, ...[...handle.taskIds].filter(id => id !== handle.root.id)];
    for (const id of status === 'paused' ? ids : ids.reverse()) {
        const task = await session.attachTask(id);
        if (await task.poll()) continue;
        if (status === 'paused') await task.pause({ requestId });
        else await task.resume({ requestId });
    }
}
