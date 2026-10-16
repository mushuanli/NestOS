import { FSError } from '@itookit/vfs-core';
import type { ProjectService, SessionLifecycleService } from '@itookit/app-contracts/services';

/** Unmount local records without traversing or modifying the remote file tree. */
export async function unmountRemoteProject(projects: ProjectService, lifecycle: SessionLifecycleService, id: string): Promise<void> {
    const project = await projects.get(id);
    if (project.project.source?.kind !== 'remote') throw new FSError('EACCES', 'Only remote projects can be unmounted');
    await projects.remoteMounts?.assertUnmountable(id);
    await projects.remoteMounts?.forgetProject(id);
    await lifecycle.deleteFolder(project.path, true);
    await projects.removeProjectSource(project);
}
