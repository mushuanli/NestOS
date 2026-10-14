import type { WorkspaceController, WorkspaceCreation } from '@itookit/app-contracts';

/** Route recovery is a shell capability; ordinary resource operations remain strict. */
export type WorkspaceHandle = WorkspaceController & Partial<WorkspaceCreation> & {
    restoreResource?(id: string): Promise<void>;
};
export interface WorkspaceModule {
    workbench: WorkspaceHandle;
    dispose(): Promise<void>;
}

/** Own all module resources, including when a workspace is removed before app shutdown. */
export function createWorkspaceModule(controller: WorkspaceHandle, dispose: () => void | Promise<void> = () => controller.destroy()): WorkspaceModule {
    let disposal: Promise<void> | undefined;
    const destroy = () => disposal ??= Promise.resolve().then(dispose);
    return { dispose: destroy, workbench: {
        start: () => controller.start(), destroy,
        ...(controller.setVisible ? { setVisible: (visible: boolean) => controller.setVisible!(visible) } : {}),
        openResource: id => controller.openResource(id),
        getActiveResourceId: () => controller.getActiveResourceId(),
        ...(controller.restoreResource ? { restoreResource: (id: string) => controller.restoreResource!(id) } : {}),
        ...(controller.createResource ? { createResource: (options: Parameters<WorkspaceCreation['createResource']>[0]) => controller.createResource!(options) } : {}),
    } };
}

export function restoreWorkspaceResource(workspace: WorkspaceHandle, id: string): Promise<void> {
    return workspace.restoreResource ? workspace.restoreResource(id) : workspace.openResource(id);
}
