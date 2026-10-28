import {configuredToolCatalog} from '../kernel/tool-commands';
import {registerInputSourceExecution} from '../host/input-source-execution';
import {registerResourceReferences} from '../host/resource-references';
import {createTaskAssetReader} from './task-assets';
import {createTaskArtifactServices} from './task-artifact-services';
import {createContextBindingReader} from '../projects/harness-context-catalog';
import {createContextOptionsReader} from '../projects/harness-context-options';
import type {HarnessConnectionService} from '../projects/harness-connections';
import { createTransferSummarizer } from './transfer-summary';
import {registerInputAssets} from './input-assets';
import {validateCallAssets} from './call-asset-preflight';
import { createNestosDirectAgentPolicy } from '../presets/direct-agent-policy';
import { createFlowCapabilities } from './flow-capabilities';
import { createFlowInvocationSessions, initializeConversationSystem, type CommandBus, type FlowEngine, type SessionManager, type SessionRepository, type VFSAgentService } from '@itookit/llm-session';
import { resolveSessionSkillContext, resolveSessionSelectedSkills } from '@itookit/kernel-adapters';
import type { IFileSystem, IVFSManager } from '@itookit/vfs-core';
import type { HeadlessKernelRuntime } from './create-kernel-runtime';
import { withWorkspaceScopeCleanup } from './workspace-scope-cleanup';
import { t, createModuleLogger, traceBoot } from '@itookit/common';
import { registerFlowLibraryRecovery } from '../presets/restore-flows';

export interface OwnedConversationView { sessionManager: SessionManager; commandBus: CommandBus; dispose(): Promise<void> }

export interface ConversationSystemOptions {
    projects?: import('@itookit/app-contracts/services').ProjectService;
    independentCalls?: import('@itookit/llm-session').IndependentCallService;
    submitIndependentCall?: import('@itookit/llm-session/contracts').IndependentCallSubmitter;
    ensureFlowDependencies?(flowId: string): Promise<void>;
    executionActivity?: import('@itookit/llm-session').SessionExecutionActivity;
    instructionQueueSessions?: import('@itookit/llm-session').InstructionQueueSessions;
    scheduleAgentInitialization?: (initialize: () => Promise<void>) => void | Promise<void>;
    scheduleInvocationRecovery?: (recover: () => Promise<void>) => void | Promise<void>;
    digitalTwin?: import('../digital-twin/service').DigitalTwinService;
    directAgentPolicy?: import('@itookit/llm-session/contracts').DirectAgentPolicy;
    agentResolution?: import('@itookit/llm-session').AgentResolutionPolicy;
    vfs: IVFSManager;
    promptHistoryFiles?: IFileSystem;
    /** Root view shared by Session-independent services; holds the Flow invocation marker. */
    systemFS: IFileSystem;
    agentService: VFSAgentService;
    sessionRepository: SessionRepository;
    flowEngine: FlowEngine;
    kernel: HeadlessKernelRuntime;
    executionConnections?: Pick<HarnessConnectionService, 'inspect'>;
    /**
     * Host-owned single-writer gate: true when this host may write the Session. A Session whose
     * lease is held by another host must stay read-only instead of racing its owner.
     */
    ensureWritable?(sessionId: string): Promise<boolean>;
    prepareSessionExecution?(sessionId: string): Promise<void>;
    /** Host-provided isolated workspace manager for Flow runs (absent → non-shared modes fail closed). */
    flowWorkspaceManager?: import('@itookit/llm-flow').FlowWorkspaceManager;
}

/**
 * Assemble the conversation layer on top of a recovered Kernel: prompt history lives in
 * the VFS, the Kernel owns session context and tools, and the host only supplies the ports.
 * `resolveTools` narrows the advertised tools to the node's grants and marks external ones.
 */
export async function createConversationSystem(
    options: ConversationSystemOptions,
): Promise<{ sessionManager: SessionManager; commandBus: CommandBus; independentCalls?: import('@itookit/llm-session').IndependentCallService; dispose(): Promise<void> }> {
    const { vfs, agentService, sessionRepository, flowEngine, kernel, systemFS } = options;
    const capabilities = createFlowCapabilities(kernel);
    const artifacts = createTaskArtifactServices(kernel.kernel, systemFS);
    const system = await initializeConversationSystem({
        executionActivity: options.executionActivity,
        submitIndependentCall: options.submitIndependentCall,
        independentCalls: options.independentCalls,
        independentTaskCallPolicy: async request => {
            const target = request.expectedTarget;
            if (!target) return;
            if (target.kind === 'flow') return {maxDepth: 8, timeoutMs: null};
            const published = await agentService.getAgentRevision?.(target.id, target.version);
            if (!published) return;
            return {maxDepth: 8, timeoutMs: null};
        },
        instructionQueueSessions: options.instructionQueueSessions,
        scheduleAgentInitialization: options.scheduleAgentInitialization,
        scheduleInvocationRecovery: options.scheduleInvocationRecovery,
        directAgentPolicy: options.directAgentPolicy ?? createNestosDirectAgentPolicy(),
        agentResolution: options.agentResolution,
        hostPorts: { translate: t, logger: createModuleLogger('llm-conversation'), traceBoot },
        loadArtifact: artifacts.loadArtifact,
        readContextBindings: createContextBindingReader(kernel.kernel),
        readContextOptions: createContextOptionsReader({kernel: kernel.kernel, agents: agentService,
            sessions: sessionRepository, connections: options.executionConnections}),
        validateCallAssets: (_sessionId, value) => validateCallAssets(systemFS, value),
        agentService,
        summarizeContent: createTransferSummarizer(sessionRepository, agentService, kernel.llmService),
        sessionEngine: sessionRepository,
        promptHistoryFiles: options.promptHistoryFiles ?? await vfs.openFileSystem('/home/admin/.config/nestos/prompt-history'),
        flowInvocationSessions: createFlowInvocationSessions(systemFS),
        independentCallSessions: createFlowInvocationSessions(systemFS, 'independent'),
        kernel: kernel.kernel,
        flowStore: flowEngine,
        dagPlugins: kernel.dagPlugins,
        retrieveMemory: async (plan, agent, context) => [
            ...await kernel.memory.retrieve(plan, agent, context),
            ...await options.digitalTwin?.retrieve(plan, agent.id, context.sessionId) ?? [],
        ],
        memoryProvider: kernel.memory,
        workspaceManager: options.flowWorkspaceManager ? withWorkspaceScopeCleanup(options.flowWorkspaceManager, kernel, options.ensureWritable) : undefined,
        canWriteSession: options.ensureWritable,
        prepareSessionExecution: options.prepareSessionExecution,
        resolveSessionContext: (sessionId, userMessage) => resolveSessionSkillContext(kernel.kernel, kernel.sessions, sessionId, userMessage),
        resolveSessionSkills: (sessionId, ids) => resolveSessionSelectedSkills(kernel.kernel, kernel.sessions, sessionId, ids),
        resolveTools: capabilities.resolveTools,
        resolveHarnessToolIds: capabilities.resolveHarnessToolIds,
        resolveMCPToolIds: capabilities.resolveMCPToolIds,
    });
    const sourceExecutions = registerInputSourceExecution({commands: system.commandBus, fs: systemFS, kernel: kernel.kernel, repository: options.sessionRepository, projects: options.projects,
        prepare: options.prepareSessionExecution, writable: options.ensureWritable, tools: async () => configuredToolCatalog(kernel.toolCatalog, await options.agentService.getMCPServers())});
    const references = registerResourceReferences(system.commandBus, {vfs: options.vfs, projects: options.projects, repository: options.sessionRepository});
    const inputs = registerInputAssets(system.commandBus, systemFS, reference => createTaskAssetReader(() => kernel.kernel, systemFS)(reference, {...reference, operationId: 'preview', effectId: 'preview'}));
    const artifactCommands = artifacts.register(system.commandBus);
    const recovery = registerFlowLibraryRecovery(system.commandBus, options.ensureFlowDependencies);
    return { ...system, async dispose() { sourceExecutions.dispose(); references.dispose(); inputs.dispose(); artifactCommands.dispose(); recovery.dispose(); await system.dispose(); } };
}
