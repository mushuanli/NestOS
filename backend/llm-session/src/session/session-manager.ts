import { snapshotDirectAgentPolicy, type ResolvedDirectAgentPolicy } from '../contracts/direct-agent-policy';
import { restoreFlowHistory } from '../persistence/restore-flow-history';
import { KernelError, KernelErrorCode } from '@itookit/durable-kernel';
import { flowBranchExecutions } from './flow-branches';
import { FlowRerunService } from './flow-rerun';
// @file: llm-conversation/session/session-manager.ts

import {
    SessionGroup,
    SessionStatus,
    SessionRuntime,
    SessionSnapshot,
    SessionEventEnvelope,
    ChatAttachment,
    ExecutionOverrides,
    ChatSessionSettings,
    DEFAULT_SESSION_SETTINGS,
    DeleteOptions,
    DeleteResult,
    RegistryEvent,
    RegenerateOptions,
    RegenerateResult,
    SessionOrigin,
    HistoryPolicy,
} from '../core/types';
import type { DagPluginCatalog, JsonValue, SendIntent } from '@itookit/llm-flow/contracts';
import type { ToolDefinition } from '@itookit/llm-context';
import type { FlowStore } from '@itookit/llm-flow';
import { ConversationError, ConversationErrorCode } from '../core/errors';
import { CONVERSATION_DEFAULTS } from '../core/constants';
import { ISessionRepository, BranchTreeNode } from '../persistence/types';
import type { IAgentConfigService } from '../services/agent-service';
import type { ISession, Signal } from '../contracts';
import type { AgentEvent } from '@itookit/llm-tasks/contracts';
import { SessionRunCoordinator } from './session-run-coordinator';
import { AgentResolver, AgentInfo, ModelInfo } from './agent-resolver';
import { AttachmentProcessor } from './attachment-processor';
import {
    PromptHistoryEntry,
    HistoryQueryOptions,
} from '../services/prompt-history-service';
import { createSessionHost, type SessionHost } from '../utils/host-ports';
import { SessionRegistry } from './session-registry';
import { SessionQuery } from './session-query';
import { RoundOperations } from './round-operations';
import { BranchService } from './branch-service';
import { ContextProfileStore } from '../persistence/context-profile-store';
import { createContextAssembler } from '@itookit/llm-context';
import { RoundLog } from '../persistence/round-log';
import type { Kernel, SessionHandle } from '@itookit/durable-kernel';
import { sessionDirectoryStorage } from '../persistence/session-directory-storage';
import { DurableConversationProjection, RUNTIME_KEY } from '../persistence/durable-conversation-projection';
import { SessionMemoryProvider } from './session-memory-provider';
import { SessionMemoryControls } from './session-memory-controls';

/**
 * 会话管理器 — llm-conversation 对外的唯一入口
 *
 * 门面模式：组合 SessionRegistry + RoundOperations + BranchService，
 * Conversation session facade backed by Round persistence and Kernel runs.
 */
export class SessionManager implements ISession, SessionQuery {
    readonly host: SessionHost;
    readonly promptHistory?: import('../services/prompt-history-service').PromptHistoryService;
    readonly memory: SessionMemoryControls;
    private registry: SessionRegistry;
    private roundOps: RoundOperations;
    private branchService: BranchService;
    private runs: SessionRunCoordinator;
    private agentResolver: AgentResolver;
    private readonly kernel: Kernel;
    private readonly canWriteSession?: (sessionId: string) => Promise<boolean>;
    private readonly flowRerun: FlowRerunService;
    private readonly durableProjection: DurableConversationProjection;
    private durableSession?: SessionHandle;
    private durableProjectionUnsubscribe?: () => void;
    private projectionSyncTail?: Promise<void>;
    private projectionSyncQueued = false;

    private readonly directAgentPolicy: ResolvedDirectAgentPolicy;

    getDirectAgentPolicy(): ResolvedDirectAgentPolicy { return this.directAgentPolicy; }

    constructor(
        engine: ISessionRepository,
        agentService: IAgentConfigService,
        options: {
            directAgentPolicy?: import('../contracts/direct-agent-policy').DirectAgentPolicy;
            agentResolution?: import('./agent-resolver').AgentResolutionPolicy;
            hostPorts?: import('../utils/host-ports').SessionHostPorts;
            promptHistory?: import('../services/prompt-history-service').PromptHistoryService;
            kernel: Kernel;
            dagPlugins: DagPluginCatalog;
            flowStore: FlowStore;
            resolveSessionContext?: (sessionId: string, userMessage: string) => Promise<{ projectInstructions: string; skillInstructions: string; skillIndex: string }>;
            resolveSessionSkills?: (sessionId: string, ids: string[]) => Promise<import('../contracts').LLMSkill[]>;
            resolveMCPToolIds?: (sessionId: string, ids: string[]) => Promise<string[]>;
    resolveHarnessToolIds?: (sessionId: string) => Promise<string[]>;
            resolveTools?: (sessionId: string, allowedIds: string[]) => Promise<{
                definitions: ToolDefinition[];
                externalIds: string[];
            }>;
            retrieveMemory?: import('./conversation-run-coordinator').ConversationRunCoordinatorOptions['retrieveMemory'];
            memoryProvider?: SessionMemoryProvider;
            canWriteSession?: (sessionId: string) => Promise<boolean>;
            workspaceManager?: import('./conversation-run-coordinator').ConversationRunCoordinatorOptions['workspaceManager'];
        }
    ) {
        this.host = createSessionHost(options.hostPorts);
        this.directAgentPolicy = snapshotDirectAgentPolicy(options.directAgentPolicy);
        this.promptHistory = options.promptHistory;
        this.canWriteSession = options.canWriteSession;
        this.registry = new SessionRegistry(engine, round => restoreFlowHistory(options.kernel, round, this.host), this.host);
        this.agentResolver = new AgentResolver(agentService, options.resolveSessionSkills, options.resolveMCPToolIds, this.host, options.agentResolution);
        const attachments = new AttachmentProcessor(engine);

        if (!options?.kernel) throw new Error('SessionManager requires Kernel');
        this.kernel = options.kernel;
        this.memory = new SessionMemoryControls(options.memoryProvider ?? new SessionMemoryProvider(this.kernel), agentService,
            () => this.registry.ensureBound().sessionId, options.canWriteSession);
        this.durableProjection = new DurableConversationProjection(engine);
        this.runs = new SessionRunCoordinator(
            engine,
            this.registry.eventBus,
            this.agentResolver,
            attachments,
            {
                refreshSession: async sid => {
                    const state = this.registry.getSessionState(sid);
                    if (state) await this.registry.reloadSessionData(sid, state);
                },
                onStatusChange: (sid, status) => {
                    this.registry.updateStatus(sid, status);
                    this.queueDurableProjectionForSession(sid);
                },
                onUnread: (sid) => {
                    this.registry.incrementUnread(sid);
                    this.queueDurableProjectionForSession(sid);
                },
                getBoundSessionId: () => this.registry.boundSessionId,
                getSessionContext: (sid) => {
                    const state = this.registry.getSessionState(sid);
                    const runtime = this.registry.getSessionRuntime(sid);
                    if (!state || !runtime) return null;
                    return { state, runtime };
                },
            },
            options.kernel,
            options.dagPlugins,
            options.flowStore,
            options.resolveTools,
            options.retrieveMemory,
            options.resolveSessionContext,
            options.workspaceManager,
            options.resolveHarnessToolIds,
            this.host,
            this.directAgentPolicy,
        );

        this.roundOps = new RoundOperations(this.registry, this.runs, this.promptHistory);
        this.flowRerun = new FlowRerunService(this.registry, this.runs, options.flowStore, options.dagPlugins);
        this.branchService = new BranchService(this.registry);
    }

    // ================================================================
    // ISession
    // ================================================================

    get id(): string {
        return this.registry.boundSessionId ?? '';
    }

    signal(s: Signal): void {
        switch (s.type) {
            case 'send':
                this.roundOps.sendMessage(s.text, (s.attachments ?? []).map(a => ({
                    name: a.name ?? a.filename ?? '',
                    type: a.type ?? 'file',
                    size: a.size,
                })), 'default', undefined, undefined, undefined).catch(e => {
                    this.registry.eventBus.emitSession(this.registry.boundSessionId ?? '', { type: 'error', error: { message: String(e) } });
                });
                break;
            case 'abort':
                this.roundOps.abort();
                break;
            case 'inject':
                this.roundOps.sendMessage(s.text, [], 'default', undefined, 'inject', undefined).catch(() => {});
                break;
            case 'respond':
                this.runs.respondToSignal(this.registry.boundSessionId ?? '', s);
                break;
            case 'navigate':
                this.branchService.switchBranch(s.ref).catch(e => {
                    this.host.logger.warn('signal(navigate) failed', { ref: s.ref, error: e });
                });
                break;
        }
    }

    async *events(): AsyncIterableIterator<AgentEvent> {
        const sessionId = this.registry.boundSessionId;
        if (!sessionId) return;

        const queue: AgentEvent[] = [];
        let notifyResolve: (() => void) | null = null;
        let closed = false;

        const unsub = this.registry.onEvent((event) => {
            if (closed) return;
            if ('type' in event && !('payload' in event)) {
                queue.push(event as unknown as AgentEvent);
                notifyResolve?.();
                notifyResolve = null;
            }
        });

        const waitForEvent = () => new Promise<void>((res) => { notifyResolve = res; });

        try {
            while (!closed) {
                while (queue.length > 0) {
                    yield queue.shift()!;
                }
                if (!this.registry.boundSessionId || this.registry.boundSessionId !== sessionId) {
                    break;
                }
                await waitForEvent();
            }
        } finally {
            closed = true;
            unsub();
        }
    }

    // ================================================================
    // 会话绑定 → SessionRegistry
    // ================================================================

    async bindSession(sessionId: string, options?: { createMissing?: boolean }): Promise<SessionSnapshot> {
        const storage = sessionDirectoryStorage(sessionId);
        try {
            this.durableSession = await this.kernel.openSession(sessionId, storage);
        } catch (error) {
            if (options?.createMissing === false || !(error instanceof KernelError) || error.code !== KernelErrorCode.SESSION_NOT_FOUND) throw error;
            this.durableSession = await this.kernel.createSession({ id: sessionId, storage });
        }
        const snapshot = await this.registry.bindSession(sessionId);
        await this.bindDurableProjection(sessionId);
        // Hand the projection loaded with the binding to the caller so the editor does not read
        // the Session record a second time.
        return { ...snapshot, view: this.registry.getLoadedView(sessionId) };
    }

    unbindSession(): void {
        this.durableProjectionUnsubscribe?.();
        this.durableProjectionUnsubscribe = undefined;
        this.projectionSyncQueued = false;
        this.projectionSyncTail = undefined;
        this.durableSession = undefined;
        this.registry.unbindSession();
    }

    getFlowBranchExecutions(sessionId: string) {
        return flowBranchExecutions(this.registry.engine, sessionId);
    }

    getFlowRerunContext() { return this.flowRerun.context(); }

    async rerunFlow(parameters: Record<string, JsonValue>, sourceRoundId: string | null, expectedSessionId?: string, expectedDefinitionKey?: string, connectionId?: string, connectionBindings?: Record<string, string>) {
        const sessionId = this.registry.ensureBound().sessionId;
        if (this.canWriteSession && !await this.canWriteSession(sessionId)) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID,
                'Session is owned by another host; this host can only read it');
        }
        if (this.registry.ensureBound().sessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        if (expectedSessionId && expectedSessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        return this.flowRerun.run(parameters, sourceRoundId, expectedDefinitionKey, connectionId, connectionBindings);
    }

    /** Create a fresh session instance bound to a workflow run (records flow + parameters). */
    async createSessionFromFlow(
        flowId: string,
        revision: number,
        parameters: Record<string, JsonValue> | undefined,
        title: string,
        invocation = false,
        connectionId?: string,
        connectionBindings?: Record<string, string>,
    ): Promise<{ sessionId: string }> {
        const name = title.trim() || 'Workflow';
        const engine = this.registry.engine;
        const sessionId = await engine.createSession(name);
        if (invocation) {
            if (this.canWriteSession && !await this.canWriteSession(sessionId)) throw new Error('Session is owned by another host');
            await this.kernel.createSession({ id: sessionId, storage: sessionDirectoryStorage(sessionId) });
            return { sessionId };
        }
        await engine.updateManifest(sessionId, {
            flow: { flowId, revision, ...(connectionBindings ? { connectionBindings } : {}), ...(connectionId ? { connectionId } : {}), ...(parameters ? { parameters } : {}) },
        });
        return { sessionId };
    }



    private async bindDurableProjection(sessionId: string): Promise<void> {
        if (!this.durableProjection || !this.durableSession) return;
        await this.restoreDurableRuntime(sessionId);
        // The bind just read this manifest; hand it over instead of reading the record again.
        await this.durableProjection.sync(
            this.durableSession, sessionId, this.registry.getSessionRuntime(sessionId),
            this.registry.getLoadedView(sessionId)?.manifest,
        );
        this.durableProjectionUnsubscribe?.();
        this.durableProjectionUnsubscribe = this.registry.eventBus.onSession(sessionId, () => {
            this.queueDurableProjection(sessionId);
        });
    }

    /**
     * One bind emits many Session events, and every sync re-reads the manifest and the shared
     * record before it can tell whether anything changed. Coalesce: mark the session queued and
     * let one pass per settle do the work, re-reading the runtime for the latest state.
     */
    private queueDurableProjection(sessionId: string): void {
        if (!this.durableProjection || !this.durableSession) return;
        this.projectionSyncQueued = true;
        this.projectionSyncTail ??= this.drainDurableProjection(sessionId);
    }

    private async drainDurableProjection(sessionId: string): Promise<void> {
        try {
            while (this.projectionSyncQueued && this.durableSession?.id === sessionId) {
                this.projectionSyncQueued = false;
                try {
                    await this.durableProjection.sync(
                        this.durableSession, sessionId, this.registry.getSessionRuntime(sessionId),
                    );
                } catch (error) {
                    this.host.logger.warn('Durable conversation projection failed', { sessionId, error });
                }
            }
        } finally {
            this.projectionSyncTail = undefined;
            // An event that arrived while the loop was unwinding still needs its pass.
            if (this.projectionSyncQueued) this.queueDurableProjection(sessionId);
        }
    }

    private queueDurableProjectionForSession(sessionId: string): void {
        if (this.durableSession?.id !== sessionId) return;
        if (this.registry.getSessionRuntime(sessionId)) this.queueDurableProjection(sessionId);
    }

    private async restoreDurableRuntime(sessionId: string): Promise<void> {
        const entry = await this.durableSession?.getShared(RUNTIME_KEY);
        const value = entry?.value;
        if (!value || Array.isArray(value) || typeof value !== 'object') return;
        const unreadCount = value.unreadCount;
        if (typeof unreadCount === 'number') this.registry.restoreRuntimeMetadata(sessionId, { unreadCount });
    }

    // ================================================================
    // 状态查询 → SessionRegistry
    // ================================================================

    getSnapshot(): SessionSnapshot { return this.registry.getSnapshot(); }
    getSessions(): SessionGroup[] { return this.registry.getSessions(); }
    getCurrentSessionId(): string | null { return this.registry.getCurrentSessionId(); }
    getStatus(): SessionStatus | 'unbound' { return this.registry.getStatus(); }
    isGenerating(): boolean { return this.registry.isGenerating(); }
    getAllSessions(): SessionRuntime[] { return this.registry.getAllSessions(); }
    getSessionRuntime(sessionId: string): SessionRuntime | undefined { return this.registry.getSessionRuntime(sessionId); }

    hasUnsavedChanges(): boolean { return false; }

    canRegenerate(messageId: string): { allowed: boolean; reason?: string } { return this.registry.canRegenerate(messageId); }
    canDeleteMessage(messageId: string): { allowed: boolean; reason?: string } { return this.registry.canDeleteMessage(messageId); }
    canEdit(messageId: string): { allowed: boolean; reason?: string } { return this.registry.canEdit(messageId); }

    // ================================================================
    // 事件 → SessionRegistry
    // ================================================================

    onEvent(handler: (event: SessionEventEnvelope) => void): () => void { return this.registry.onEvent(handler); }
    onGlobalEvent(handler: (event: RegistryEvent) => void): () => void { return this.registry.onGlobalEvent(handler); }

    // ================================================================
    // 消息操作 → RoundOperations
    // ================================================================

    async sendMessage(
        text: string, files: ChatAttachment[], agentId: string,
        overrides?: ExecutionOverrides, origin?: SessionOrigin, historyPolicy?: HistoryPolicy,
        sendIntent?: SendIntent,
    ): Promise<string> {
        // A Session leased by another host must not be written from here: refuse before the round
        // is appended, so the two hosts cannot race the same durable conversation. `ensureBound()`
        // resolves the same Session the write would target, including a lazy first bind.
        const sessionId = this.registry.ensureBound().sessionId;
        if (this.canWriteSession && !await this.canWriteSession(sessionId)) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID,
                'Session is owned by another host; this host can only read it');
        }
        return this.roundOps.sendMessage(text, files, agentId, overrides, origin, historyPolicy, sendIntent);
    }

    abort(): void { this.roundOps.abort(); }

    async setContextMode(roundIds: string[], mode: 'include' | 'exclude', scope: 'node' | 'subtree' = 'subtree') {
        return this.roundOps.setContextMode(roundIds, mode, scope);
    }

    async getContextModes(roundIds: string[]) {
        return this.roundOps.getContextModes(roundIds);
    }

    async getContextSnapshot(_snapshotId: string) {
        return null;
    }

    async getArtifact(_artifactId: string) {
        return null;
    }

    async previewContext(agentId: string, pendingText = '') {
        const { sessionId } = this.registry.ensureBound();
        const log = new RoundLog(this.registry.engine, sessionId);
        const manifest = await log.loadManifest();
        const branchRef = manifest.currentBranch || 'main';
        const profile = manifest.branchMeta[branchRef]?.contextProfile ?? { id: '', revision: 0 };
        const agent = await this.agentResolver.resolveForChat(agentId);
        const version = agent.agentVersion ?? 'unversioned';
        const assembler = createContextAssembler({
            log,
            profileStore: new ContextProfileStore(this.registry.engine, sessionId),
            readRound: roundId => log.readRound(roundId),
            loadArtifact: async () => null,
        });
        return (await assembler.assemble({
            branchRef,
            branchHead: manifest.branches[branchRef] ?? null,
            profile,
            pendingUserMessage: { role: 'user', content: pendingText || '[pending message]' },
            explicitInputs: [],
            tokenBudget: agent.defaultContextPolicy?.tokenBudget,
        }, 'preview', { id: agent.id, version }, agent.systemPrompt, undefined, { persist: false })).snapshot;
    }

    async regenerate(assistantId: string, options?: RegenerateOptions): Promise<RegenerateResult> {
        return this.roundOps.regenerate(assistantId, options);
    }

    async regenerateFromUser(userMessageId: string, options?: RegenerateOptions): Promise<RegenerateResult> {
        return this.roundOps.regenerateFromUser(userMessageId, options);
    }

    async deleteMessage(messageId: string, options?: DeleteOptions): Promise<DeleteResult> {
        return this.roundOps.deleteMessage(messageId, options);
    }

    async deleteMessages(messageIds: string[], options?: DeleteOptions): Promise<DeleteResult> {
        return this.roundOps.deleteMessages(messageIds, options);
    }

    updateDraft(messageId: string, newContent: string): void {
        this.roundOps.updateDraft(messageId, newContent);
    }

    async commitEdit(messageId: string, newContent: string, autoRerun: boolean = false): Promise<void> {
        return this.roundOps.commitEdit(messageId, newContent, autoRerun);
    }

    // ================================================================
    // 兄弟节点 & 分支 → BranchService
    // ================================================================

    async switchToSibling(messageId: string, siblingIndex: number): Promise<void> {
        return this.branchService.switchToSibling(messageId, siblingIndex);
    }

    async getSiblings(messageId: string): Promise<SessionGroup[]> {
        return this.branchService.getSiblings(messageId);
    }

    async createBranch(branchNodeId: string, options?: { name?: string; copyContent?: boolean }): Promise<string> {
        return this.branchService.createBranch(branchNodeId, options);
    }

    async switchBranch(branchName: string): Promise<void> {
        return this.branchService.switchBranch(branchName);
    }

    async getBranchTree(): Promise<BranchTreeNode> {
        return this.branchService.getBranchTree();
    }

    async renameBranch(oldName: string, newName: string): Promise<void> {
        return this.branchService.renameBranch(oldName, newName);
    }

    async deleteBranch(branchName: string): Promise<void> {
        return this.branchService.deleteBranch(branchName);
    }

    async listBranches(): Promise<Array<{ name: string; headNodeId: string; isCurrent: boolean }>> {
        return this.branchService.listBranches();
    }

    async getBranchMessages(branchHeadNodeId: string): Promise<SessionGroup[]> {
        return this.branchService.getBranchMessages(branchHeadNodeId);
    }

    // ================================================================
    // 会话设置 → Facade
    // ================================================================

    async getSessionSettings(): Promise<ChatSessionSettings> {
        if (!this.registry.boundSessionId) return { ...DEFAULT_SESSION_SETTINGS };
        return this.registry.engine.getSessionSettings(this.registry.boundSessionId);
    }

    async saveSessionSettings(settings: Partial<ChatSessionSettings>): Promise<void> {
        const { sessionId } = this.registry.ensureBound();
        await this.registry.engine.saveSessionSettings(sessionId, settings);
    }

    // ================================================================
    // Agent / 模型查询 → Facade
    // ================================================================

    async getAvailableAgents(): Promise<AgentInfo[]> {
        return this.agentResolver.getAvailableAgents();
    }

    async getModelsForAgent(agentId: string): Promise<ModelInfo[]> {
        return this.agentResolver.getModelsForAgent(agentId);
    }

    // ================================================================
    // 导出 → Facade
    // ================================================================

    exportToMarkdown(): string {
        if (!this.registry.boundSessionId) return '';
        return this.registry.getSessionState(this.registry.boundSessionId)?.exportToMarkdown() || '';
    }

    // ================================================================
    // 配置 → Facade
    // ================================================================

    // ================================================================
    // Prompt History → Facade
    // ================================================================

    async searchHistory(options?: HistoryQueryOptions): Promise<PromptHistoryEntry[]> {
        return this.promptHistory?.search(options) ?? [];
    }

    async getRecentPrompts(count: number = 20): Promise<PromptHistoryEntry[]> {
        return this.promptHistory?.getRecent(count) ?? [];
    }

    async removeFromHistory(text: string): Promise<boolean> {
        return this.promptHistory?.remove(text) ?? false;
    }

    async clearHistory(): Promise<void> {
        await this.promptHistory?.clear();
    }

    async getHistoryCount(): Promise<number> {
        return this.promptHistory?.getCount() ?? 0;
    }

    // ================================================================
    // 生命周期 → Facade
    // ================================================================

    startAutoCleanup(intervalMs: number = CONVERSATION_DEFAULTS.CLEANUP_INTERVAL): () => void {
        const timer = setInterval(() => this.cleanupIdleSessions(), intervalMs);
        return () => clearInterval(timer);
    }

    cleanupIdleSessions(maxIdleTime: number = CONVERSATION_DEFAULTS.SESSION_IDLE_TIMEOUT): number {
        return this.registry.cleanupIdleSessions(maxIdleTime, (id) => this.runs.abort(id));
    }

    destroy(): void {
        this.unbindSession();

        const runningTasks = this.registry.getAllSessions()
            .filter(r => r.status === 'running' || r.status === 'queued');

        if (runningTasks.length > 0) {
            this.registry.eventBus.clearGlobalListeners();
            return;
        }

        this.registry.clearAll(() => this.runs.abortAll());
    }

    debug(): void {
        console.group('[SessionManager] Debug Info');
        console.log('Bound:', this.registry.boundSessionId);
        console.log('Active:', this.registry.activeSessionId);
        const allSessions = this.registry.getAllSessions();
        console.log('Total sessions:', allSessions.length);

        for (const runtime of allSessions) {
            const state = this.registry.getSessionState(runtime.sessionId);
            const flags = [
                runtime.sessionId === this.registry.boundSessionId ? '[BOUND]' : '',
                runtime.sessionId === this.registry.activeSessionId ? '[ACTIVE]' : ''
            ].filter(Boolean).join(' ');

            console.log(
                `  ${runtime.sessionId} ${flags}: status=${runtime.status}, ` +
                `messages=${state?.getSessions().length || 0}, ` +
                `unread=${runtime.unreadCount}`
            );
        }

        console.groupEnd();
    }
}
