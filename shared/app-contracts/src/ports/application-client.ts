import type { IFileSystem, OperationOptions } from '@itookit/vfs-core';
import type { ConfigurationImportPort, IConnectionService, IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import type { ISessionRepository, SessionManagementPort, ICommandBus } from '@itookit/llm-session/contracts';
import type { KernelViewPort } from '@itookit/durable-kernel/contracts';
import type { IToolService } from '@itookit/tools/contracts';
import type { HarnessSession, HarnessConversationSnapshot } from '@itookit/piagent-driver/harness';
import type { SessionFilesPort, DirectoryMountPort, FileSystemsPort } from './files';
import type { ProjectService, ProjectSessions, NativeSessionCommand, ResolvedProjectFavorite } from './projects';
import type { SessionExport, WorkbenchView, SessionOpenView, WorkbenchArchiveExporter, WorkbenchArchiveImporter, MindosInitialFiles } from './session';
import type { SettingsPort, SettingsWorkspaceSource } from '../settings';
import type { ToolboxInventory, ToolboxResources, OcrService, ModelConfigurationCommands } from './configuration';
import type { DigitalTwinService } from './digital-twin';
import type { ProjectSyncService } from './sync';
import type { TaskDetail, TaskEventQuery, TaskEventView, SessionTaskQuery, SessionTaskPage } from './task-view';

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
    files: IFileSystem;
    initial: import('./configuration').ToolboxNavigation;
    dispose(): Promise<void>;
}
/** Boundary operations are asynchronous; synchronous selectors belong to loaded snapshots. */
export interface ApplicationBackend {
    openView(request: import('./open-view').OpenViewRequest): Promise<import('./open-view').OpenedApplicationView>;
    createSessionDraft(request: SessionDraftRequest): Promise<string>;
    navigationView(options: { root: string; scope: string }): Promise<import('./navigation').NavigationView>;
    warmNavigation(roots: string[]): Promise<void>;
    workbenchView(options?: { displayedFilesPolicy?: 'gitignore' | 'all'; chatControls?: boolean; initialNavigation?: boolean; initialSessionId?: string }): Promise<WorkbenchView>;
    openSessionView(sessionId: string): Promise<SessionOpenView>;
    readUiDocuments(names: string[]): Promise<Record<string, unknown>>;
    writeUiDocuments(documents: Record<string, unknown>): Promise<void>;
    settings(sources: readonly SettingsWorkspaceSource[]): Promise<SettingsPort>;
    ocr(): Promise<OcrService>;
    initialFiles(): Promise<MindosInitialFiles>;
    projectSessions(): Promise<ProjectSessions>;
    skillsFiles(): Promise<IFileSystem>;
    toolboxView(): Promise<ToolboxView>;
    archiveExporter(): Promise<WorkbenchArchiveExporter>;
    archiveImporter(): Promise<WorkbenchArchiveImporter>;
    exportSession(sessionId: string): Promise<SessionExport>;
    exportRemoteSession(folder: string, profileId: string, sessionId: string, options?: OperationOptions): Promise<SessionExport>;
    resolveFavorite(folder: string, favoriteId: string): Promise<ResolvedProjectFavorite>;
    manageRemoteSession(folder: string, profileId: string, sessionId: string, command: NativeSessionCommand, options?: OperationOptions): Promise<HarnessConversationSnapshot>;
    unmountProject(projectId: string): Promise<void>;
    conversationBranches(folder: string, profileId: string, sessionId: string, options?: OperationOptions): Promise<HarnessSession[]>;
    taskDetails(sessionId: string, taskId: string): Promise<TaskDetail>;
    taskAttachment: import('@itookit/durable-kernel/contracts').ReadTaskAttachment;
    sessionTasks(sessionId: string, options?: SessionTaskQuery): Promise<SessionTaskPage>;
    taskEvents(sessionId: string, taskId: string, options?: TaskEventQuery): Promise<TaskEventView>;
}
export interface SessionDraftRequest {
    title: string;
    inputText: string;
    source?: { projectFolder?: string; sessionId?: string };
}
export interface ApplicationClient { services: ApplicationServices; backend: ApplicationBackend }
