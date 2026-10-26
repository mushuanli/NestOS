import {prepareBranchSubmission} from './branch-submission';
import { snapshotDirectAgentPolicy, type ResolvedDirectAgentPolicy } from '../contracts/direct-agent-policy';
import { restoreFlowHistory } from '../persistence/restore-flow-history';
import {assertSubmissionBinding, submissionInstruction} from './submission-input';
import {readSubmissionReceipt} from './submission-receipt';
import {assertContextBindingQuery, type ContextBindingReader, type ContextBindingQuery} from '../contracts/context-bindings';
import {assertContextOptionsQuery} from '../contracts/context-options';
import {ulid} from '../persistence/ulid';
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
import {FlowDefinitionStore} from '@itookit/llm-flow';
import {RootTargetDirectory} from './root-target-catalog';
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
import { SessionInstructions } from './session-instructions';
import type { InstructionQueueEdit } from '../contracts/instruction-queue';
import { SessionExecutionActivity } from './session-execution-activity';

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
    private readonly instructions: SessionInstructions;
    private readonly ownedExecutionActivity?: SessionExecutionActivity;
    private agentResolver: AgentResolver;
    private readonly kernel: Kernel;
    private readonly artifactLoader?: import('../contracts/artifacts').ArtifactLoader;
    private readonly contextBindingReader?: ContextBindingReader;
    private readonly contextOptionsReader?: import('../contracts/context-options').ContextOptionsReader;
    private readonly canWriteSession?: (sessionId: string) => Promise<boolean>;
    private readonly flowRerun: FlowRerunService;
    private readonly durableProjection: DurableConversationProjection;
    private durableSession?: SessionHandle;
    private durableProjectionUnsubscribe?: () => void;
    private projectionSyncTail?: Promise<void>;
    private projectionSyncQueued = false;

    private readonly directAgentPolicy: ResolvedDirectAgentPolicy;
    private readonly callTargets: RootTargetDirectory;

    getDirectAgentPolicy(): ResolvedDirectAgentPolicy { return this.directAgentPolicy; }

    constructor(
        engine: ISessionRepository,
        agentService: IAgentConfigService,
        options: {
            executionActivity?: SessionExecutionActivity;
            loadArtifact?: import('../contracts/artifacts').ArtifactLoader;
            readContextBindings?: ContextBindingReader;
            readContextOptions?: import('../contracts/context-options').ContextOptionsReader;
            validateCallAssets?: import('../contracts/submission').CallAssetValidator;
            instructionQueueSessions?: import('../persistence/instruction-queue-sessions').InstructionQueueSessions;
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
        this.callTargets = new RootTargetDirectory(agentService, this.agentResolver, new FlowDefinitionStore(options.flowStore, options.dagPlugins), this.host, options.dagPlugins);
        const attachments = new AttachmentProcessor(engine, this.host.logger);

        if (!options?.kernel) throw new Error('SessionManager requires Kernel');
        this.kernel = options.kernel;
        this.artifactLoader = options.loadArtifact;
        this.contextBindingReader = options.readContextBindings;
        this.contextOptionsReader = options.readContextOptions;
        this.memory = new SessionMemoryControls(options.memoryProvider ?? new SessionMemoryProvider(this.kernel), agentService,
            () => this.registry.ensureBound().sessionId, options.canWriteSession);
        this.durableProjection = new DurableConversationProjection(engine);
        const executionActivity = options.executionActivity ?? new SessionExecutionActivity();
        if (!options.executionActivity) this.ownedExecutionActivity = executionActivity;
        this.runs = new SessionRunCoordinator(
            engine,
            this.registry.eventBus,
            this.agentResolver,
            attachments,
            {
                validateCallAssets: options.validateCallAssets,
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
            executionActivity,
            options.loadArtifact,
        );

        this.roundOps = new RoundOperations(this.registry, this.runs, this.promptHistory);
        this.instructions = new SessionInstructions(this.registry, this.runs, this.roundOps, this.kernel,
            this.canWriteSession, options.instructionQueueSessions, executionActivity);
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
                this.sendMessage(s.text, (s.attachments ?? []).map(a => ({
                    name: a.name ?? a.filename ?? '',
                    type: a.type ?? 'file',
                    size: a.size,
                })), 'default', undefined, undefined, undefined).catch(e => {
                    this.registry.eventBus.emitSession(this.registry.boundSessionId ?? '', { type: 'error', error: { message: String(e) } });
                });
                break;
            case 'abort':
                this.abort();
                break;
            case 'inject':
                this.sendMessage(s.text, [], 'default', undefined, 'inject', undefined).catch(() => {});
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
        await this.registry.bindSession(sessionId);
        await this.bindDurableProjection(sessionId);
        await this.instructions.restore(sessionId);
        // Hand the projection loaded with the binding to the caller so the editor does not read
        // the Session record a second time.
        return { ...this.getSnapshot(), view: this.registry.getLoadedView(sessionId) };
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

    getFlowRerunContext(sourceRoundId?: string) { return this.flowRerun.context(sourceRoundId); }

    async rerunFlow(parameters: Record<string, JsonValue>, sourceRoundId: string | null, expectedSessionId?: string, expectedDefinitionKey?: string, connectionId?: string, connectionBindings?: Record<string, string>, sourceSelection?: 'selected') {
        const sessionId = this.registry.ensureBound().sessionId;
        if (this.canWriteSession && !await this.canWriteSession(sessionId)) {
            throw new ConversationError(ConversationErrorCode.SESSION_INVALID,
                'Session is owned by another host; this host can only read it');
        }
        if (this.registry.ensureBound().sessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        if (expectedSessionId && expectedSessionId !== sessionId) throw new Error('Session changed; reopen the rerun form');
        return this.flowRerun.run(parameters, sourceRoundId, expectedDefinitionKey, connectionId, connectionBindings, sourceSelection);
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
        this.durableProjectionUnsubscribe = this.registry.eventBus.onSession(sessionId, event => {
            // Queue observers do not own the running context's durable conversation projection.
            if (event.type === 'instructions:changed') return;
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

    getSnapshot(): SessionSnapshot {
        const snapshot = this.registry.getSnapshot();
        const isRunning = snapshot.isRunning || this.runs.isActive(snapshot.sessionId);
        return { ...snapshot, isRunning, status: isRunning && !snapshot.isRunning ? 'running' : snapshot.status,
            instructionQueue: this.instructions.snapshot(snapshot.sessionId) };
    }
    /** Refresh an already open child after a host-owned invocation commits its result. */
    async refreshCommittedHistory(sessionId: string): Promise<void> {
        this.instructions.queues.wake(sessionId);
        if (this.registry.boundSessionId !== sessionId || this.runs.isActive(sessionId)) return;
        const state = this.registry.getSessionState(sessionId); if (!state) return;
        const started = Date.now();
        try {
            await this.registry.reloadSessionData(sessionId, state);
            this.host.logger.info('Committed invocation history displayed', {operation: 'call.history.display',
                sessionId, stage: 'reload', outcome: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            try {this.host.logger.warn('Committed invocation history refresh failed', {operation: 'call.history.display',
                sessionId, stage: 'reload', outcome: 'failure', durationMs: Date.now() - started,
                errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_HISTORY_DISPLAY_FAILED'});}
            catch { /* Display diagnostics cannot invalidate committed history. */ }
        }
    }
    getInstructionQueue() { return this.instructions.queues.view(this.registry.ensureBound().sessionId); }
    hasPendingInstructions(): boolean { return this.instructions.hasPending(); }
    setIndependentCallScope(read: (sessionId: string) => Promise<Set<string>>, ready: (sessionId: string) => Promise<boolean>): void {
        this.instructions.backgroundCallers = read; this.instructions.callInputReady = ready;
    }
    waitForInstructionWrites(): Promise<void> { return this.instructions.whenIdle(); }
    editInstructionQueue(edit: InstructionQueueEdit) { return this.instructions.edit(this.registry.ensureBound().sessionId, edit); }
    getSessions(): SessionGroup[] { return this.registry.getSessions(); }
    getCurrentSessionId(): string | null { return this.registry.getCurrentSessionId(); }
    getStatus(): SessionStatus | 'unbound' { return this.registry.getStatus(); }
    isGenerating(): boolean { return this.registry.isGenerating() || this.runs.isActive(this.id); }
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
        return this.instructions.send({ sessionId, text, files: files ?? [], agentId, overrides, origin, historyPolicy, sendIntent });
    }

    async prepareBranchSubmission(request: import('../contracts/submission').SubmissionRequest): Promise<import('../contracts/submission').SubmissionRequest> {
        const {sessionId} = this.registry.ensureBound(), started = Date.now();
        assertSubmissionBinding(request, sessionId); await this.assertPreparationWritable(sessionId);
        this.registry.ensureNotGenerating('prepare anchored branch');
        try {const prepared = await prepareBranchSubmission(this.registry.engine, request);
            this.host.logger.info('Anchored branch prepared', {operationId: request.submission?.id, sessionId, stage: 'branch-prepare', result: 'success',
                role: request.branchFrom?.role, userMessageCount: prepared.overrides?.userMessagePrefix?.length ?? 0, durationMs: Date.now() - started});
            return prepared;
        } catch (error) {this.host.logger.warn('Anchored branch rejected', {operationId: request.submission?.id, sessionId, stage: 'branch-prepare', result: 'failure',
            code: (error as {code?: string})?.code ?? 'BRANCH_PREPARATION_FAILED', durationMs: Date.now() - started}); throw error;}
    }

    async submit(request: import('../contracts/submission').SubmissionRequest): Promise<string> {
        const supplied = request?.submission?.id, started = Date.now();
        const operationId = typeof supplied === 'string' && /^[\w-]{1,128}$/.test(supplied) ? supplied : ulid();
        let stage = 'input';
        this.host.logger.debug('Call submission started', {operation: 'call.submit', operationId, stage, result: 'start'});
        try {
            const input = submissionInstruction(request);
            stage = 'binding';
            const sessionId = this.registry.ensureBound().sessionId;
            assertSubmissionBinding(request, sessionId);
            input.sendIntent!.submission ??= {id: operationId, source: {kind: 'conversation', ownerId: sessionId, id: operationId}};
            stage = 'admission';
            const id = await this.instructions.send({...input, sessionId});
            this.host.logger.info('Call submission accepted', {operation: 'call.submit', operationId, sessionId, stage,
                result: 'accepted', targetKind: input.target?.kind, targetId: input.target?.id,
                inputSource: input.source?.kind, attachmentCount: input.files.length, durationMs: Date.now() - started});
            return id;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            this.host.logger.warn('Call submission rejected', {operation: 'call.submit', operationId, stage, result: 'failure',
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'SUBMISSION_FAILED',
                errorClass: error instanceof Error ? error.name : typeof error, durationMs: Date.now() - started});
            throw error;
        }
    }

    listCallTargets(): Promise<import('../contracts/submission').RootTargetCatalog> {return this.callTargets.list();}

    /** Trusted host preparation only; explicit child identity never rebinds this manager's view. */
    async prepareIndependentTaskCall(supplied: import('../contracts/submission').SubmissionRequest,
        suppliedInvocation: import('@itookit/llm-flow/contracts').InvocationIdentity) {
        const safe = (value: unknown) => typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;
        const identity = {operationId: safe(supplied?.submission?.id), sessionId: safe(supplied?.expectedSessionId)};
        const started = Date.now(); let stage = 'input', errorCode: string | undefined;
        try {
            const request = structuredClone(supplied), invocation = structuredClone(suppliedInvocation), sessionId = request?.expectedSessionId;
            if (!sessionId) throw Object.assign(new Error('Independent preparation requires a child Session'), {code: 'CALL_PREPARATION_SCOPE_MISMATCH'});
            stage = 'permission'; await this.assertPreparationWritable(sessionId);
            stage = 'published-target'; const prepared = await this.runs.prepareIndependentTaskCall(request, invocation);
            stage = 'permission'; await this.assertPreparationWritable(sessionId); return prepared;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            errorCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_PREPARATION_FAILED'; throw error;
        } finally {
            const detail = {operation: 'session.call.prepare', stage, outcome: errorCode ? 'failure' : 'success', errorCode,
                ...identity, durationMs: Date.now() - started};
            try {if (errorCode) this.host.logger.warn('Published call preparation', detail); else this.host.logger.info('Published call preparation', detail);}
            catch { /* Diagnostic failures cannot replace prepared data or the original rejection. */ }
        }
    }

    private async assertPreparationWritable(sessionId: string): Promise<void> {
        if (this.canWriteSession && !await this.canWriteSession(sessionId))
            throw Object.assign(new Error('Independent preparation requires the child writer'), {code: 'CALL_READ_ONLY'});
    }

    async getContextBindings(supplied: ContextBindingQuery): Promise<import('../contracts/context-bindings').ContextBindingPage> {
        assertContextBindingQuery(supplied); const query = structuredClone(supplied);
        const manifest = await this.registry.engine.getManifest(query.sessionId);
        if (query.branchId !== undefined && !Object.hasOwn(manifest.branches, query.branchId))
            throw Object.assign(new Error('Context query branch does not exist'), {code: 'CONTEXT_QUERY_BRANCH_INVALID'});
        if (!this.contextBindingReader) throw Object.assign(new Error('Context binding queries are unavailable'), {code: 'CONTEXT_QUERY_UNSUPPORTED'});
        return this.contextBindingReader(query);
    }

    async getContextOptions(supplied: import('../contracts/context-options').ContextOptionsQuery): Promise<import('../contracts/context-options').ContextOptionsPage> {
        const started = Date.now(), operationId = ulid(); let stage = 'input';
        try {
            assertContextOptionsQuery(supplied); const query = structuredClone(supplied);
            stage = 'destination'; const manifest = await this.registry.engine.getManifest(query.sessionId);
            if (!Object.hasOwn(manifest.branches, query.branchId))
                throw Object.assign(new Error('Context destination branch does not exist'), {code: 'CONTEXT_QUERY_BRANCH_INVALID'});
            if (!this.contextOptionsReader) throw Object.assign(new Error('Context option queries are unavailable'), {code: 'CONTEXT_OPTIONS_UNSUPPORTED'});
            stage = 'lookup'; return await this.contextOptionsReader(query);
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            this.host.logger.warn('Context options query rejected', {operation: 'session.context.options', operationId, stage,
                result: 'failure', code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONTEXT_OPTIONS_FAILED',
                durationMs: Date.now() - started});
            throw error;
        }
    }

    getSubmissionReceipt(request: import('../contracts/submission').SubmissionRequest): Promise<import('../contracts/submission').SubmissionReceipt> {
        return this.observeSubmissionReceipt(request, () => this.registry.ensureBound().sessionId);
    }

    inspectSubmissionReceipt(request: import('../contracts/submission').SubmissionRequest): Promise<import('../contracts/submission').SubmissionReceipt> {
        return this.observeSubmissionReceipt(request, () => {
            if (!request.expectedSessionId) throw Object.assign(new Error('Read-only inspection requires an expected Session identity'), {code: 'SUBMISSION_INVALID'});
            return request.expectedSessionId;
        });
    }

    private async observeSubmissionReceipt(request: import('../contracts/submission').SubmissionRequest, resolveSession: () => string): Promise<import('../contracts/submission').SubmissionReceipt> {
        const started = Date.now(), supplied = request?.submission?.id;
        const operationId = typeof supplied === 'string' && /^[\w-]{1,128}$/.test(supplied) ? supplied : ulid();
        let stage = 'input', sessionId: string | undefined;
        try {
            const input = submissionInstruction(request);
            if (!input.sendIntent?.submission) throw Object.assign(new Error('Submission observation requires an existing identity'), {code: 'SUBMISSION_INVALID'});
            stage = 'binding'; sessionId = resolveSession();
            assertSubmissionBinding(request, sessionId);
            stage = 'lookup';
            const receipt = await readSubmissionReceipt(this.kernel, this.registry.engine, sessionId, input);
            this.host.logger.info('Call admission reconciled', {operation: 'call.receipt', operationId, sessionId, stage,
                result: receipt.status, evidence: receipt.evidence, durationMs: Date.now() - started});
            return receipt;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            this.host.logger.warn('Call admission lookup failed', {operation: 'call.receipt', operationId,
                sessionId, stage, result: 'failure', code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'SUBMISSION_RECEIPT_READ_FAILED',
                durationMs: Date.now() - started}); throw error;
        }
    }

    async hasCommittedSubmission(input: {sessionId: string; submission: import('@itookit/llm-flow/contracts').SessionSubmission}): Promise<boolean> {
        if (input?.sessionId !== this.registry.ensureBound().sessionId || !input.submission
            || !/^[\w-]{1,128}$/.test(input.submission.id) || !input.submission.source)
            throw Object.assign(new Error('Invalid submission observation binding'), {code: 'SUBMISSION_INVALID'});
        return this.instructions.committed(input.sessionId, input.submission);
    }

    abort(): void {
        const id = this.registry.getCurrentSessionId();
        if (!id) return;
        void this.instructions.pause(id).catch(error => {
            this.host.logger.warn('Instruction queue pause failed', { operation: 'session.instructions', stage: 'stop',
                outcome: 'failure', sessionId: id, code: (error as {code?: string})?.code ?? 'QUEUE_PAUSE' });
        });
        this.runs.abort(id);
    }

    async setContextMode(roundIds: string[], mode: 'include' | 'exclude', scope: 'node' | 'subtree' = 'subtree') {
        return this.roundOps.setContextMode(roundIds, mode, scope);
    }

    async getContextModes(roundIds: string[]) {
        return this.roundOps.getContextModes(roundIds);
    }

    async getContextSnapshot(_snapshotId: string) {
        return null;
    }

    async getArtifact(artifactId: string) {
        return this.readSessionArtifact(this.registry.ensureBound().sessionId, artifactId);
    }

    private readSessionArtifact(sessionId: string, artifactId: string) {
        if (!this.artifactLoader) throw Object.assign(new Error('Artifact reader is unavailable'), {code: 'ARTIFACT_READER_UNAVAILABLE'});
        return this.artifactLoader(sessionId, artifactId);
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
            readRound: roundId => log.readRound(roundId, branchRef, manifest),
            loadArtifact: id => this.readSessionArtifact(sessionId, id),
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

    async createBranch(branchNodeId: string, options?: { name?: string }): Promise<string> {
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

    async getBranchMessages(branchHeadNodeId: string, branchName?: string): Promise<SessionGroup[]> {
        return this.branchService.getBranchMessages(branchHeadNodeId, branchName);
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
        this.instructions.dispose();
        void this.ownedExecutionActivity?.dispose();
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
