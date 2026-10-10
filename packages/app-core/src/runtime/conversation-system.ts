import { createMindosDirectAgentPolicy } from '../presets/direct-agent-policy';
import { createFlowCapabilities } from './flow-capabilities';
import { createFlowInvocationSessions, initializeConversationSystem, type CommandBus, type FlowEngine, type SessionManager, type SessionRepository, type VFSAgentService } from '@itookit/llm-session';
import { resolveSessionSkillContext, resolveSessionSelectedSkills } from '@itookit/kernel-adapters';
import type { IFileSystem, IVFSManager } from '@itookit/vfs-core';
import type { HeadlessKernelRuntime } from './create-kernel-runtime';
import { withWorkspaceScopeCleanup } from './workspace-scope-cleanup';
import { t, createModuleLogger, traceBoot } from '@itookit/common';

export interface ConversationSystemOptions {
    digitalTwin?: import('../digital-twin/service').DigitalTwinService;
    directAgentPolicy?: import('@itookit/llm-session/contracts').DirectAgentPolicy;
    agentResolution?: import('@itookit/llm-session').AgentResolutionPolicy;
    vfs: IVFSManager;
    /** Root view shared by Session-independent services; holds the Flow invocation marker. */
    systemFS: IFileSystem;
    agentService: VFSAgentService;
    sessionRepository: SessionRepository;
    flowEngine: FlowEngine;
    kernel: HeadlessKernelRuntime;
    /**
     * Host-owned single-writer gate: true when this host may write the Session. A Session whose
     * lease is held by another host must stay read-only instead of racing its owner.
     */
    ensureWritable?(sessionId: string): Promise<boolean>;
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
): Promise<{ sessionManager: SessionManager; commandBus: CommandBus; dispose(): Promise<void> }> {
    const { vfs, agentService, sessionRepository, flowEngine, kernel, systemFS } = options;
    const capabilities = createFlowCapabilities(kernel);
    return initializeConversationSystem({
        directAgentPolicy: options.directAgentPolicy ?? createMindosDirectAgentPolicy(),
        agentResolution: options.agentResolution,
        hostPorts: { translate: t, logger: createModuleLogger('llm-conversation'), traceBoot },
        agentService,
        sessionEngine: sessionRepository,
        promptHistoryFiles: await vfs.openFileSystem('/home/admin/.config/mindos/prompt-history'),
        flowInvocationSessions: createFlowInvocationSessions(systemFS),
        kernel: kernel.kernel,
        flowStore: flowEngine,
        dagPlugins: kernel.dagPlugins,
        retrieveMemory: async (plan, agent, context) => [
            ...await kernel.memory.retrieve(plan, agent, context),
            ...await options.digitalTwin?.retrieve(plan, agent.id, context.sessionId) ?? [],
        ],
        memoryProvider: kernel.memory,
        workspaceManager: options.flowWorkspaceManager ? withWorkspaceScopeCleanup(options.flowWorkspaceManager, kernel) : undefined,
        canWriteSession: options.ensureWritable,
        resolveSessionContext: (sessionId, userMessage) => resolveSessionSkillContext(kernel.kernel, kernel.sessions, sessionId, userMessage),
        resolveSessionSkills: (sessionId, ids) => resolveSessionSelectedSkills(kernel.kernel, kernel.sessions, sessionId, ids),
        resolveTools: capabilities.resolveTools,
        resolveHarnessToolIds: capabilities.resolveHarnessToolIds,
        resolveMCPToolIds: capabilities.resolveMCPToolIds,
    });
}
