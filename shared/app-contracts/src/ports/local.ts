/** Shared application capabilities; implementations belong to backend/app-core. */
import type { IFileSystem, IVFSManager } from '@itookit/vfs-core';
import type * as HarnessContracts from '@itookit/piagent-driver';
import type { HarnessObservation } from '@itookit/piagent-driver';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import type { ILLMService } from '@itookit/driver-llm/contracts';
import type * as ConfigurationContracts from '@itookit/kernel-adapters/contracts';
import type { IConnectionService, IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import type { ISessionRepository, SessionFolder, IAgentConfigService } from '@itookit/llm-session/contracts';
import type { TaskRecord } from '@itookit/durable-kernel/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { SystemPromptDefinition } from '@itookit/llm-tasks/contracts';
import type { SnapshotPort, WorkspaceFileSource, SettingsPort } from '@itookit/app-contracts/settings';
import type { ToolboxKind } from '../index';
import type { SessionCapabilityRegistry } from '@itookit/kernel-adapters/contracts';
import type { SessionSkillControls, IToolService } from '@itookit/tools/contracts';
import type { TaskStat } from '@itookit/durable-kernel/contracts';
import type { SessionManagementPort } from '@itookit/llm-session/contracts';
import type { DigitalTwinService } from './digital-twin';
import type { ToolboxResources, ToolboxInventory, OcrService, ModelConfigurationCommands, Catalog } from './configuration';
import type { RemoteHarnessAgent, ProjectSessions, ProjectService, ProjectSearch, listRemoteHarnessAgents, remoteSessionSources, manageRemoteSession, resolveProjectFavorite, exportRemoteSession } from './projects';
import type { SessionFilesService, DirectoryMountService } from './files';
import type { SessionLifecycleService, taskKeyEvent, taskSummary, exportSessionBundle, WorkbenchArchiveImporter, WorkbenchArchiveExporter, SessionLifecycleOptions, SessionLifecycleDependencies, createSessionBrowser, SessionOrganizationStore, PrivilegedCommandService, MindosInitialFiles } from './session';
import type { ProjectSyncService } from './sync';

export interface LocalApplicationServices {
    digitalTwin?: DigitalTwinService;
    vfs: IVFSManager;
    llmDriver: IConnectionService & { init(): Promise<void> };
    agentService: ApplicationAgentPort;
    configuration: ModelConfigurationCommands;
    sessionRepository: ISessionRepository;
    flowEngine: { engine: IFileSystem };
    sessionFiles: SessionFilesService;
    directoryMounts: DirectoryMountService;
    projects: ProjectService;
    projectSync?: ProjectSyncService;
    kernel: {
        kernel: ApplicationKernelPort;
        llmService: ILLMService;
        toolCatalog: Pick<IToolService, 'getToolDefinitions' | 'getToolMeta' | 'listTools'>;
        sessions: SessionCapabilityRegistry;
    };
    sessionManager: SessionManagementPort;
    commandBus: ICommandBus;
    startBackground?(): void;
    prepareSession?(sessionId: string): Promise<boolean>;
}

export type ApplicationKernelPort = import('@itookit/durable-kernel/contracts').KernelViewPort;

export interface LocalBackendOptions {
    snapshots?(vfs: IVFSManager): SnapshotPort;
}

export interface LocalBackendPort {
    configurationService<T extends ConfigurationContracts.IConnectionService>(service: T): T & ConfigurationContracts.ConfigurationImportPort;
    settings(vfs: IVFSManager, sources: readonly WorkspaceFileSource[]): SettingsPort;
    ocr(fs: IFileSystem, agents: IAgentManagementService, llm: ILLMService): OcrService;
    initialFiles(commands: ICommandBus, notes?: IFileSystem | undefined): MindosInitialFiles;
    privilegedCommands(kernel: ApplicationKernelPort, agentService: IAgentConfigService): PrivilegedCommandService;
    sessionSkills(kernel: ApplicationKernelPort, registry: SessionCapabilityRegistry): SessionSkillControls;
    projectSessions(repository: SessionOrganizationStore, projectFolders?: (folders: readonly SessionFolder[]) => Promise<SessionFolder[]>): ProjectSessions;
    sessionBrowser: typeof createSessionBrowser;
    sessionLifecycle(deps: SessionLifecycleDependencies, options?: SessionLifecycleOptions): SessionLifecycleService;
    projectSearch(projects: ProjectService): ProjectSearch;
    archiveExporter(projects: ProjectService, repository: ISessionRepository): WorkbenchArchiveExporter;
    archiveImporter(projects: ProjectService, lifecycle: SessionLifecycleService, repository: ISessionRepository): WorkbenchArchiveImporter;
    exportSession: typeof exportSessionBundle;
    exportRemoteSession: typeof exportRemoteSession;
    resolveFavorite: typeof resolveProjectFavorite;
    manageRemoteSession: typeof manageRemoteSession;
    remoteSessionSources: typeof remoteSessionSources;
    taskStat(task: TaskRecord): TaskStat;
    taskSummary: typeof taskSummary;
    taskKeyEvent: typeof taskKeyEvent;
    toolboxInventory(servers: () => Promise<MCPServer[]>, catalog: Catalog, models?: IConnectionService | undefined, prompts?: (() => Promise<SystemPromptDefinition[]>) | undefined, harnesses?: (() => Promise<RemoteHarnessAgent[]>) | undefined): ToolboxInventory;
    toolboxResources(sources: Record<ToolboxKind, IFileSystem>, agents: ApplicationAgentPort, commands: ICommandBus, settings: IFileSystem): ToolboxResources;
    remoteHarnessAgents: typeof listRemoteHarnessAgents;
    harnessObservation(session: import('@itookit/piagent-driver/harness').HarnessSession | undefined, requests?: Array<{ kind: string }>, evidence?: Partial<HarnessObservation>): HarnessObservation;
    conversationBranches: typeof HarnessContracts.conversationBranches;
}

export interface ApplicationAgentPort extends IAgentManagementService {
    getAgentResourceId(id: string): string | undefined;
}
