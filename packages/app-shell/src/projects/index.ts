import type { ApplicationRuntime } from '@itookit/app-core';
import type { AppUI } from '../types';
import { showMemoryDialog } from '../files/memory-dialog';
import { setupHitlVfsBridge } from '../workspaces/hitl-bridge';
import { createWorkspaceModule, type WorkspaceModule } from '../workspaces/module';
import { SessionWorkbench, type SessionWorkbenchOptions } from './SessionWorkbench';

interface ProjectModuleOptions extends Pick<SessionWorkbenchOptions, 'sidebar' | 'container' | 'factory' | 'fileFactory' | 'onSelect' | 'hostContext' | 'sessionSkills' | 'onSidebarReady' | 'initialResourceId' | 'uiPersistence' | 'workbenchState' | 'projectSyncSetup' | 'projectSyncDirectory'> {
    runtime: Pick<ApplicationRuntime, 'sessionRepository' | 'sessionFiles' | 'kernel' | 'directoryMounts' | 'sessionManager' | 'flowEngine' | 'projects' | 'commandBus' | 'projectSync' | 'digitalTwin' | 'prepareSession'>;
    createFlowContextMenu: AppUI['createFlowContextMenu'];
}

/** Project UI, memory interaction and event subscriptions share one lifetime. */
export function createProjectModule(options: ProjectModuleOptions): WorkspaceModule {
    const { runtime } = options, { sessionManager } = runtime;
    const workbench = new SessionWorkbench({ ...options, repository: runtime.sessionRepository,
        files: runtime.sessionFiles, kernel: runtime.kernel.kernel, directoryMounts: runtime.directoryMounts,
        prepareSession: runtime.prepareSession,
        projects: runtime.projects, digitalTwin: runtime.digitalTwin, projectSync: runtime.projectSync,
        manageTwin: runtime.digitalTwin ? async id => { await options.hostContext?.navigate({ target: 'twin', resourceId: '/overview/' + encodeURIComponent(id) }); } : undefined,
        manageMemory: async (id, signal) => showMemoryDialog(sessionManager.memory.forSession(id), await sessionManager.getAvailableAgents(), signal),
        flows: { fs: runtime.flowEngine.engine, menu: options.createFlowContextMenu({ commands: runtime.commandBus,
            navigate: id => options.hostContext?.navigate({ target: 'chat', resourceId: id }) ?? Promise.resolve() }) },
    });
    const release = setupHitlVfsBridge(sessionManager, (id, waiting) => workbench.setWaitingInput(id, waiting));
    return createWorkspaceModule(workbench, async () => { release(); await workbench.destroy(); });
}
