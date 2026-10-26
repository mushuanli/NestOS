export {IndependentCallService};
export type {IndependentTaskCallPreparation, IndependentTaskCallPolicy, PreparedIndependentTaskCall, IndependentTaskCallAdmission} from './session/independent-call-preparation';
export {prepareDirectConversationRun, type DirectConversationPreparationInput, type DirectConversationPreparationOptions, type PreparedDirectConversationRun, type PreparedConversationContext} from './session/conversation-preparation';
export {prepareDirectRun, type DirectRunPreparation} from './session/direct-run-preparation';
export type {DirectConversationInput} from './session/direct-conversation';
import {IndependentCallService} from './session/independent-calls';
import { prepareFlowConnections } from './session/flow-connections';
import { operationModelNames } from '@itookit/kernel-adapters/contracts';
import { checkFlowConnectionSlots, checkFlowConnections, type FlowConnectionCheckInput } from './session/flow-connection-check';
import { skillContextResolver } from './session/direct-conversation';
import { createSessionHost, type SessionHostPorts } from './utils/host-ports';
import { ContentTransferService } from './session/content-transfers';
export { ContentTransferService } from './session/content-transfers';
import { FlowInvocationService } from './session/flow-invocations';
import type { FlowInvocationSessions } from './persistence/flow-invocation-sessions';
import { RoundLog as InvocationRoundLog } from './persistence/round-log';
export { FlowInvocationService, FlowInvocationCommand, type FlowInvocationRecord, type FlowInvocationInput } from './session/flow-invocations';
export {flowInvocationId} from './contracts/flow-invocations';
export { createFlowInvocationSessions, type FlowInvocationSessions } from './persistence/flow-invocation-sessions';
import { bindStandaloneFlowNode } from './session/flow-node-binder';
import { AgentResolver } from './session/agent-resolver';
export { createSessionDataProjection } from './persistence/session-projection';
export * from './core/types';
export * from './core/errors';
export { CONVERSATION_DEFAULTS } from './core/constants';
export { CommandBus } from './core/command-bus';
export { ExtensionRegistry } from './core/extension-registry';

export { createSessionPlugin, SessionCommand } from './plugins/session-plugin';
export { createVcsPlugin } from './plugins/vcs-plugin';
export { createHistoryPlugin } from './plugins/history-plugin';

export { SessionManager } from './session/session-manager';
export type { SessionQuery } from './session/session-query';
export { SessionRegistry, type BoundContext } from './session/session-registry';
export { RoundOperations } from './session/round-operations';
export { BranchService } from './session/branch-service';
export { SessionState, type HistoryMessage } from './session/session-state';
export { SessionEventBus } from './session/session-event-bus';
export { AgentResolver, type AgentInfo, type ModelInfo, type AgentResolutionPolicy, type AgentResolutionFailure } from './session/agent-resolver';
export { AttachmentProcessor } from './session/attachment-processor';

export { SessionRepository } from './persistence/session-repository';
export type { SessionHistoryChain } from './persistence/history-chain';
export { FlowEngine, FLOW_MODULE_NAME } from './persistence/flow-engine';
export { RoundLog, roundToProjection, hasEffectiveAssistant } from './persistence/round-log';
export { RoundGraphService, RoundGraphError } from './persistence/round-graph-service';
export * from '@itookit/llm-flow';
export { FlowDefinitionStore, FlowDraftVersionConflictError } from '@itookit/llm-flow';
export type {
    RoundManifest,
    RoundProjection,
    PersistedRound,
    BranchMeta,
} from './persistence/round-types';
export type { RoundLogEvent, RoundChangeSet } from './persistence/round-events';
export type {
    ISessionRepository,
    SessionDeletionStore,
    ConversationManifest,
    SessionSummary,
    ConversationUIState,
    SessionCreation,
    SessionLoadState,
    SessionRepositoryChange,
    BranchTreeNode,
    SessionFolder,
} from './persistence/types';

export {
    PromptHistoryService,
    type PromptHistoryEntry,
    type HistoryQueryOptions,
} from './services/prompt-history-service';
export type {
    IAgentConfigService,
    IAgentManagementService,
    IConnectionService,
    MCPServer,
} from './services/agent-service';
export { VFSAgentService } from './services/vfs-agent-service';
export type {
    IPrivilegedCommandService,
    PlanCommandRequest,
    ExecCommandRequest,
} from './services/privileged-command';

export {
    SESSION_DIRECTORY_STORAGE_KIND,
    SessionDirectoryStorageResolver,
    sessionDirectoryStorage,
} from './persistence/session-directory-storage';
export { DurableConversationProjection } from './persistence/durable-conversation-projection';
export { formatErrorMessage } from './utils/error-formatter';
import type { DagPluginCatalog } from '@itookit/llm-flow/contracts';
import type { ToolDefinition } from '@itookit/llm-context';
import type { Kernel } from '@itookit/durable-kernel';
import type { IAgentConfigService } from './services/agent-service';
import type { ISessionRepository } from './persistence/types';
import { SessionManager } from './session/session-manager';
import { PromptHistoryService } from './services/prompt-history-service';
import { CommandBus } from './core/command-bus';
import { ExtensionRegistry } from './core/extension-registry';
import { createSessionPlugin, SessionCommand } from './plugins/session-plugin';
import { createVcsPlugin } from './plugins/vcs-plugin';
import { createHistoryPlugin } from './plugins/history-plugin';
import { FlowDefinitionStore, type FlowStore } from '@itookit/llm-flow';
import { DagCommandService, FlowCommand } from '@itookit/llm-flow';
import { registerDurablePrograms } from '@itookit/llm-flow';

export interface ConversationSystemOptions {
    independentCalls?: IndependentCallService;
    independentTaskCallPolicy?(request: import('./contracts/submission').SubmissionRequest): Promise<import('./session/independent-call-preparation').IndependentTaskCallPolicy | undefined>;
    submitIndependentCall?: import('./contracts/independent-calls').IndependentCallSubmitter;
    readContextBindings?: import('./contracts/context-bindings').ContextBindingReader;
    readContextOptions?: import('./contracts/context-options').ContextOptionsReader;
    loadArtifact?: import('./contracts/artifacts').ArtifactLoader;
    validateCallAssets?: import('./contracts/submission').CallAssetValidator;
    summarizeContent?: (sessionId: string, text: string) => Promise<string>;
    executionActivity?: import('./session/session-execution-activity').SessionExecutionActivity;
    instructionQueueSessions?: import('./persistence/instruction-queue-sessions').InstructionQueueSessions;
    scheduleAgentInitialization?: (initialize: () => Promise<void>) => void | Promise<void>;
    scheduleInvocationRecovery?: (recover: () => Promise<void>) => void | Promise<void>;
    directAgentPolicy?: import('./contracts').DirectAgentPolicy;
    hostPorts?: SessionHostPorts;
    agentResolution?: import('./session/agent-resolver').AgentResolutionPolicy;
    memoryProvider?: import('./session/session-memory-provider').SessionMemoryProvider;
    retrieveMemory?: import('./session/conversation-run-coordinator').ConversationRunCoordinatorOptions['retrieveMemory'];
    agentService: IAgentConfigService;
    sessionEngine: ISessionRepository;
    promptHistoryFiles: import('@itookit/vfs-core').IFileSystem;
    kernel: Kernel;
    /** Standalone workflow storage (flows VFS module). */
    flowStore: FlowStore;
    resolveSessionContext?: (sessionId: string, userMessage: string) => Promise<{ projectInstructions: string; skillInstructions: string; skillIndex: string }>;
    resolveSessionSkills?: (sessionId: string, ids: string[]) => Promise<import('./contracts').LLMSkill[]>;
    resolveMCPToolIds?: (sessionId: string, ids: string[]) => Promise<string[]>;
    resolveHarnessToolIds?: (sessionId: string) => Promise<string[]>;
    resolveTools?: (sessionId: string, allowedIds: string[]) => Promise<{
        definitions: ToolDefinition[];
        externalIds: string[];
    }>;
    dagPlugins: DagPluginCatalog;
    /**
     * Host single-writer gate: true when this host may write the Session. When it resolves false,
     * starting a new run is refused so a Session owned by another host stays read-only.
     */
    canWriteSession?: (sessionId: string) => Promise<boolean>;
    prepareSessionExecution?(sessionId: string): Promise<void>;
    /** Host-provided isolated workspace manager for Flow runs (absent → non-shared modes fail closed). */
    workspaceManager?: import('./session/conversation-run-coordinator').ConversationRunCoordinatorOptions['workspaceManager'];
    /**
     * Marks Sessions that admitted a Flow invocation, so boot recovery skips the Sessions that
     * never did instead of probing every Session's shared state.
     */
    flowInvocationSessions?: FlowInvocationSessions;
}

export interface ConversationSystem {
    /** Trusted host API; prepared plans are never accepted as command arguments. */
    independentCalls?: IndependentCallService;
    sessionManager: SessionManager;
    commandBus: CommandBus;
    dag: DagCommandService;
    dispose(): Promise<void>;
}

export async function initializeConversationSystem(
    options: ConversationSystemOptions,
): Promise<ConversationSystem> {
    const promptHistory = await initializeServices(options);
    let system: ConversationSystem | undefined;
    try {
        registerDurablePrograms(options.kernel);
        const manager = createManagedSession(options, promptHistory);
        system = createControlPlane(options, manager);
        await initializeInvocations(options, system);
        return system;
    } catch (error) {
        try { if (system) await system.dispose(); else await promptHistory.dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Conversation initialization and cleanup failed'); }
        throw error;
    }
}

function createManagedSession(options: ConversationSystemOptions, promptHistory: PromptHistoryService): SessionManager {
    return new SessionManager(options.sessionEngine, options.agentService, {
        executionActivity: options.executionActivity,
        instructionQueueSessions: options.instructionQueueSessions,
        directAgentPolicy: options.directAgentPolicy, agentResolution: options.agentResolution, hostPorts: options.hostPorts, promptHistory,
        kernel: options.kernel, dagPlugins: options.dagPlugins, flowStore: options.flowStore,
        resolveTools: options.resolveTools, resolveHarnessToolIds: options.resolveHarnessToolIds,
        resolveMCPToolIds: options.resolveMCPToolIds, resolveSessionContext: options.resolveSessionContext,
        resolveSessionSkills: options.resolveSessionSkills, retrieveMemory: options.retrieveMemory,
        memoryProvider: options.memoryProvider, canWriteSession: options.canWriteSession,
        workspaceManager: options.workspaceManager, loadArtifact: options.loadArtifact,
        readContextBindings: options.readContextBindings, readContextOptions: options.readContextOptions,
        validateCallAssets: options.validateCallAssets,
    });
}

async function initializeInvocations(options: ConversationSystemOptions, system: ConversationSystem): Promise<void> {
    const transfers = new ContentTransferService({kernel: options.kernel, repository: options.sessionEngine, commands: system.commandBus,
        hostPorts: options.hostPorts, canWrite: options.canWriteSession, prepareExecution: options.prepareSessionExecution,
        summarize: options.summarizeContent});
    transfers.register();
    if (options.independentCalls) {
        system.independentCalls = options.independentCalls;
        system.independentCalls.register(system.commandBus);
    } else if (options.submitIndependentCall) {
        system.independentCalls = new IndependentCallService({kernel: options.kernel, repository: options.sessionEngine,
            transfers, submit: options.submitIndependentCall, prepareTaskCall: (request, invocation) => system.sessionManager.prepareIndependentTaskCall(request, invocation),
            taskCallPolicy: options.independentTaskCallPolicy,
            resumeExecution: async target => {
                const task = await options.kernel.task(target.sessionId, target.taskId);
                if (task.program.kind === 'flow.aggregate') await system.commandBus.execute(FlowCommand.RunResume,
                    {sessionId: target.sessionId, taskId: target.taskId});
            },
            prepareExecution: options.prepareSessionExecution, canWrite: options.canWriteSession, hostPorts: options.hostPorts});
        system.independentCalls.register(system.commandBus);
        const dispose = system.dispose, calls = system.independentCalls;
        system.dispose = async () => {await calls.dispose(); await dispose();};
    }
    if (system.independentCalls) {
        const calls = system.independentCalls;
        system.sessionManager.setIndependentCallScope(id => calls.readBackgroundCallers(id), id => calls.canStartSessionInput(id));
        const unsubscribe = system.independentCalls.onHistoryCommitted(id => system.sessionManager.refreshCommittedHistory(id));
        const dispose = system.dispose;
        system.dispose = async () => {unsubscribe(); await dispose();};
    }
    const invocations = new FlowInvocationService(options.kernel, new FlowDefinitionStore(options.flowStore, options.dagPlugins), system.commandBus, options.canWriteSession, async id => {
        const manifest = await new InvocationRoundLog(options.sessionEngine, id).loadManifest();
        const identity = await options.sessionEngine.getManifest(id);
        return { branch: manifest.currentBranch, head: manifest.currentHead, parentSessionId: identity.parentSessionId ?? undefined };
    }, (id, selected) => resolveSessionConnection(options, id, selected), options.flowInvocationSessions, system.dag, transfers, options.hostPorts);
    invocations.register();
    const recover = () => createSessionHost(options.hostPorts).traceBoot('flowInvocations.recover', async () => {
        await invocations.recover(); await system.independentCalls?.recover();
    });
    if (options.scheduleInvocationRecovery) await options.scheduleInvocationRecovery(recover);
    else await recover();
}

async function initializeServices(options: ConversationSystemOptions): Promise<PromptHistoryService> {
    const host = createSessionHost(options.hostPorts);
    const initializeAgents = () => host.traceBoot('agentService.init', () => options.agentService.init());
    if (options.scheduleAgentInitialization) await options.scheduleAgentInitialization(initializeAgents);
    else await initializeAgents();
    await host.traceBoot('sessionEngine.init', () => options.sessionEngine.init());
    const history = new PromptHistoryService(options.promptHistoryFiles, host);
    await host.traceBoot('promptHistory.init', () => history.init()).catch(error => {
        host.logger.warn('Prompt history initialization failed', { error });
    });
    return history;
}

function createControlPlane(
    options: ConversationSystemOptions,
    sessionManager: SessionManager,
): ConversationSystem {
    let disposal: Promise<void> | undefined;
    const commandBus = new CommandBus();
    commandBus.register(SessionCommand.GetConnections, async () => ({ connections: (await options.agentService.getConnections()).map(connection => ({ ...connection,
        operationModels: operationModelNames(connection, options.agentService.getProvider(connection.providerId)),
        enabled: connection.enabled !== false && options.agentService.getProvider(connection.providerId)?.enabled !== false })),
        defaultId: (await options.agentService.getDefaultConnection())?.id,
        modelDefaults: await options.agentService.getModelDefaults?.() ?? {} }));
    const dag = createDagCommands(options, commandBus);
    activateConversationPlugins(sessionManager, commandBus);
    return { sessionManager, commandBus, dag, dispose: () => disposal ??= (async () => {
        sessionManager.destroy(); await sessionManager.waitForInstructionWrites(); await sessionManager.promptHistory?.dispose();
    })() };
}

function createDagCommands(
    options: ConversationSystemOptions,
    commandBus: CommandBus,
): DagCommandService {
    const flowStore = new FlowDefinitionStore(
        options.flowStore,
        options.dagPlugins,
    );
    commandBus.register(SessionCommand.CheckFlowConnectionSlots, args => checkFlowConnectionSlots(args as FlowConnectionCheckInput, options.agentService));
    commandBus.register(SessionCommand.CheckFlowConnections, args => checkFlowConnections(args as FlowConnectionCheckInput, options.agentService, flowStore,
        options.dagPlugins, createSessionHost(options.hostPorts).logger));
    const logger = createSessionHost(options.hostPorts).logger;
    const dag = new DagCommandService({
        validateInputAssets: options.validateCallAssets,
        onControlDiagnostic: event => {
            if (event.outcome === 'error') logger.warn(event.operation, {...event});
            else logger.info(event.operation, {...event});
        },
        prepareConnections: (flow, bindings, runConnectionId) => prepareFlowConnections(flow, bindings, options.agentService, undefined, runConnectionId),
        prepareConnectionResolver: async () => {
            const defaults = await options.agentService.getModelDefaults?.() ?? {};
            return (flow, bindings, runConnectionId) => prepareFlowConnections(flow, bindings, options.agentService, defaults, runConnectionId);
        },
        resolveConnection: (id, selected) => resolveSessionConnection(options, id, selected),
        flowStore,
        canWriteSession: options.canWriteSession,
        workspaceManager: options.workspaceManager,
        kernel: options.kernel,
        plugins: options.dagPlugins,
        bindNode: async (sessionId, node, defaults, context) => bindStandaloneFlowNode(node, defaults, sessionId,
            new AgentResolver(options.agentService, options.resolveSessionSkills, options.resolveMCPToolIds, createSessionHost(options.hostPorts), options.agentResolution),
            context?.runConnectionId ?? (await options.sessionEngine.getSessionSettings(sessionId)).connectionId),
        resolveSessionContext: options.resolveSessionContext,
        resolveTools: options.resolveTools,
        resolveSkillContexts: skillContextResolver({ resolveSkills: (ids, sessionId) => options.resolveSessionSkills?.(sessionId!, ids) ?? Promise.resolve([]), resolveTools: options.resolveTools }),
    });
    dag.register(commandBus);
    return dag;
}

function activateConversationPlugins(
    sessionManager: SessionManager,
    commandBus: CommandBus,
): void {
    const extensions = new ExtensionRegistry();
    extensions.register(createSessionPlugin(sessionManager));
    extensions.register(createVcsPlugin(sessionManager));
    extensions.register(createHistoryPlugin(sessionManager));
    extensions.activate({ commands: commandBus });
}

export { SessionMemoryProvider, type MemoryWrite, type MemoryEntry, type MemoryMutationOptions } from './session/session-memory-provider';
export { SharedMemoryStore, type SharedMemoryResource, type SharedMemoryGrant, type SharedMemoryAudit } from './session/shared-memory-store';
export { SessionMemoryControls } from './session/session-memory-controls';
export { MemorySharingControls } from './session/memory-sharing-controls';
export { TaskMemoryService } from './session/task-memory-service';

export { bindStandaloneFlowNode, type FlowIdentityResolver } from './session/flow-node-binder';

export { buildSkillContexts } from '@itookit/llm-tasks';

export { FlowRunProjection, projectTaskInteractions, type FlowRunProjectionOptions } from './persistence/flow-run-projection';

async function resolveSessionConnection(options: ConversationSystemOptions, sessionId: string, selected?: string): Promise<string | undefined> {
    const settings = await options.sessionEngine.getSessionSettings(sessionId);
    const id = selected ?? settings.connectionId;
    const connection = id ? await options.agentService.getConnection(id) : await options.agentService.getDefaultConnection();
    if (id && !connection) throw new Error(`Connection not found: ${id}`);
    if (connection && (connection.enabled === false || options.agentService.getProvider(connection.providerId)?.enabled === false))
        throw new Error(`Connection is disabled: ${connection.id}`);
    return connection?.id;
}

export { hasCommittedSubmission } from './persistence/submission-receipt';
export { createInstructionQueueSessions, type InstructionQueueSessions } from './persistence/instruction-queue-sessions';
export { SessionExecutionActivity } from './session/session-execution-activity';
export { readSessionInstructionQueue } from './persistence/instruction-queue-store';

export * from './contracts';
export { createSessionHost, type SessionHostPorts, type SessionHost, type SessionLogger, type SessionTextKey } from './utils/host-ports';

export { moveSessionDataDirectory } from "./persistence/session-storage-locations";

export { prepareFlowConnections } from './session/flow-connections';
