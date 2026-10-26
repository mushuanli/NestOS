import {applyHarnessOverrides, applyOverrides, assertContextSelection} from './execution-overrides';
import {independentPreparationInstruction, independentPreparationError} from './independent-call-preparation';
import { prepareFlowConnections } from './flow-connections';
import {callInputProjection} from './call-input-projection';
import { type Signal } from '../contracts';
import { type ToolDefinition, type ContextSnapshot } from '@itookit/llm-context';
import type { Kernel } from '@itookit/durable-kernel';
import { ulid } from '../persistence/ulid';
import type {
    ChatAttachment,
    ExecutionNode,
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
import {freezeQueuedAgent, readQueuedAgent} from './queued-agent';
import {boundFlowIdentity, flowTargetIdentity} from './flow-target';
import {reviseQueuedInput} from './revise-queued-input';
import {assertSelectedTarget, assertRootCallable, sameTargetRef, flowTargetRevision, type FlowRevision} from '@itookit/llm-flow/contracts';
import { AttachmentProcessor } from './attachment-processor';
import { ConversationRunCoordinator, type ConversationExecution } from './conversation-run-coordinator';
import { SessionEventBus } from './session-event-bus';
import { SessionState } from './session-state';
import { bindFlowNode, type FlowIdentityResolver } from './flow-node-binder';
import { snapshotTaskInput, directExecutionMode } from './direct-execution-mode';
import { resolveSessionExecutionMode } from './session-execution-mode';
import type { SessionExecutionActivity } from './session-execution-activity';
import { prepareFlowAgentInput, frozenFlowResolver } from './flow-agent';
import { captureFlowConnections, frozenFlowConnections } from './flow-connection-snapshot';
import { frozenFlowIdentities } from './flow-identity-snapshot';
import { bindPlannedFlowGraph, validatePlannedFlowConnections } from './flow-run-plan';
import { isHarnessAgentSnapshot } from './harness-binding';
import {conversationFlowInvocation, newRerunInvocation} from './invocation-identity';
import {assertConversationSelection} from '@itookit/kernel-adapters/contracts';

export interface SessionRunCallbacks {
    validateCallAssets?: import('../contracts/submission').CallAssetValidator;
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
type PreparedExecutionTask = Pick<ExecutionTask, 'id' | 'sessionId' | 'input' | 'createdAt' | 'frozen'>;

export class SessionRunCoordinator {
    private readonly active = new Map<string, ExecutionTask>();
    private readonly admitting = new Set<string>();
    private readonly logs = new Map<string, RoundLog>();
    private readonly runs: ConversationRunCoordinator;

    constructor(
        private readonly engine: ISessionRepository,
        private readonly eventBus: SessionEventBus,
        private readonly agents: AgentResolver,
        private readonly attachments: AttachmentProcessor,
        private readonly callbacks: SessionRunCallbacks,
        private readonly kernel: Kernel,
        private readonly dagPlugins: import('@itookit/llm-flow/contracts').DagPluginCatalog,
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
        private readonly activity?: SessionExecutionActivity,
        loadArtifact?: import('../contracts/artifacts').ArtifactLoader,
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
            loadArtifact: async (sessionId, id) => {
                if (!loadArtifact) throw Object.assign(new Error('Artifact reader is unavailable'), {code: 'ARTIFACT_READER_UNAVAILABLE'});
                return loadArtifact(sessionId, id);
            },
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

    async bindQueuedInstruction(sessionId: string, item: import('../contracts/instruction-queue').SessionInstruction) {
        const identity = await this.resolveSelectedIdentity(item);
        return this.bindSelectedInstruction(sessionId, item, identity);
    }

    private async bindSelectedInstruction(sessionId: string, item: import('../contracts/instruction-queue').SessionInstruction, identity: ExecutorConfig) {
        assertContextSelection(item, identity);
        const selected = pinQueuedTarget(item, identity);
        const connectionBinding = await this.freezeConnectionBinding({ ...selected, sessionId, instructionId: item.id }, identity);
        const bound = await this.prepareFlowInput({ ...selected, sessionId, instructionConnectionBinding: connectionBinding }, identity);
        return { ...selected, sendIntent: bound.sendIntent, flowBinding: bound.instructionFlowBinding, connectionBinding };
    }

    /** Resolve the actual published target and child context without a view, queue or running Task. */
    async prepareIndependentTaskCall(supplied: import('../contracts/submission').SubmissionRequest,
        suppliedInvocation: import('@itookit/llm-flow/contracts').InvocationIdentity) {
        const request = structuredClone(supplied), invocation = structuredClone(suppliedInvocation);
        const item = independentPreparationInstruction(request, invocation), sessionId = request.expectedSessionId!;
        const manifest = await this.engine.getManifest(sessionId);
        if (manifest.parentSessionId !== request.submission!.source.ownerId || manifest.currentBranch !== item.branch
            || manifest.branches[item.branch] !== null) throw independentPreparationError('CALL_PREPARATION_SCOPE_MISMATCH');
        await this.assertCanSubmit(sessionId);
        const identity = await this.resolveSelectedIdentity(item);
        if (identity.target?.kind === 'agent' && !await this.agents.publishedTarget(identity.target)) throw independentPreparationError('CALL_PUBLISHED_TARGET_REQUIRED');
        const bound = await this.bindSelectedInstruction(sessionId, item, identity);
        const task = await this.prepareTask({...bound, sessionId, invocation, instructionId: bound.id, instructionBranch: bound.branch,
            instructionConnectionBinding: bound.connectionBinding, instructionFlowBinding: bound.flowBinding});
        const contextFiles = await this.attachments.resolveAttachments(sessionId, task.input.text, task.input.files);
        if (task.input.sendIntent?.execution.kind === 'flow') return this.prepareIndependentFlow(task, contextFiles, bound.id);
        return this.runs.prepareDirect({task, config: task.frozen!.config!, roundId: bound.id,
            log: new RoundLog(this.engine, sessionId), contextFiles});
    }

    private async prepareIndependentFlow(prepared: PreparedExecutionTask, contextFiles: ChatAttachment[], roundId: string) {
        const task: ExecutionTask = {...prepared, priority: 0, abortController: new AbortController()}, config = task.frozen!.config!;
        const flow = task.input.sendIntent!.execution as Extract<NonNullable<TaskInput['sendIntent']>['execution'], {kind: 'flow'}>;
        const revision = task.input.instructionFlowBinding?.definition
            ?? await new FlowDefinitionStore(this.flowStore).loadRevision(flow.flowId, flow.revision);
        if (!revision) throw Object.assign(new Error('Published Flow revision is unavailable'), {code: 'CALL_TARGET_UNAVAILABLE'});
        const plan = task.input.instructionFlowBinding?.plan, identities = plan ? frozenFlowIdentities(plan.identities) : this.agents;
        return this.runs.prepareDag({task, config, roundId, log: new RoundLog(this.engine, task.sessionId), contextFiles}, flow.parameters,
            snapshot => this.flowSpecification(task, {config, roundId}, revision, snapshot, identities));
    }

    reviseQueuedInstruction(sessionId: string, item: import('../contracts/instruction-queue').SessionInstruction) {
        return reviseQueuedInput(sessionId, item, this.agents, this.dagPlugins, this.host, this.callbacks.validateCallAssets);
    }

    publishedAgentTarget(target?: import('@itookit/llm-flow/contracts').TargetRef) {return this.agents.publishedTarget(target);}

    private async resolveSelectedIdentity(input: Pick<TaskInput, 'agentId' | 'target' | 'expectedTarget' | 'source' | 'sendIntent'>): Promise<ExecutorConfig> {
        const target = input.target;
        let identity: ExecutorConfig;
        if (target?.kind === 'flow') {
            const flow = await new FlowDefinitionStore(this.flowStore).loadRevision(target.id, flowTargetRevision(target));
            if (!flow) throw Object.assign(new Error('Published Flow target is unavailable'), {code: 'CALL_TARGET_UNAVAILABLE'});
            assertRootCallable(flow); identity = flowTargetIdentity(flow);
        } else identity = target?.kind === 'agent' && target.version
            ? await this.agents.resolveExact(input.agentId, target.version) : await this.agents.resolve(input.agentId);
        assertRootCallable(identity);
        await this.assertPublishedImplementation(input, identity);
        if (target && identity.target) assertSelectedTarget(target, identity.target);
        if (input.expectedTarget && !sameTargetRef(input.expectedTarget, identity.target))
            throw Object.assign(new Error('Call target changed before admission'), {code: 'CALL_TARGET_CHANGED'});
        if (input.source && identity.execution?.kind !== 'flow'
            && (input.source.kind !== 'composer' || Object.keys(input.source.values ?? {}).length))
            throw Object.assign(new Error('This Agent does not accept structured arguments'), {code: 'CALL_INPUT_UNBOUND'});
        return identity;
    }
    private async assertPublishedImplementation(input: Pick<TaskInput, 'sendIntent'>, identity: ExecutorConfig): Promise<void> {
        const execution = input.sendIntent?.execution;
        if (execution?.kind !== 'flow') return;
        const publication = await this.agents.publishedTarget(identity.target);
        if (publication && (!publication.flow || publication.flow.id !== execution.flowId || publication.flow.revision !== execution.revision))
            throw Object.assign(new Error('Select the published Agent implementation or invoke the Flow directly'), {code: 'AGENT_IMPLEMENTATION_OVERRIDE'});
    }

    async validateSubmission(input: TaskInput): Promise<void> {
        const config = await this.resolveConfig(input);
        assertConversationTarget(input, config);
        this.assertAgentVersion(config, input.agentId);
    }

    async rerunInvocation(sessionId: string, round?: import('../contracts/conversation').Round) {
        const started = Date.now(), operationId = ulid();
        try {
            const identity = await newRerunInvocation(this.kernel, sessionId, round);
            this.host.logger.info('Invocation rerun admitted', {operation: 'session.invocation.rerun', stage: 'source-validation',
                result: 'success', sessionId, operationId, invocationId: identity.invocationId,
                retryOfInvocationId: identity.retryOfInvocationId, elapsedMs: Date.now() - started});
            return identity;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            this.host.logger.warn('Invocation rerun rejected', {operation: 'session.invocation.rerun', stage: 'source-validation',
                result: 'failure', sessionId, operationId, elapsedMs: Date.now() - started,
                errorCode: code === 'INVOCATION_EXECUTION_CONFLICT' || code === 'INVOCATION_NOT_TERMINAL' ? code : 'INVOCATION_SOURCE_UNAVAILABLE'});
            throw error;
        }
    }

    async submit(input: TaskInput, runtime: SessionRuntime): Promise<string> {
        input = snapshotTaskInput({...input, invocation: input.invocation ?? {invocationId: ulid()}});
        if (this.isActive(input.sessionId)) {
            throw new ConversationError(ConversationErrorCode.SESSION_BUSY, 'Session already has an active run');
        }
        this.admitting.add(input.sessionId);
        const admission = new AbortController();
        this.activity?.begin(input.sessionId, () => { admission.abort(); this.runs.cancel(input.sessionId); });
        let accepted = false;
        try {
            await this.assertCanSubmit(input.sessionId);
            const task = await this.createTask(input);
            if (admission.signal.aborted) throw new ConversationError(ConversationErrorCode.ABORTED, 'Submission was cancelled during admission');
            this.active.set(input.sessionId, task);
            this.activity?.begin(input.sessionId, () => { task.abortController.abort(); this.runs.cancel(input.sessionId); });
            accepted = true;
            runtime.currentTaskId = task.id;
            this.callbacks.onStatusChange(input.sessionId, 'queued');
            void this.execute(task, runtime);
            return task.id;
        } finally {
            this.admitting.delete(input.sessionId);
            if (!accepted) this.activity?.finish(input.sessionId);
        }
    }

    isActive(sessionId: string): boolean { return this.admitting.has(sessionId) || this.active.has(sessionId) || !!this.activity?.isActive(sessionId); }

    respondToSignal(sessionId: string, signal: Signal): void {
        if (this.runs.signal(sessionId, signal)) return;
        this.host.logger.warn('No waiting run for signal', { sessionId, signalType: signal.type });
    }

    abort(sessionId: string): void {
        const task = this.active.get(sessionId);
        if (!task) { this.activity?.abort(sessionId); return; }
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
        let stage = 'history-load';
        try {
            roundLog = await this.getLog(task);
            stage = 'attachments-and-round';
            const setup = await this.setup(task, context.state);
            stage = 'run-prepare-execute';
            try { await this.executeRequest(task, context.state, roundLog, setup); }
            finally { await this.callbacks.refreshSession?.(task.sessionId); }
            this.callbacks.onStatusChange(task.sessionId, 'completed');
            this.callbacks.onUnread(task.sessionId);
        } catch (error) {
            this.handleError(error, task, runtime, context.state, stage);
        } finally {
            this.active.delete(task.sessionId);
            runtime.currentTaskId = undefined;
            this.activity?.finish(task.sessionId, runtime.status, task.input.instructionId);
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
        return this.executeFlow(execution, setup, flow);
    }

    private async executeFlow(execution: ConversationExecution, setup: ExecutionSetup,
        flow: Extract<NonNullable<TaskInput['sendIntent']>['execution'], { kind: 'flow' }>): Promise<void> {
        const { task } = execution;
        const definitions = new FlowDefinitionStore(this.flowStore);
        const revision = task.input.instructionFlowBinding?.definition ?? await definitions.loadRevision(flow.flowId, flow.revision);
        if (!revision) throw new Error(`Flow revision not found: ${flow.flowId}`);
        flow.revision = revision.revision;
        const parameterIssues = validateFlowParameters(revision.parameters, flow.parameters, revision.inputGroups);
        if (hasValidationErrors(parameterIssues)) {
            throw new Error(parameterIssues.map(issue => issue.message).join('; '));
        }
        const plan = task.input.instructionFlowBinding?.plan;
        const identities = plan ? frozenFlowIdentities(plan.identities) : this.agents;
        const dynamicIdentities = plan ? frozenFlowIdentities(plan.identities, this.agents) : identities;
        const createSpec = (snapshot: ContextSnapshot) => this.flowSpecification(task, setup, revision, snapshot, identities);
        return this.runs.executeDag(execution, flow.parameters, createSpec,
            (node, snapshot, defaults) => bindFlowNode(node as Parameters<typeof bindFlowNode>[0],
                defaults as Parameters<typeof bindFlowNode>[1], snapshot, task, setup, dynamicIdentities),
            plan ? (ids, sessionId) => dynamicIdentities.getSkills(ids, sessionId) : undefined,
        );
    }

    private async flowSpecification(task: ExecutionTask, setup: Pick<ExecutionSetup, 'config' | 'roundId'>, revision: import('@itookit/llm-flow/contracts').FlowRevision,
        snapshot: ContextSnapshot, identities: FlowIdentityResolver) {
        const binding = task.input.instructionFlowBinding;
        const catalog = binding ? frozenFlowConnections(this.agents, binding.connections) : this.agents;
        const bind = (node: Parameters<typeof bindFlowNode>[0], defaults: Parameters<typeof bindFlowNode>[1]) =>
            bindFlowNode(node, defaults, snapshot, task, setup, identities);
        if (binding?.plan) {
            const graph = await bindPlannedFlowGraph(binding.plan.graph, bind);
            const admitted = await validatePlannedFlowConnections(graph, revision, catalog, task.input.instructionConnectionBinding?.defaults);
            return { ...admitted, input: { prompt: task.input.text }, invocation: conversationFlowInvocation(task, revision) };
        }
        const definitions = new FlowDefinitionStore(this.flowStore), execution = task.input.sendIntent?.execution;
        const graph = await flowToDag(revision, bind, setup.config.connectionId,
            frozenFlowResolver(task.input, (id, version) => definitions.loadRevision(id, version)), [], revision.dependencyLocks, false,
            task.input.overrides?.connectionId, execution?.kind === 'flow' ? execution.connectionBindings : undefined,
            (definition, bindings, runConnectionId) => prepareFlowConnections(definition, bindings, catalog,
                task.input.instructionConnectionBinding?.defaults, runConnectionId), execution?.kind === 'flow' ? execution.parameters : undefined);
        return { ...graph, input: { prompt: task.input.text }, invocation: conversationFlowInvocation(task, revision) };
    }

    private async createTask(input: TaskInput): Promise<ExecutionTask> {
        const task = await this.prepareTask(input);
        const mode = task.input.overrides?.flowId ? undefined : directExecutionMode(task.input);
        if (mode) await this.engine.saveSessionSettings(input.sessionId, { executionMode: mode, executionModeLocked: true });
        return {...task, priority: 0, abortController: new AbortController()};
    }

    private async prepareTask(input: TaskInput): Promise<PreparedExecutionTask> {
        input = await this.prepareFlowInput(input);
        await this.validateFrozenFlow(input);
        input = await resolveSessionExecutionMode(this.engine, input, this.host.translate);
        const roundLog = this.logs.get(input.sessionId) ?? new RoundLog(this.engine, input.sessionId);
        const manifest = await roundLog.loadManifest();
        if (input.instructionBranch && input.instructionBranch !== manifest.currentBranch) {
            throw new ConversationError(ConversationErrorCode.SESSION_BUSY, 'Queued instruction branch changed during admission');
        }
        const agent = await this.resolveConfig(input);
        assertConversationTarget(input, agent);
        this.assertAgentVersion(agent, input.agentId);
        const branchRef = manifest.currentBranch || 'main';
        return {
            id: `run-request-${ulid()}`,
            sessionId: input.sessionId,
            input,
            createdAt: Date.now(),
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
        group.invocation = task.input.invocation;
        group.target = structuredClone(task.frozen?.config?.target);
        group.callInput = callInputProjection(task.input);
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
        const accepted = input.instructionConnectionBinding?.harnessAgent;
        if (accepted) {
            if (!isHarnessAgentSnapshot(accepted) || accepted.id !== input.agentId)
                throw new Error('Invalid admitted harness Agent identity');
            return applyHarnessOverrides({ ...admittedIdentity(input, structuredClone(accepted)), harnessConnection: await this.agents.resolveHarnessConnection(
                accepted.harnessConnection!.id, accepted.harnessConnection) }, input);
        }
        const settings = await this.engine.getSessionSettings(input.sessionId);
        const identity = admittedIdentity(input, boundFlowIdentity(input.instructionFlowBinding)
            ?? readQueuedAgent(input.instructionConnectionBinding?.agent, input.agentId) ?? await this.resolveSelectedIdentity(input));
        if (identity.execution?.kind === 'harness') return applyHarnessOverrides({ ...identity,
            harnessConnection: await this.agents.resolveHarnessConnection(identity.execution.connectionId, identity.harnessConnection) }, input);
        const connectionId = input.instructionConnectionBinding ? input.instructionConnectionBinding.connectionId
            : input.overrides && 'connectionId' in input.overrides ? input.overrides.connectionId : settings.connectionId;
        const snapshot = input.instructionConnectionBinding?.connections;
        const frozenConnection = input.sendIntent?.execution.kind !== 'flow' && snapshot && connectionId
            ? await frozenFlowConnections(this.agents, snapshot).getConnection(connectionId) : undefined;
        const config = input.sendIntent?.execution.kind === 'flow'
            ? { ...identity, connectionId: connectionId ?? (input.instructionConnectionBinding ? undefined : (await this.agents.getModelDefaults(identity)).chat) }
            : await this.agents.reResolveModel(identity, {
            connectionId,
            modelTier: input.overrides?.modelTier,
            useDefault: !input.instructionConnectionBinding,
            frozenConnection,
        });
        return input.overrides ? applyOverrides(config, input.overrides) : config;
    }

    private async prepareFlowInput(input: TaskInput, identity?: ExecutorConfig): Promise<TaskInput> {
        if (input.instructionFlowBinding) return input;
        if (input.instructionConnectionBinding?.harnessAgent && input.sendIntent?.execution.kind !== 'flow') return input;
        identity ??= readQueuedAgent(input.instructionConnectionBinding?.agent, input.agentId) ?? await this.resolveSelectedIdentity(input);
        if (identity.execution?.kind !== 'flow' && input.sendIntent?.execution.kind !== 'flow') return input;
        if (!input.instructionConnectionBinding) {
            input = { ...input, instructionConnectionBinding: await this.freezeConnectionBinding(input, identity) };
        }
        const definitions = new FlowDefinitionStore(this.flowStore);
        const frozenIdentity = identity;
        return prepareFlowAgentInput(input, { definitions, resolveAgent: async () => frozenIdentity, host: this.host,
            validateCallAssets: this.callbacks.validateCallAssets,
            connectionCatalog: this.agents, identityResolver: this.agents, plugins: this.dagPlugins,
            prepareConnections: (definition, bindings, connectionId) => prepareFlowConnections(definition, bindings, this.agents,
                input.instructionConnectionBinding?.defaults, connectionId) });
    }

    private async freezeConnectionBinding(input: TaskInput, identity: ExecutorConfig) {
        assertConversationTarget(input, identity);
        if (identity.execution?.kind === 'harness' && input.sendIntent?.execution.kind !== 'flow') {
            const harnessConnection = await this.agents.resolveHarnessConnection(identity.execution.connectionId, identity.harnessConnection);
            return {identityVersion: 1 as const, defaults: {}, harnessAgent: {...structuredClone(identity), harnessConnection}};
        }
        const started = Date.now(), operationId = input.instructionId ?? ulid();
        let stage = 'defaults';
        try {
            const defaults = await this.agents.getModelDefaults(identity), settings = await this.engine.getSessionSettings(input.sessionId);
            const explicit = input.overrides && 'connectionId' in input.overrides;
            const connectionId = (explicit ? input.overrides!.connectionId : settings.connectionId) ?? defaults.chat;
            const source = explicit && input.overrides!.connectionId ? 'run' as const : !explicit && settings.connectionId ? 'session' as const
                : identity.modelDefaults?.chat ? 'agent' as const : 'system' as const;
            stage = 'connection-metadata';
            const capture = captureFlowConnections(this.agents);
            const flow = identity.execution?.kind === 'flow' || input.sendIntent?.execution.kind === 'flow';
            if (connectionId && !flow) await capture.catalog.getConnection(connectionId);
            stage = 'agent-identity';
            const agent = !flow ? freezeQueuedAgent(identity) : undefined;
            this.host.logger.info('Model defaults admitted', { operation: 'session.model-defaults', operationId, stage: 'admission', result: 'success',
                sessionId: input.sessionId, ...(identity.type === 'flow' ? {targetKind: 'flow', targetId: identity.id} : {agentId: identity.id}), purposeCount: Object.keys(defaults).length,
                source,
                elapsedMs: Date.now() - started });
            return {identityVersion: 1 as const, connectionId, source, defaults, connections: capture.snapshot(), ...(agent ? {agent} : {})};
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            this.host.logger.warn('Model default binding failed', { operation: 'session.model-defaults', operationId, stage, result: 'failure',
                sessionId: input.sessionId, ...(identity.type === 'flow' ? {targetKind: 'flow', targetId: identity.id} : {agentId: identity.id}), errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
                    ? code : 'MODEL_DEFAULT_BINDING_READ_FAILED', elapsedMs: Date.now() - started });
            throw error;
        }
    }

    private async validateFrozenFlow(input: TaskInput): Promise<void> {
        const binding = input.instructionFlowBinding;
        if (!binding) return;
        const started = Date.now(), operationId = input.instructionId ?? input.sendIntent?.submission?.id ?? input.sessionId;
        let phase = 'materials';
        try {
            const parameters = binding.inputResolution?.parameters
                ?? (input.sendIntent?.execution.kind === 'flow' ? input.sendIntent.execution.parameters : {});
            await this.callbacks.validateCallAssets?.(input.sessionId, parameters);
            phase = 'connections';
            const catalog = frozenFlowConnections(this.agents, binding.connections);
            if (binding.plan) await validatePlannedFlowConnections(binding.plan.graph, binding.definition, catalog, input.instructionConnectionBinding?.defaults);
            else await flowToDag(binding.definition, undefined, input.instructionConnectionBinding?.connectionId,
                frozenFlowResolver(input, async () => null), [], binding.definition.dependencyLocks, false,
                input.overrides?.connectionId, input.sendIntent?.execution.kind === 'flow' ? input.sendIntent.execution.connectionBindings : undefined,
                (definition, bindings, runConnectionId) => prepareFlowConnections(definition, bindings, catalog,
                    input.instructionConnectionBinding?.defaults, runConnectionId), input.sendIntent?.execution.kind === 'flow' ? input.sendIntent.execution.parameters : undefined);
            this.host.logger.debug('Flow plan revalidated', { operation: 'flow.plan', stage: 'dispatch-admission', result: 'success',
                operationId, phase, planVersion: binding.plan?.version ?? 0, elapsedMs: Date.now() - started });
        } catch (error) {
            const code = (error as { code?: unknown })?.code;
            this.host.logger.warn('Flow plan revalidation failed', { operation: 'flow.plan', stage: 'dispatch-admission', result: 'failure',
                operationId, phase, errorCode: typeof code === 'string' && /^(?:FLOW_CONNECTION_|INPUT_ASSET_|ASSET_)[A-Z_]+$/.test(code) ? code : 'FLOW_PLAN_INVALID',
                elapsedMs: Date.now() - started });
            throw error;
        }
    }

    private assertAgentVersion(agent: ExecutorConfig, agentId: string): void {
        if (agent.type === 'flow' && agent.target?.kind === 'flow' && agent.execution?.kind === 'flow') return;
        if (!agent.agentVersion) throw new Error(`Agent version is required: ${agent.id} — requested agentId='${agentId}' `
            + 'resolved to the fallback config (unknown/empty agent id, or resolution failed). '
            + 'See the [AgentResolver] warning in the console.');
    }

    private async getLog(task: ExecutionTask): Promise<RoundLog> {
        const log = this.logs.get(task.sessionId) ?? new RoundLog(this.engine, task.sessionId);
        this.logs.set(task.sessionId, log);
        log.setEventListener(event => {
            // Transcript finalization uses refreshSession. Associations must also
            // reach a user-only rerun Round before any assistant result exists.
            if (event.type !== 'round:updated' || !event.changes.execution) return;
            const state = this.callbacks.getSessionContext(task.sessionId)?.state;
            if (state) for (const update of state.apply(event)) this.eventBus.emitSession(task.sessionId, update);
        });
        return log;
    }

    private handleError(
        error: unknown,
        task: ExecutionTask,
        runtime: SessionRuntime,
        state: SessionState,
        stage: string,
    ): void {
        const aborted = task.abortController.signal.aborted
            || (error instanceof Error && error.name === 'AbortError');
        const status = aborted ? 'aborted' as const : 'failed' as const;
        runtime.error = error instanceof Error ? error : new Error(String(error));
        this.host.logger.warn('Session run failed', { operation: 'session.run', stage, result: status,
            sessionId: task.sessionId, operationId: task.input.instructionId ?? task.id,
            errorCode: runFailureCode(error), elapsedMs: Date.now() - task.createdAt });
        this.callbacks.onStatusChange(task.sessionId, status);
        const message = formatErrorMessage(error);
        projectError(this.eventBus, task.sessionId, state, status, message);
    }

    private finishMissingContext(task: ExecutionTask, runtime: SessionRuntime): void {
        this.active.delete(task.sessionId);
        runtime.currentTaskId = undefined;
        this.callbacks.onStatusChange(task.sessionId, 'failed');
        this.activity?.finish(task.sessionId, 'failed', task.input?.instructionId);
        this.host.logger.error('Session context not found', { sessionId: task.sessionId });
    }
}

function runFailureCode(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
    const message = error instanceof Error ? error.message : '';
    if (/skill.*(?:not found|missing|disabled|unavailable)/i.test(message)) return 'SKILL_UNAVAILABLE';
    if (/reload required|skill.*drift/i.test(message)) return 'SKILL_RELOAD_REQUIRED';
    if (/identity was not admitted/i.test(message)) return 'FLOW_IDENTITY_NOT_ADMITTED';
    return 'RUN_EXECUTION_FAILED';
}

function admittedIdentity(input: TaskInput, identity: ExecutorConfig): ExecutorConfig {
    if (!input.instructionId || input.target || input.instructionConnectionBinding?.identityVersion === 1) return identity;
    const {target: _unrecordedTarget, ...legacy} = identity;
    return legacy;
}

function pinQueuedTarget(item: import('../contracts/instruction-queue').SessionInstruction, identity: ExecutorConfig): import('../contracts/instruction-queue').SessionInstruction {
    if (!item.target) return item;
    if (!identity.target) throw Object.assign(new Error('Call target has no admitted definition identity'), {code: 'CALL_TARGET_UNAVAILABLE'});
    assertSelectedTarget(item.target, identity.target);
    const target = {kind: identity.target.kind, id: identity.target.id, version: identity.target.version};
    const overrides = target.kind === 'flow' ? {...item.overrides, flowExpectedSignature: item.overrides?.flowExpectedSignature
        ?? {id: target.id as FlowRevision['id'], revision: Number(target.version), digest: identity.target.digest}} : item.overrides;
    return {...item, target, overrides};
}

function assertConversationTarget(input: TaskInput, identity: ExecutorConfig): void {
    const selection = input.overrides?.harnessConversation;
    if (selection === undefined) return;
    if (identity.execution?.kind !== 'harness' || input.overrides?.flowId || input.sendIntent?.execution.kind === 'flow')
        throw Object.assign(new Error('Native context selection requires a direct Harness target'), {code: 'CONTEXT_TARGET_UNSUPPORTED'});
    assertConversationSelection(selection);
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
            metaInfo: config.type === 'flow' ? {target: structuredClone(config.target)} : {agentId: config.id, agentIcon: config.icon},
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
        invocation: task.input.invocation,
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
