/** Host construction services. UI consumes ApplicationClient instead. */
import type { IFileSystem, IVFSManager } from '@itookit/vfs-core';
import type { ILLMService } from '@itookit/driver-llm/contracts';
import type { IConnectionService, IAgentManagementService, SessionCapabilityRegistry } from '@itookit/kernel-adapters/contracts';
import type { ISessionRepository, ICommandBus, SessionManagementPort } from '@itookit/llm-session/contracts';
import type { SnapshotPort } from '../settings';
import type { IToolService } from '@itookit/tools/contracts';
import type { DigitalTwinService } from './digital-twin';
import type { ModelConfigurationCommands } from './configuration';
import type { ProjectService } from './projects';
import type { SessionFilesService, DirectoryMountService } from './files';
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
    acquireConversation?(sessionId: string): Promise<{ dispose(): Promise<void> }>;
}

export type ApplicationKernelPort = import('@itookit/durable-kernel/contracts').KernelViewPort;

export interface LocalBackendOptions {
    snapshots?(vfs: IVFSManager): SnapshotPort;
}

export interface ApplicationAgentPort extends IAgentManagementService {
    getAgentResourceId(id: string): string | undefined;
}
