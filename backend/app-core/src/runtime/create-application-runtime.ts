import {migrateNotes} from './migrate-notes';
import {createSessionTaskCallAuthority} from '../session/task-call-authority';
import {renewSessionWriteLease} from '../kernel/session-lease';
import {FlowInstallationService} from '../configuration/flow-installation';
import {FlowToolPackages} from '../configuration/flow-tool-packages';
import { createUsageCostEstimator } from '../projects/usage-estimator';
import {createSessionExecutionPreparer} from '../session/prepare-session-execution';
import { applicationStartupPolicy, type ApplicationStartupMode } from './startup-policy';
import { ConversationContexts } from './conversation-contexts';
import { conversationIdle } from './conversation-idle';
import { ConversationViews } from './conversation-views';
import { recoverInstructionQueues } from '../session/instruction-queue-recovery';
import { StartupCoordinator } from './startup-coordinator';
import { SessionLifecycleService } from '../session/session-lifecycle';
import { MCPRemoteConnections } from '../projects/mcp-remote-connections';
import { createNestOSNodeMCPExtension } from '../projects/nestos-node-mcp-extension';
import { ProjectSyncService, type ProjectSyncProvider } from '../projects/sync/service';
import type { Coordinator } from '@itookit/vfs-sync';
import { seedDefaultFlows } from '../presets/default-flows';
import { createAgentFlowAvailability } from '../configuration/agent-flow-availability';
import {createAgentPublicationDependencies} from '../configuration/agent-publications';
import { createAgentCompositionPreparation } from '../configuration/agent-composition';
import { createRemoteExecutionProvider } from '../projects/execution/remote-provider';
import { ProjectExecutionService } from '../projects/execution/service';
import type { ProjectExecutionProvider } from '../projects/execution/contracts';
import { attachProjectDraftRecovery } from './project-draft-recovery';
import { ProjectRemoteMountService, type RemoteFileSourceProvider } from '../projects/remote-mounts';
import { HarnessConnectionService } from '../projects/harness-connections';
import { createHarnessExecutionProvider } from '../projects/harness-execution';
import {createTaskAssetReader} from './task-assets';
import { createHarnessCleanupState } from '../projects/harness-cleanup-state';
import {createHarnessContextCleanup} from '../projects/harness-context-cleanup';
import { FSError } from '@itookit/vfs-core';
import { ModelConfigurationCommands } from '../configuration/model-commands';
import { resumeSessionDeletions } from './resume-session-deletions';
import type { IStorageBackend, MountOptions } from '@itookit/vfs-core';
import type { LLMDeviceDriver, CodexAppServerTransport } from '@itookit/kernel-adapters/llm/core';
import { t, traceBoot, createModuleLogger, randomUUID } from '@itookit/common';
import { type ILLMLogger } from '@itookit/driver-llm/contracts';
import {
    SessionRepository, SessionDirectoryStorageResolver, createInstructionQueueSessions, SessionExecutionActivity,
    VFSAgentService, FlowEngine, FlowDefinitionStore,
} from '@itookit/llm-session';
import { createKernelRuntime, type HeadlessKernelRuntime, type CreateKernelRuntimeOptions } from './create-kernel-runtime';
import { ProjectService } from '../projects/project-service';
import { RunCatalog } from '../run/run-catalog';
import { SessionFilesService } from '../vfs/session-files';
import { DirectoryMountService, type DirectorySourceProvider } from '../vfs/directory-mounts';
import { SessionUnfinishedTasksError } from '../vfs/errors';
import { createSessionAttachmentMounts } from '../vfs/session-attachments';
import { acquireSessionProcessContext, type SessionProcessFactory } from '../vfs/session-process-context';
import { workspaceRoot } from '../session/workspace-paths';
import { SessionLeaseStore, type SessionOwnerKind } from '../kernel/session-lease';
import { recoverSessionsWithLeases } from './session-recovery';
import { createConversationSystem } from './conversation-system';
import { createInfrastructure } from './infrastructure';
import { syncSkillsToKernel } from '../kernel/sync-skills';
import { DigitalTwinService } from '../digital-twin/service';
import { createNativeDigitalTwin } from '../digital-twin/native-service';

export interface ApplicationPlatformServices {
    sessionFiles: SessionFilesService;
    directoryMounts: DirectoryMountService;
}

export interface ApplicationKernelPlatform {
    additionalTools?: CreateKernelRuntimeOptions['additionalTools'];
    scopeForEffect?: CreateKernelRuntimeOptions['scopeForEffect'];
    fileContextForScope?: CreateKernelRuntimeOptions['fileContextForScope'];
    createSessionProcesses?: SessionProcessFactory;
    configureSession?: CreateKernelRuntimeOptions['configureSession'];
    skillSource?: CreateKernelRuntimeOptions['skillSource'];
    skillSourceForSession?: CreateKernelRuntimeOptions['skillSourceForSession'];
    skillToolHandlerFactory?: CreateKernelRuntimeOptions['skillToolHandlerFactory'];
    /** Bind host factories to initialized file grants before any Session recovery. */
    configure?(kernel: HeadlessKernelRuntime, services: ApplicationPlatformServices): void | Promise<void>;
    /** Host reconciliation after acquiring the Session write lease, before recovering tasks. */
    beforeSessionRecovery?(sessionId: string): Promise<void>;
    /**
     * Host-provided isolated workspace manager for chat-embedded Flow runs.
     *
     * Flows whose frozen run policy asks for a non-shared workspace mode need this port; when it
     * is absent the executor fails closed with `requires a configured workspace manager` (the
     * Web host has no workspace channel). See doc/design/flow-execution-model.md.
     */
    flowWorkspaceManager?: import('@itookit/llm-flow').FlowWorkspaceManager;
}

export interface ApplicationRuntime {
    editorSwapStore?: import('@itookit/app-contracts/services').EditorSwapStore;
    /** Trusted host preparation and dispatch; this service is not an RPC contract. */
    independentCalls?: import('@itookit/llm-session').IndependentCallService;
    flowInstallations: import('@itookit/app-contracts/services').FlowInstallations;
    toolPackages: import('@itookit/app-contracts/services').ToolPackages;
    digitalTwin?: DigitalTwinService;
    vfs: import('@itookit/vfs-core').IVFSManager;
    llmDriver: LLMDeviceDriver;
    agentService: VFSAgentService;
    configuration: ModelConfigurationCommands;
    sessionRepository: SessionRepository;
    flowEngine: FlowEngine;
    sessionFiles: SessionFilesService;
    directoryMounts: DirectoryMountService;
    projects: ProjectService;
    executionConnections: HarnessConnectionService;
    projectSync?: ProjectSyncService;
    kernel: HeadlessKernelRuntime;
    sessionManager: import('@itookit/llm-session').SessionManager;
    commandBus: import('@itookit/llm-session').CommandBus;
    runCatalog: RunCatalog;
    createView(): Promise<import('./conversation-system').OwnedConversationView>;
    openConversation(sessionId: string): Promise<import('./conversation-contexts').ConversationLease>;
    startBackground?(): void;
    prepareSession?(sessionId: string): Promise<boolean>;
    dispose(): Promise<void>;
}

export interface ApplicationRuntimeOptions {
    /** The host resolves only trusted, locally available tool packages. */
    toolDependencies?: import('@itookit/app-contracts/services').ToolDependencyResolver;
    /** Interactive hosts activate background tasks after their first workspace is ready. */
    startupMode?: ApplicationStartupMode;
    sync?: { provider: ProjectSyncProvider; coordinator: Coordinator };
    directAgentPolicy?: import('@itookit/llm-session/contracts').DirectAgentPolicy;
    contextEngineOptions?: CreateKernelRuntimeOptions['contextEngineOptions'];
    agentResolution?: import('@itookit/llm-session').AgentResolutionPolicy;
    backend: IStorageBackend;
    /** Host-owned shared configuration and per-user accounting storage. */
    configurationReadonly?: boolean;
    costStorageRoot?: string;
    sharedLlmConfiguration?: boolean;
    additionalMounts?: Array<{ path: string; backend: IStorageBackend; options?: MountOptions }>;
    directorySourceProvider?: DirectorySourceProvider;
    remoteSourceProvider?: RemoteFileSourceProvider;
    projectExecutionProvider?: ProjectExecutionProvider;
    /** Host startup cwd, mounted into newly created Sessions only. */
    defaultSessionDirectory?: string;
    configureSessionFiles?(files: SessionFilesService): void | Promise<void>;
    kernelPlatform?: ApplicationKernelPlatform;
    llmLogger?: ILLMLogger;
    mcp?: import('@itookit/kernel-adapters/llm/core').MCPConnectionOptions;
    codexTransport?: CodexAppServerTransport;
    providerAuthorization?: import('@itookit/kernel-adapters/llm/core').ProviderAuthorizationHost;
    ownerKind?: SessionOwnerKind;
    digitalTwinAutoStart?: boolean;
    /**
     * Stable token identifying this host window/tab for Session write leases. A reload of the
     * same window reuses it and may take over the leases its predecessor still holds, while a
     * second window keeps its own token (default: a fresh random token per runtime).
     */
    sessionOwnerToken?: string;
    /** Explicit cross-host clock-error budget for Session leases (default 0). */
    sessionLeaseSkewMs?: number;
    onProgress?(message: string): void;
}

/** Host-owned system startup. Contains no DOM, routing or editor initialization. */
export async function createApplicationRuntime(options: ApplicationRuntimeOptions): Promise<ApplicationRuntime> {
    const policy = applicationStartupPolicy(options.startupMode);
    const startup = new StartupCoordinator();
    const cleanupFns: Array<() => void | Promise<void>> = [];
    const sourceCleanupFns: Array<() => void | Promise<void>> = [];
    let remoteConnections: ProjectRemoteMountService | undefined;
    const injectedMCP = options.mcp;
    options = { ...options,mcp:{ ...injectedMCP,
        extensions:[...(injectedMCP?.extensions ?? []),...(options.remoteSourceProvider ? [createNestOSNodeMCPExtension()] : [])],
        resolveCredential:injectedMCP?.resolveCredential ?? options.remoteSourceProvider?.resolveCredential?.bind(options.remoteSourceProvider),
        beforeSave:async (server,previous) => { await injectedMCP?.beforeSave?.(server,previous); await remoteConnections?.beforeMCPChange(server,previous); },
        beforeDelete:async id => { await injectedMCP?.beforeDelete?.(id); remoteConnections?.beforeMCPDelete(id); },
        configurationChanged:async () => { await injectedMCP?.configurationChanged?.(); await remoteConnections?.refreshMCPConnections(); },
    } };
    const logStep = (label: string) => { console.log(`[Boot] ${label}`); options.onProgress?.(label); };
    try {
        // ── 1-2. VFS + LLM device driver ───────────────────────────────────────────
        const { vfs, systemFS, llmDriver, logIO, closeCodexTransport } = await createInfrastructure({ ...options, llmInitialization: policy.llm, deviceInitialization: policy.devices, preloadDirectories: [] });
        // The VFS owns every other resource, so it is disposed last.
        sourceCleanupFns.push(() => vfs.dispose());
        if (closeCodexTransport) cleanupFns.push(closeCodexTransport);
        if (policy.mcp === 'before-ready') await traceBoot('mcp.startup', () => llmDriver.waitForMCPStartup());

        // ── 3. Core services ───────────────────────────────────────────────────────

        logStep(t('boot.coreServices'));
        const [agentFiles, flowFiles, homeFiles, promptHistoryFiles] = await traceBoot('core.openFileSystems', () => Promise.all([
            vfs.openFileSystem(workspaceRoot('agents')), vfs.openFileSystem(workspaceRoot('flows')), vfs.openFileSystem('/home/admin'),
            vfs.openFileSystem('/home/admin/.config/nestos/prompt-history'),
        ]));
        await traceBoot('notes.migrate', () => migrateNotes(homeFiles));
        const agentService   = new VFSAgentService(agentFiles, llmDriver, { translate: t, logger: createModuleLogger('llm-conversation'), traceBoot });
        cleanupFns.push(() => agentService.dispose());
        const projectSync = options.sync ? new ProjectSyncService(options.sync.provider, options.sync.coordinator) : undefined;
        if (projectSync) cleanupFns.push(() => projectSync.dispose());
        const configuration = new ModelConfigurationCommands(agentService);
        cleanupFns.push(() => configuration.dispose());
        const sessionRepository     = new SessionRepository(systemFS, async id => {
            if (await projects.initializeSession(id)) return;
            if (!options.defaultSessionDirectory) return;
            if (directoryMounts.getHome()) await directoryMounts.mountHome(id);
            else await directoryMounts.setWorkspace(id, options.defaultSessionDirectory);
        }, createModuleLogger('session-storage'));
        cleanupFns.push(() => sessionRepository.dispose());
        const repositoryReady = startup.task('sessionRepository.init (parallel)', () => sessionRepository.init())();
        const flowEngine     = new FlowEngine(flowFiles);
        await traceBoot('flowEngine.init', () => flowEngine.init());

        // Durable Kernel with application-owned capability injection.
        const ts = performance.now();
        const systemMounts = createSessionAttachmentMounts(sessionRepository);
        cleanupFns.push(() => systemMounts.dispose());
        const sessionFiles: SessionFilesService = new SessionFilesService(systemFS, id => systemMounts.forSession(id),
            // Saved host directories open on first use: mounting a Session must not pay for
            // every bookmark at startup.
            sourceId => directoryMounts.resolveSource(sourceId));
        await traceBoot('sessionFiles.initialize', () => sessionFiles.initialize());
        sessionFiles.registerSource('admin-home', homeFiles);
        await options.configureSessionFiles?.(sessionFiles);
        if (options.directorySourceProvider) cleanupFns.push(() => options.directorySourceProvider!.dispose());
        cleanupFns.push(() => sessionFiles.dispose());
        let mountChanged: (id: string) => Promise<void> = async () => {};
        let mountGuard: (id: string) => Promise<void> = async () => {};
        const directoryMounts: DirectoryMountService = new DirectoryMountService(systemFS, sessionFiles, options.directorySourceProvider,
            id => mountGuard(id), id => mountChanged(id),
            async (id): Promise<string | undefined> => (await projects.forFolder((await sessionRepository.getManifest(id)).folder))?.project.directory);
        cleanupFns.push(() => directoryMounts.dispose());
        const directoryReady = startup.task('directoryMounts.init (parallel)', () => directoryMounts.init())();
        const projects = new ProjectService(systemFS, sessionRepository, directoryMounts, sessionFiles,
            id => prepareDraftExecution(id));
        const prepareDraftExecution = createSessionExecutionPreparer({
            openSession: (...args) => kernel.kernel.openSession(...args),
            createSession: (...args) => kernel.kernel.createSession(...args),
        });
        cleanupFns.push(() => projects.dispose());
        let remoteGuard = async (id: string) => mountGuard(id);
        let initializeRemoteConfiguration: () => Promise<void> = () => Promise.resolve();
        if (options.remoteSourceProvider) {
            const affected = async (projectId: string) => {
                const result: string[] = [];
                const [sessions, folders] = await Promise.all([sessionRepository.listSummaries(), sessionRepository.listFolders()]);
                for (const session of sessions) {
                    if ((await projects.forFolder(session.folder, folders))?.project.id === projectId) result.push(session.id);
                }
                return result;
            };
            const remote = new ProjectRemoteMountService(systemFS, options.remoteSourceProvider,
                async projectId => { for (const id of await affected(projectId)) await remoteGuard(id); },
                async projectId => { for (const id of await affected(projectId)) { await sessionFiles.invalidate(id); await mountChanged(id); } }, new MCPRemoteConnections(agentService,options.remoteSourceProvider));
            remote.estimateUsage = createUsageCostEstimator(() => agentService.getPricingConfig());
            sourceCleanupFns.push(() => remote.dispose());
            await remote.init(true); remoteConnections = remote; projects.remoteMounts = remote;
            initializeRemoteConfiguration = startup.task('remote.configuration', async () => {
                await llmDriver.ensureReady(); await remote.refreshMCPConnections();
            });
            remote.existingProjectIds = () => projects.storedProjectIds();

            configuration.mcpDeletion = remote;
            projects.execution = new ProjectExecutionService(remote,
                options.projectExecutionProvider ?? createRemoteExecutionProvider(sessionFiles, options.remoteSourceProvider));
        }

        projects.navigationFromIndex = policy.navigation === 'index';
        const initializeProjects = startup.task('projects.initialize', async () => {
            await Promise.all([repositoryReady, directoryReady]);
            await initializeRemoteConfiguration();
            await traceBoot('projects.remoteReferences', async () => remoteConnections?.reconcileMCPReferences());
            await traceBoot('projects.sources', () => projects.initializeSources());
            await traceBoot('projects.init', () => projects.ensureStartup(options.defaultSessionDirectory));
        });
        if (policy.projects === 'before-ready') await initializeProjects();
        const executionConnections = new HarnessConnectionService(systemFS, options.remoteSourceProvider ? {
            list: id => remoteConnections?.list(id) ?? [],
            resolveConnection: async id => { await initializeProjects(); return remoteConnections!.resolveConnection(id); },
            projectHarness: async (id, settings) => { await initializeProjects(); return remoteConnections!.projectHarness(id, settings); },
        } : undefined);
        agentService.configureHarnessConnections(id => executionConnections.freeze(id), async () =>
            (await executionConnections.list()).flatMap(record => record.connection ? [record.connection] : []), {
            get: id => executionConnections.get(id), save: (connection, revision) => executionConnections.save(connection, revision),
            remove: (id, revision) => executionConnections.remove(id, revision),
            targets: async () => { await initializeProjects(); return executionConnections.targets(await projects.list()); },
        });
        let harnessKernel: HeadlessKernelRuntime | undefined;
        let ensureExecutionWrite = async (_id: string): Promise<void> => { throw new FSError('ECONFLICT', 'Session ownership is not ready'); };
        let mayCollectContext = (_id: string): boolean => false;
        let digitalTwin: DigitalTwinService | undefined;
        const kernel: HeadlessKernelRuntime = await traceBoot('createKernelRuntime', () => createKernelRuntime({
            harnessExecution: createHarnessExecutionProvider(executionConnections, {
                readTaskAsset: createTaskAssetReader(() => harnessKernel!.kernel, systemFS),
                stateForCleanup: createHarnessCleanupState(() => harnessKernel!.kernel, id => ensureExecutionWrite(id)),
                settleContextForCleanup: createHarnessContextCleanup(() => harnessKernel!.kernel, id => ensureExecutionWrite(id)),
            }),
            systemFS,
            authorizeTaskCall: createSessionTaskCallAuthority({
                assertOwned: id => ensureExecutionWrite(id),
                isDeleting: id => sessionRepository.isSessionDeletionPending(id),
                isMoving: async id => !await projects.sessionMoves.ready(id),
            }),
            contextEngineOptions: options.contextEngineOptions,
            contextGc: { canCollectSession: id => mayCollectContext(id) },
            llmDriver,
            authorizeLlm: (request, context) => digitalTwin?.authorizeLlm(request, context) ?? Promise.resolve(),
            authorizeMedia: (request, context) => digitalTwin?.authorizeMedia(request, context) ?? Promise.resolve(),
            storageResolver: new SessionDirectoryStorageResolver(systemFS),
            maxConcurrent: 20,
            fileContextForSession: async id => {
                const project = await projects.forFolder((await sessionRepository.getManifest(id)).folder);
                const execution = project && await projects.execution?.acquire(project.project.id, id);
                if (execution) return execution;
                const remote = project && (projects.fileSource(project).kind === 'remote' || projects.remoteMounts?.list(project.project.id).length);
                return acquireSessionProcessContext(sessionFiles, id, remote ? undefined : options.kernelPlatform?.createSessionProcesses,
                    () => directoryMounts.processMounts(id));
            },
            configureSession: options.kernelPlatform?.configureSession,
            additionalTools: options.kernelPlatform?.additionalTools,
            scopeForEffect: options.kernelPlatform?.scopeForEffect,
            fileContextForScope: options.kernelPlatform?.fileContextForScope || options.projectExecutionProvider || options.remoteSourceProvider?.process ? async (id, scopeId) => {
                const project = await projects.forFolder((await sessionRepository.getManifest(id)).folder);
                const execution = project && await projects.execution?.acquire(project.project.id, id, scopeId);
                if (execution) return execution;
                if (project && (projects.fileSource(project).kind === 'remote' || projects.remoteMounts?.list(project.project.id).length))
                    throw new FSError('ECAPABILITY', 'Remote server does not provide command execution');
                if (!options.kernelPlatform?.fileContextForScope) throw new FSError('ECAPABILITY', 'Workspace scope provider is unavailable');
                return options.kernelPlatform.fileContextForScope(id, scopeId);
            } : undefined,
            skillSource: options.kernelPlatform?.skillSource,
            skillSourceForSession: options.kernelPlatform?.skillSourceForSession,
            skillToolHandlerFactory: options.kernelPlatform?.skillToolHandlerFactory,
            beforeRecover: async runtime => {
                harnessKernel = runtime;
                await directoryReady;
                mountChanged = id => runtime.disposeSession(id);
                mountGuard = async id => {
                    let exists = false;
                    for await (const session of runtime.kernel.listSessions()) if (session.id === id) { exists = true; break; }
                    if (exists && (await runtime.kernel.listSessionTasks(id)).some(task => !['succeeded', 'failed', 'cancelled'].includes(task.status))) {
                        throw new SessionUnfinishedTasksError(id);
                    }
                };

                await options.kernelPlatform?.configure?.(runtime, { sessionFiles, directoryMounts });
            },
            // Recover Sessions only after this host acquires their lease.
            recover: false,
        }));
        const kernelCore = kernel.kernel;
        agentService.configurePublicationDependencies(createAgentPublicationDependencies(new FlowDefinitionStore(flowEngine, kernel.dagPlugins), kernel.dagPlugins));
        agentService.configureFlowAvailability(createAgentFlowAvailability(flowEngine, new FlowDefinitionStore(flowEngine, kernel.dagPlugins), kernel.dagPlugins));
        agentService.configureAgentPreparation(createAgentCompositionPreparation(new FlowDefinitionStore(flowEngine, kernel.dagPlugins), agentService, flowEngine));
        const skillsReady = traceBoot(policy.skills === 'before-ready' ? 'syncSkillsToKernel' : 'syncSkillsToKernel (background)', () => syncSkillsToKernel(llmDriver, kernel));
        void skillsReady.catch(error => console.warn('[Boot] Skill initialization failed', error));

        digitalTwin = createNativeDigitalTwin(systemFS, sessionRepository, kernelCore, agentService, options.ownerKind ?? 'tauri', projects);
        const leaseStore = new SessionLeaseStore(systemFS, {
            ...(options.sessionLeaseSkewMs ? { skewMs: options.sessionLeaseSkewMs } : {}),
        });
        const ownerToken = options.sessionOwnerToken ?? randomUUID();
        const ownerId = `${options.ownerKind ?? "tauri"}-${ownerToken}`;
        await repositoryReady;
        const excluded = await traceBoot('resumeSessionDeletions',
            () => resumeSessionDeletions(sessionRepository, kernelCore, leaseStore, { id: ownerId, kind: options.ownerKind ?? 'tauri' }));
        for (const id of await sessionRepository.pendingStorageSessionIds()) excluded.add(id);
        // Boot recovery runs one callback per Session; accumulate them so the log attributes
        // the untraced part of createKernel to a concrete callback instead of leaving a gap.
        const observed: Record<string, number> = {};
        const recovery = await traceBoot('recoverSessionsWithLeases', () => recoverSessionsWithLeases(kernelCore, leaseStore,
            { id: ownerId, kind: options.ownerKind ?? 'tauri' }, 10_000, async (id, ensureLeases) => {
                await initializeProjects();
                await skillsReady;
                if (!id.startsWith('twin-analysis-')) await measureCallbacks(observed, 'adoptSession', () => projects.adoptSession(id, folder => sessionRepository.reconcileFolder(id, folder, ensureLeases)));
                if (!id.startsWith('twin-analysis-')) await measureCallbacks(observed, 'platformBeforeRecovery', async () => options.kernelPlatform?.beforeSessionRecovery?.(id));
                await measureCallbacks(observed, 'contextGcObserve', async () => { await kernel.contextGc?.observeSession(id); });
            }, excluded, 'deferred')).catch(async error => {
                kernelCore.dispose();
                const errors: unknown[] = [error];
                for (const close of [() => kernelCore.waitIdle(), () => kernel.dispose()]) {
                    try { await close(); } catch (cleanup) { errors.push(cleanup); }
                }
                if (errors.length > 1) throw new AggregateError(errors, 'Application recovery and kernel cleanup failed');
                throw error;
            });
        sessionRepository.setStructuralWriteGuard(async ids => {
            for (const id of ids) if (!await recovery.acquireMetadataLease(id)) throw new Error(`Session is owned by another host: ${id}`);
        });
        remoteGuard = async id => {
            if (!await recovery.acquireMetadataLease(id)) throw new Error(`Session is owned by another host: ${id}`);
            await mountGuard(id);
        };
        ensureExecutionWrite = id => renewSessionWriteLease(id, recovery.leases, lease => leaseStore.renew(lease));
        mayCollectContext = id => (recovery.leases.get(id)?.leaseUntil ?? 0) > Date.now();
        cleanupFns.push(() => kernel.dispose());
        cleanupFns.push(async () => {
            const errors: unknown[] = [];
            try {await recovery.release();} catch (error) {errors.push(error);}
            kernelCore.dispose();
            try {await kernelCore.waitIdle();} catch (error) {errors.push(error);}
            if (errors.length) throw new AggregateError(errors, 'Session recovery and Kernel shutdown failed');
        });
        cleanupFns.push(() => skillsReady.catch(() => {}));
        cleanupFns.push(() => digitalTwin!.dispose());
        if (policy.skills === 'before-ready') await skillsReady;
        await traceBoot('projects.resumeSessionMoves', () => projects.sessionMoves.recoverPending(id => recovery.acquireMetadataLease(id)));
        if (Object.keys(observed).length) console.log(`[Boot]   ↳ beforeRecover totals: ${formatTimings(observed)}`);
        console.log(`[Boot]   ↳ createKernel: +${(performance.now() - ts).toFixed(0)}ms`);

        // Inject VFS context so file tools work with the virtual filesystem in browser.
        // When node:fs is unavailable, tools fall back to ctx.vfs (ToolVFSContext).
        // File contexts are installed independently in each Session scope before recovery.

        // Keep skills in sync when the user adds / edits / deletes skills in Settings.
        // The initial sync happens before Kernel recovery so restored Skill identities resolve.
        cleanupFns.push(
            llmDriver.onChange(() => {
                // A dropped sync leaves Skills stale in the Kernel; surface it instead of
                // letting the next Agent run silently miss a Skill change.
                syncSkillsToKernel(llmDriver, kernel).catch(error => console.warn('[Skills] sync failed', error));
            })
        );

        logIO('core services');

        logStep(t('boot.llmEngine'));
        // Writes are only allowed while this host holds the Session's single-writer lease; the
        // gate acquires a lease on demand so a freshly created Session is writable immediately.
        const instructionQueueSessions = createInstructionQueueSessions(systemFS);
        const prepareChildExecution = createSessionExecutionPreparer(kernel.kernel, id => recovery.acquireMetadataLease(id));
        const executionActivity = new SessionExecutionActivity();
        cleanupFns.push(() => executionActivity.dispose());
        let flowInstallations: FlowInstallationService | undefined;
        let independentContexts: ConversationContexts | undefined;
        const conversationOptions = {
                projects,
                submitIndependentCall: async request => {
                    if (!independentContexts || !request.expectedSessionId) throw new Error('Independent call host is not ready');
                    const context = await independentContexts.open(request.expectedSessionId);
                    try {return await context.commandBus.execute<string>('session.submit', request);}
                    finally {await context.dispose();}
                },
                executionConnections,
                prepareSessionExecution: prepareChildExecution,
                ensureFlowDependencies: async (id: string) => {await flowInstallations?.ensure(id);}, executionActivity, instructionQueueSessions, vfs, systemFS, promptHistoryFiles, directAgentPolicy: options.directAgentPolicy, agentResolution: options.agentResolution, agentService, sessionRepository, flowEngine, kernel,
                digitalTwin,
                scheduleAgentInitialization: run => startup.schedule(policy.agents, 'agents.initialize', run),
                scheduleInvocationRecovery: run => startup.schedule(policy.invocations, 'invocations.recover', async () => { await initializeProjects(); await run(); }),
                ensureWritable: async sessionId => !await sessionRepository.isSessionDeletionPending(sessionId)
                    && await recovery.acquireLater(sessionId) && await projects.sessionMoves.ready(sessionId),
                flowWorkspaceManager: options.kernelPlatform?.flowWorkspaceManager } satisfies import('./conversation-system').ConversationSystemOptions;
        const { sessionManager, commandBus, independentCalls, dispose: disposeConversations } = await traceBoot('initializeConversationSystem',
            () => createConversationSystem(conversationOptions));
        flowInstallations = new FlowInstallationService(commandBus, new FlowToolPackages(kernel.toolCatalog, options.toolDependencies));
        const installations = flowInstallations;
        cleanupFns.push(() => installations.close());
        const conversationViews = new ConversationViews();
        cleanupFns.push(() => conversationViews.close());
        const createConversationView = async () => {
            const context = await createConversationSystem({ ...conversationOptions,
                independentCalls, scheduleAgentInitialization: initialize => initialize(), scheduleInvocationRecovery: () => {} });
            try { return conversationViews.own(context, await attachProjectDraftRecovery(projects.drafts, context.sessionManager, false)); }
            catch (error) { await context.dispose(); throw error; }
        };
        const conversationContexts = new ConversationContexts(() => startup.task('host.conversation', createConversationView)(),
            id => recovery.acquireMetadataLease(id), { canRelease: id => conversationIdle(kernel.kernel, id) });
        independentContexts = conversationContexts;
        cleanupFns.push(disposeConversations);
        cleanupFns.push(() => conversationContexts.close());
        await startup.schedule(policy.invocations, 'instructions.recover', async () => {
            await initializeProjects();
            await recoverInstructionQueues(instructionQueueSessions, kernel.kernel, conversationContexts);
        });

        const acquireSessionLease = (sessionId: string): Promise<boolean> => recovery.acquireLater(sessionId);
        const unsubscribeSessionLease = sessionManager.onGlobalEvent(event => {
            if (event.type === 'session_registered') void acquireSessionLease(event.payload.sessionId)
                .catch(error => console.warn(`[Shell] Session ${event.payload.sessionId} recovery failed; writes remain blocked`, error));
        });
        cleanupFns.push(unsubscribeSessionLease);
        cleanupFns.push(await attachProjectDraftRecovery(projects.drafts, sessionManager, false));
        await startup.schedule(policy.drafts, 'projects.drafts.recover', async () => { await initializeProjects(); await projects.drafts.recover(); });

        // Seed the default essay-review workflow so users have a runnable example.
        await traceBoot('seedDefaultFlows', () => seedDefaultFlows(new FlowDefinitionStore(flowEngine, kernel.dagPlugins), id => installations.ensure(id)));

        const runCatalog = new RunCatalog(sessionRepository, kernel.kernel);
        if (remoteConnections) {
            const lifecycle = new SessionLifecycleService({repository:sessionRepository,kernel:kernel.kernel});
            remoteConnections.inspectRemoteProjects = ids => projects.inspectRemoteProjectRemoval(ids);
            remoteConnections.removeRemoteProjects = async ids => {
                for (const id of ids) await projects.removeRemoteProjectRecord(id,path => lifecycle.deleteFolder(path,true));
            };
        }

        let disposed = false;
        const dispose = async () => {
            if (disposed) return;
            disposed = true;
            await startup.close();
            await executionActivity.dispose();
            const errors: unknown[] = [];
            for (const close of [...cleanupFns].reverse().concat([...sourceCleanupFns].reverse())) {
                try { await close(); } catch (error) { errors.push(error); }
            }
            if (errors.length) throw new AggregateError(errors, 'Application runtime cleanup failed');
        };
        await startup.schedule(policy.workers, 'runtime.workers', async () => {
            await initializeProjects();
            if (!startup.active) return;
            recovery.startBackground();
            if (options.digitalTwinAutoStart !== false) digitalTwin!.start();
        });
        const startBackground = () => startup.activate();
        if (policy.projects === 'before-ready') startBackground();
        return { vfs, llmDriver, agentService, configuration, sessionRepository, flowEngine, sessionFiles, directoryMounts, projects, executionConnections,
            flowInstallations: installations, toolPackages: installations.toolPackages, kernel, sessionManager, commandBus, independentCalls, runCatalog, dispose, startBackground, prepareSession: async id => { await initializeProjects(); return recovery.acquireLater(id); },
            projectSync, digitalTwin, createView: createConversationView, openConversation: id => conversationContexts.open(id) };
    } catch (error) {
        await startup.close();
        for (const close of [...cleanupFns].reverse().concat([...sourceCleanupFns].reverse())) {
            try { await close(); } catch (cleanupError) { console.error('[Boot] Cleanup failed', cleanupError); }
        }
        throw error;
    }
}

/** Time one per-Session recovery callback and add it to the boot breakdown. */
async function measureCallbacks(timings: Record<string, number>, key: string, run: () => Promise<unknown>): Promise<void> {
    const started = performance.now();
    try { await run(); }
    finally { timings[key] = (timings[key] ?? 0) + (performance.now() - started); }
}

function formatTimings(timings: Record<string, number>): string {
    return Object.entries(timings).map(([key, ms]) => `${key}=${ms.toFixed(0)}ms`).join(' ');
}
