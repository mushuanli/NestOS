import type { IFileSystem, OperationOptions } from '@itookit/vfs-core';
import type { ConfigurationImportPort, IConnectionService, IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import type { ISessionRepository, SessionManagementPort, ICommandBus } from '@itookit/llm-session/contracts';
import type { KernelViewPort } from '@itookit/durable-kernel/contracts';
import type { IToolService, SessionSkillControls } from '@itookit/tools/contracts';
import type { HarnessSession, HarnessConversationSnapshot } from '@itookit/piagent-driver/harness';
import type { SessionFilesPort, DirectoryMountPort, FileSystemsPort } from './files';
import type { ProjectService, ProjectSessions, NativeSessionCommand, ResolvedProjectFavorite } from './projects';
import type { SessionExport, WorkbenchView, WorkbenchArchiveExporter, WorkbenchArchiveImporter, PrivilegedCommandService, MindosInitialFiles } from './session';
import type { SettingsPort, SettingsWorkspaceSource } from '../settings';
import type { ToolboxInventory, ToolboxResources, OcrService, ModelConfigurationCommands } from './configuration';
import type { DigitalTwinService } from './digital-twin';
import type { ProjectSyncService } from './sync';
import type { TaskDetail, TaskEventQuery, TaskEventView } from './task-view';

/** Frontend consumers receive capabilities, never backend construction dependencies. */
export interface ApplicationServices {
    vfs: FileSystemsPort;
    llmDriver: IConnectionService & ConfigurationImportPort;
    agentService: IAgentManagementService & ConfigurationImportPort & { getAgentResourceId(id: string): string | undefined };
    configuration: ModelConfigurationCommands;
    sessionRepository: ISessionRepository;
    sessionFiles: SessionFilesPort;
    directoryMounts: DirectoryMountPort;
    projects: ProjectService;
    flowEngine: { engine: IFileSystem };
    kernel: { kernel: KernelViewPort; toolCatalog: Pick<IToolService, 'getToolDefinitions' | 'listTools'> };
    sessionManager: Omit<SessionManagementPort, 'getSessionRuntime'>;
    commandBus: ICommandBus;
    projectSync?: ProjectSyncService;
    digitalTwin?: DigitalTwinService;
    startBackground?(): void;
    prepareSession?(sessionId: string): Promise<boolean>;
}
export interface ToolboxView {
    inventory: ToolboxInventory;
    resources: ToolboxResources;
    dispose(): Promise<void>;
}
/** Boundary operations are asynchronous; synchronous selectors belong to loaded snapshots. */
export interface ApplicationBackend {
    workbenchView(options?: { displayedFilesPolicy?: 'gitignore' | 'all' }): Promise<WorkbenchView>;
    settings(sources: readonly SettingsWorkspaceSource[]): Promise<SettingsPort>;
    ocr(): Promise<OcrService>;
    initialFiles(): Promise<MindosInitialFiles>;
    privilegedCommands(): Promise<PrivilegedCommandService>;
    sessionSkills(): Promise<SessionSkillControls>;
    projectSessions(): Promise<ProjectSessions>;
    toolboxView(skills: IFileSystem): Promise<ToolboxView>;
    archiveExporter(): Promise<WorkbenchArchiveExporter>;
    archiveImporter(): Promise<WorkbenchArchiveImporter>;
    exportSession(sessionId: string): Promise<SessionExport>;
    exportRemoteSession(folder: string, profileId: string, sessionId: string, options?: OperationOptions): Promise<SessionExport>;
    resolveFavorite(folder: string, favoriteId: string): Promise<ResolvedProjectFavorite>;
    manageRemoteSession(folder: string, profileId: string, sessionId: string, command: NativeSessionCommand, options?: OperationOptions): Promise<HarnessConversationSnapshot>;
    conversationBranches(folder: string, profileId: string, sessionId: string, options?: OperationOptions): Promise<HarnessSession[]>;
    taskDetails(sessionId: string, taskId: string): Promise<TaskDetail>;
    taskEvents(sessionId: string, taskId: string, options?: TaskEventQuery): Promise<TaskEventView>;
}
export interface ApplicationClient { services: ApplicationServices; backend: ApplicationBackend }
