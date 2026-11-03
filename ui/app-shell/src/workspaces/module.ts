import type {RecoveryParticipant} from '../workbench/recovery';
import type { WorkspaceController, WorkspaceCreation, WorkspaceOpenOptions } from '@itookit/app-contracts';

/** Route recovery is a shell capability; ordinary resource operations remain strict. */
export type WorkspaceHandle = WorkspaceController & Partial<WorkspaceCreation> & RecoveryParticipant & {
    invalidateFromEvents?(): void;
    restoreResource?(id: string, options?: WorkspaceOpenOptions): Promise<void>;
    getNavigationScope?(): string;
    restoreNavigationScope?(scope: string): Promise<void>;
    expandNavigation?(): void;
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
        ...(controller.invalidateFromEvents ? {invalidateFromEvents: () => controller.invalidateFromEvents!()} : {}),
        ...(controller.captureRecovery ? {captureRecovery: () => controller.captureRecovery!()} : {}),
        ...(controller.restoreRecovery ? {restoreRecovery: (state: unknown) => controller.restoreRecovery!(state)} : {}),
        ...(controller.suspendForRecovery ? {suspendForRecovery: () => controller.suspendForRecovery!()} : {}),
        ...(controller.assertRecovery ? {assertRecovery: () => controller.assertRecovery!()} : {}),
        ...(controller.setVisible ? { setVisible: (visible: boolean) => controller.setVisible!(visible) } : {}),
        ...(controller.setNavigationVisible ? { setNavigationVisible: (visible: boolean) => controller.setNavigationVisible!(visible) } : {}),
        ...(controller.expandNavigation ? { expandNavigation: () => controller.expandNavigation!() } : {}),
        openResource: (id, options) => options ? controller.openResource(id, options) : controller.openResource(id),
        getActiveResourceId: () => controller.getActiveResourceId(),
        ...(controller.restoreResource ? { restoreResource: (id: string, options?: WorkspaceOpenOptions) => options ? controller.restoreResource!(id, options) : controller.restoreResource!(id) } : {}),
        ...(controller.getNavigationScope ? { getNavigationScope: () => controller.getNavigationScope!() } : {}),
        ...(controller.restoreNavigationScope ? { restoreNavigationScope: (scope: string) => controller.restoreNavigationScope!(scope) } : {}),
        ...(controller.createResource ? { createResource: (options: Parameters<WorkspaceCreation['createResource']>[0]) => controller.createResource!(options) } : {}),
    } };
}

export function restoreWorkspaceResource(workspace: WorkspaceHandle, id: string, options?: WorkspaceOpenOptions): Promise<void> {
    if (workspace.restoreResource) return options ? workspace.restoreResource(id, options) : workspace.restoreResource(id);
    return options ? workspace.openResource(id, options) : workspace.openResource(id);
}
