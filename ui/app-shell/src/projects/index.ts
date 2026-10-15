import type { ApplicationServices } from '@itookit/app-contracts/services';
import type { AppUI } from '../types';
import { showMemoryDialog } from '../files/memory-dialog';
import { setupHitlVfsBridge } from '../workspaces/hitl-bridge';
import { createWorkspaceModule, type WorkspaceModule } from '../workspaces/module';
import { SessionWorkbench, type SessionWorkbenchOptions } from './SessionWorkbench';

interface ProjectModuleOptions extends Pick<SessionWorkbenchOptions, 'sidebar' | 'container' | 'factory' | 'createFactory' | 'fileFactory' | 'onSelect' | 'hostContext' | 'sessionSkills' | 'onSidebarReady' | 'uiPersistence' | 'workbenchState' | 'projectSyncSetup' | 'projectSyncDirectory'> {
    backend: import('@itookit/app-contracts/services').ApplicationBackend;
    services: Pick<ApplicationServices, 'sessionRepository' | 'sessionFiles' | 'kernel' | 'directoryMounts' | 'sessionManager' | 'flowEngine' | 'projects' | 'commandBus' | 'projectSync' | 'digitalTwin' | 'prepareSession'>;
    createFlowContextMenu: AppUI['createFlowContextMenu'];
}

/** Project UI, memory interaction and event subscriptions share one lifetime. */
export function createProjectModule(options: ProjectModuleOptions): WorkspaceModule {
    const { services } = options, { sessionManager } = services;
    const workbench = new SessionWorkbench({ ...options, repository: services.sessionRepository,
        files: services.sessionFiles, kernel: services.kernel.kernel, directoryMounts: services.directoryMounts,
        prepareSession: services.prepareSession,
        projects: services.projects, digitalTwin: services.digitalTwin, projectSync: services.projectSync,
        manageTwin: services.digitalTwin ? async id => { await options.hostContext?.navigate({ target: 'twin', resourceId: '/overview/' + encodeURIComponent(id) }); } : undefined,
        manageMemory: async (id, signal) => showMemoryDialog(await sessionManager.memory.forSession(id), await sessionManager.getAvailableAgents(), signal),
        flows: { fs: services.flowEngine.engine, menu: options.createFlowContextMenu({ commands: services.commandBus,
            navigate: id => options.hostContext?.navigate({ target: 'chat', resourceId: id }) ?? Promise.resolve() }) },
    });
    const release = setupHitlVfsBridge(sessionManager, (id, waiting) => workbench.setWaitingInput(id, waiting));
    return createWorkspaceModule(workbench, async () => { release(); await workbench.destroy(); });
}
