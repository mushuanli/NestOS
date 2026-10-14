import { type Signal } from '../contracts';
import { type ToolDefinition } from '@itookit/llm-context';
import type { Kernel } from '@itookit/durable-kernel';
import { ulid } from '../persistence/ulid';
import type {
    ChatAttachment,
    ExecutionNode,
    ExecutionOverrides,
    ExecutionTask,
    ExecutorConfig,
    SessionGroup,
    SessionRuntime,
    SessionStatus,
    TaskInput,
} from '../core/types';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import type { ISessionRepository } from '../persistence/types';
import { FlowDefinitionStore, type FlowStore } from '@itookit/llm-flow';
import { RoundLog } from '../persistence/round-log';
import { flowToDag, hasValidationErrors, validateFlowParameters } from '@itookit/llm-flow';
import { formatErrorMessage } from '../utils/error-formatter';
import { createSessionHost, type SessionHost } from '../utils/host-ports';
import { AgentResolver } from './agent-resolver';
import { AttachmentProcessor } from './attachment-processor';
import { ConversationRunCoordinator } from './conversation-run-coordinator';
import { SessionEventBus } from './session-event-bus';
import { SessionState } from './session-state';
import { bindFlowNode } from './flow-node-binder';
import { snapshotTaskInput, directExecutionMode } from './direct-execution-mode';
import { resolveSessionExecutionMode } from './session-execution-mode';

export interface SessionRunCallbacks {
    /** Commit persisted rounds to the projection before exposing a terminal status. */
    refreshSession?(sessionId: string): Promise<void>;
    onStatusChange(sessionId: string, status: SessionStatus): void;
    onUnread(sessionId: string): void;
    getBoundSessionId?(): string | null;
    getSessionContext(sessionId: string): {
        state: SessionState;
        runtime: SessionRuntime;
    } | null;
}

interface ExecutionSetup {
    config: ExecutorConfig;
    rootNode: ExecutionNode;
    roundId: string;
    contextFiles: ChatAttachment[];
}

export class SessionRunCoordinator {
    private readonly active = new Map<string, ExecutionTask>();
    private readonly logs = new Map<string, RoundLog>();
    private readonly runs: ConversationRunCoordinator;

    constructor(
        private readonly engine: ISessionRepository,
        private readonly eventBus: SessionEventBus,
        private readonly agents: AgentResolver,
        private readonly attachments: AttachmentProcessor,
        private readonly callbacks: SessionRunCallbacks,
        private readonly kernel: Kernel,
        dagPlugins: import('@itookit/llm-flow/contracts').DagPluginCatalog,
        private readonly flowStore: FlowStore,
        resolveTools?: (sessionId: string, allowedIds: string[]) => Promise<{
            definitions: ToolDefinition[];
            externalIds: string[];
        }>,
        retrieveMemory?: import('./conversation-run-coordinator').ConversationRunCoordinatorOptions['retrieveMemory'],
        resolveSessionContext?: (sessionId: string, userMessage: string) => Promise<{ projectInstructions: string; skillInstructions: string; skillIndex: string }>,
        workspaceManager?: import('./conversation-run-coordinator').ConversationRunCoordinatorOptions['workspaceManager'],
        resolveHarnessToolIds?: (sessionId: string) => Promise<string[]>,
        private readonly host: SessionHost = createSessionHost(),
        directAgentPolicy?: import('../contracts/direct-agent-policy').DirectAgentPolicy,
    ) {
        this.runs = new ConversationRunCoordinator({
            hostPorts: host,
            directAgentPolicy,
            engine,
            eventBus,
            kernel,
            dagPlugins,
            resolveTools,
            resolveHarnessToolIds,
            resolveMCPToolIds: (sessionId, ids) => this.agents.getMCPToolIds(ids, sessionId),
            resolveSkills: (ids, sessionId) => this.agents.getSkills(ids, sessionId),
            retrieveMemory,
            resolveSessionContext,
            workspaceManager,
            loadArtifact: async () => null,
        });
    }

    async assertCanSubmit(sessionId: string, reopen = false): Promise<void> {
        const status = await this.kernel.sessionStat(sessionId);
        if (reopen && status.phase === 'closed' && !status.archived) {
            await this.kernel.reopenSession(sessionId);
            return;
        }
        if (status.phase === 'closed' || status.phase === 'closing') {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID,
                this.host.translate(status.phase === 'closed' ? 'flow.rerun.sessionClosed' : 'flow.rerun.sessionClosing'));
        }
    }

    async submit(input: TaskInput, runtime: SessionRuntime): Promise<string> {
        input = snapshotTaskInput(input);
        await this.assertCanSubmit(input.sessionId);
        if (this.active.has(input.sessionId)) {
            throw new ConversationError(ConversationErrorCode.SESSION_BUSY, 'Session already has an active run');
        }
        const task = await this.createTask(input);
        this.active.set(input.sessionId, task);
        runtime.currentTaskId = task.id;
        this.callbacks.onStatusChange(input.sessionId, 'queued');
        void this.execute(task, runtime);
        return task.id;
    }

    respondToSignal(sessionId: string, signal: Signal): void {
        if (this.runs.signal(sessionId, signal)) return;
        this.host.logger.warn('No waiting run for signal', { sessionId, signalType: signal.type });
    }

    abort(sessionId: string): void {
        const task = this.active.get(sessionId);
        if (!task) return;
        task.abortController.abort();
        this.runs.cancel(sessionId);
    }

    abortAll(): void {
        for (const task of this.active.values()) task.abortController.abort();
        this.runs.cancelAll();
        this.active.clear();
    }

    private async execute(task: ExecutionTask, runtime: SessionRuntime): Promise<void> {
        const context = this.callbacks.getSessionContext(task.sessionId);
        if (!context) return this.finishMissingContext(task, runtime);
        this.callbacks.onStatusChange(task.sessionId, 'running');
        let roundLog: RoundLog | undefined;
        try {
            roundLog = await this.getLog(task);
            const setup = await this.setup(task, context.state);
            try { await this.executeRequest(task, context.state, roundLog, setup); }
            finally { await this.callbacks.refreshSession?.(task.sessionId); }
            this.callbacks.onStatusChange(task.sessionId, 'completed');
            this.callbacks.onUnread(task.sessionId);
        } catch (error) {
            this.handleError(error, task, runtime, context.state);
        } finally {
            this.active.delete(task.sessionId);
            runtime.currentTaskId = undefined;
        }
    }

    private async executeRequest(
        task: ExecutionTask,
        state: SessionState,
        roundLog: RoundLog,
        setup: ExecutionSetup,
    ): Promise<void> {
        const execution = {
            task,
            state,
            config: setup.config,
            log: roundLog,
            rootNodeId: setup.rootNode.id,
            roundId: setup.roundId,
            contextFiles: setup.contextFiles,
            finalize: async () => {},
        };
        const flow = task.input.sendIntent?.execution;
        if (flow?.kind !== 'flow') return this.runs.executeDirect(execution);
        const definitions = new FlowDefinitionStore(this.flowStore);
        const revision = await definitions.loadRevision(flow.flowId, flow.revision);
        if (!revision) throw new Error(`Flow revision not found: ${flow.flowId}`);
        flow.revision = revision.revision;
        const parameterIssues = validateFlowParameters(revision.parameters, flow.parameters);
        if (hasValidationErrors(parameterIssues)) {
            throw new Error(parameterIssues.map(issue => issue.message).join('; '));
        }
        return this.runs.executeDag(execution, flow.parameters, async snapshot =>
            flowToDag(
                revision,
                (node, defaults) => bindFlowNode(node, defaults, snapshot, task, setup, this.agents),
                setup.config.connectionId,
                (id, childRevision) => definitions.loadRevision(id, childRevision),
                [], revision.dependencyLocks, false, task.input.overrides?.connectionId,
            ),
            (node, snapshot, defaults) => bindFlowNode(node as Parameters<typeof bindFlowNode>[0], defaults as Parameters<typeof bindFlowNode>[1], snapshot, task, setup, this.agents),
        );
    }

    private async createTask(input: TaskInput): Promise<ExecutionTask> {
        input = await resolveSessionExecutionMode(this.engine, input, this.host.translate);
        const roundLog = this.logs.get(input.sessionId)
            ?? new RoundLog(this.engine, input.sessionId);
        this.logs.set(input.sessionId, roundLog);
        const manifest = await roundLog.loadManifest();
        const agent = await this.resolveConfig(input);
        if (!agent.agentVersion) {
            throw new Error(
                `Agent version is required: ${agent.id} — requested agentId='${input.agentId}' `
                + 'resolved to the fallback config (unknown/empty agent id, or resolution failed). '
                + 'See the [AgentResolver] warning in the console.',
            );
        }
        const mode = input.overrides?.flowId ? undefined : directExecutionMode(input);
        if (mode) await this.engine.saveSessionSettings(input.sessionId, { executionMode: mode, executionModeLocked: true });
        const branchRef = manifest.currentBranch || 'main';
        return {
            id: `run-request-${ulid()}`,
            sessionId: input.sessionId,
            input,
            priority: 0,
            createdAt: Date.now(),
            abortController: new AbortController(),
            frozen: {
                branchRef,
                branchHead: manifest.branches[branchRef] ?? null,
                contextProfile: manifest.branchMeta[branchRef]?.contextProfile,
                agentVersion: agent.agentVersion,
                config: structuredClone(agent),
            },
        };
    }

    private async setup(
        task: ExecutionTask,
        state: SessionState,
    ): Promise<ExecutionSetup> {
        const files = await this.attachments.resolveAttachments(
            task.sessionId,
            task.input.text,
            task.input.files,
        );
        const roundId = resolveRoundId(task.input);
        const userNodeId = task.input.skipUserMessage
            ? task.input.parentUserNodeId
            : this.createUserMessage(task, state, files, roundId);
        const config = task.frozen?.config ?? await this.resolveConfig(task.input);
        const rootNode = this.createAssistantNode(task, state, config, roundId, userNodeId);
        return { config, rootNode, roundId, contextFiles: files };
    }

    private createUserMessage(
        task: ExecutionTask,
        state: SessionState,
        files: ChatAttachment[],
        roundId: string,
    ): string {
        const parentId = assistantParent(state);
        const group = state.addPendingUserMessage(
            task.input.text,
            files,
            roundId,
            task.input.origin,
            task.input.historyPolicy,
        );
        if (this.callbacks.getBoundSessionId?.() === task.sessionId) {
            this.eventBus.emitSession(task.sessionId, {
                type: 'message:appended',
                payload: { sessionGroup: group, parentId },
            });
        }
        return group.id;
    }

    private createAssistantNode(
        task: ExecutionTask,
        state: SessionState,
        config: ExecutorConfig,
        roundId: string,
        parentId?: string,
    ): ExecutionNode {
        const root = executionNode(roundId, config);
        const group = assistantGroup(task, root, roundId);
        state.addPendingAssistantMessage(group);
        if (this.callbacks.getBoundSessionId?.() === task.sessionId) {
            this.eventBus.emitSession(task.sessionId, {
                type: 'message:appended',
                payload: {
                    sessionGroup: group,
                    isExecutionRoot: true,
                    parentId,
                },
            });
        }
        return root;
    }

    private async resolveConfig(input: TaskInput): Promise<ExecutorConfig> {
        const settings = await this.engine.getSessionSettings(input.sessionId);
        const identity = await this.agents.resolve(input.agentId);
        const config = await this.agents.reResolveModel(identity, {
            connectionId: input.overrides && 'connectionId' in input.overrides ? input.overrides.connectionId : settings.connectionId,
            modelTier: input.overrides?.modelTier,
            allowUnconfigured: input.sendIntent?.execution.kind === 'flow',
        });
        return input.overrides ? applyOverrides(config, input.overrides) : config;
    }

    private async getLog(task: ExecutionTask): Promise<RoundLog> {
        const cached = this.logs.get(task.sessionId);
        if (cached) return cached;
        const created = new RoundLog(this.engine, task.sessionId);
        this.logs.set(task.sessionId, created);
        return created;
    }

    private handleError(
        error: unknown,
        task: ExecutionTask,
        runtime: SessionRuntime,
        state: SessionState,
    ): void {
        const aborted = task.abortController.signal.aborted
            || (error instanceof Error && error.name === 'AbortError');
        const status = aborted ? 'aborted' as const : 'failed' as const;
        runtime.error = error instanceof Error ? error : new Error(String(error));
        this.callbacks.onStatusChange(task.sessionId, status);
        const message = formatErrorMessage(error);
        projectError(this.eventBus, task.sessionId, state, status, message);
    }

    private finishMissingContext(task: ExecutionTask, runtime: SessionRuntime): void {
        this.active.delete(task.sessionId);
        runtime.currentTaskId = undefined;
        this.callbacks.onStatusChange(task.sessionId, 'failed');
        this.host.logger.error('Session context not found', { sessionId: task.sessionId });
    }
}

function executionNode(id: string, config: ExecutorConfig): ExecutionNode {
    return {
        id: `round-${id}-assistant`,
        name: config.name || config.id,
        executorType: config.type || 'agent',
        executorId: config.id,
        status: 'running',
        startTime: Date.now(),
        data: {
            output: '',
            thought: '',
            metaInfo: { agentId: config.id, agentIcon: config.icon },
        },
        children: [],
    };
}

function assistantGroup(
    task: ExecutionTask,
    root: ExecutionNode,
    roundId: string,
): SessionGroup {
    return {
        id: root.id,
        persistedNodeId: roundId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        executionRoot: root,
        siblingIndex: task.input.branchInfo?.siblingIndex,
        siblingCount: task.input.branchInfo?.siblingCount,
        origin: task.input.origin ?? 'user',
        historyPolicy: task.input.historyPolicy ?? 'include',
    };
}

function assistantParent(state: SessionState): string | undefined {
    const previous = state.getLastSession();
    return previous?.role === 'assistant' ? previous.id : undefined;
}

function resolveRoundId(input: TaskInput): string {
    return input.roundTarget?.mode === 'update-existing'
        ? input.roundTarget.targetRoundId
        : input.roundTarget?.roundId ?? input.sendIntent?.submission?.id ?? ulid();
}

function applyOverrides(
    config: ExecutorConfig,
    overrides: ExecutionOverrides,
): ExecutorConfig {
    const updated = { ...config };
    if (overrides.connectionId) updated.connectionId = overrides.connectionId;
    if (overrides.temperature !== undefined) updated.temperature = overrides.temperature;
    if (overrides.streamMode !== undefined) updated.stream = overrides.streamMode;
    if (overrides.reasoningEffort) updated.reasoningEffort = overrides.reasoningEffort;
    if (overrides.thinkingEnabled !== undefined) updated.enableThinking = overrides.thinkingEnabled;
    // 联网搜索总开关：false → 'disabled'（同时关闭内置 search 与客户端 WebSearchTool）；
    // true 保持 resolver 自动分流（'builtin' 优先，否则 'client-tool'），无需覆盖。
    if (overrides.webSearchEnabled === false) {
        updated.webSearchMode = 'disabled';
    }
    if (overrides.systemPromptAppend) {
        updated.systemPrompt = [...(updated.systemPrompt ?? []), overrides.systemPromptAppend];
    }
    return updated;
}

function projectError(
    eventBus: SessionEventBus,
    sessionId: string,
    state: SessionState,
    status: 'aborted' | 'failed',
    message: string,
): void {
    const root = state.getLastSession()?.executionRoot;
    if (root) {
        state.updateNodeStatus(root.id, status);
        state.updateNodeError(root.id, message);
        eventBus.emitSession(sessionId, {
            type: 'message:status',
            payload: { messageId: root.id, status, result: message },
        });
    }
    eventBus.emitSession(sessionId, {
        type: 'error',
        error: { message, ...(status === 'aborted' ? { code: 'ABORTED' } : {}) },
    });
}
