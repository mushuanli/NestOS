import { folderBrowserPath, resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectService, ProjectFolder } from '@itookit/app-contracts/services';
import type { IFileSystem, FSNode } from '@itookit/vfs-core';
import type { VFSNodeUI } from '@itookit/vfs-ui';
import { describeCauseChain } from '@itookit/vfs-ui';

/** The destination identity stays canonical while the project title replaces the section label. */
export async function projectTransferTargets(projects: ProjectService, fs: IFileSystem,
    ids: string[], parent?: string): Promise<VFSNodeUI[]> {
    const files = ids.every(id => ['files', 'project-files'].includes(resolveBrowserTarget(id).kind));
    if (parent) {
        if (!files) return [];
        return (await fs.driver.getChildren(parent)).filter(node => node.type === 'directory').map(targetNode);
    }
    const targets: VFSNodeUI[] = [];
    for (const project of await projects.list()) {
        const path = files ? folderBrowserPath(project.path) + '/@files'
            : folderBrowserPath(project.path + '/@sessions');
        const node = await resolveTarget(fs, path, project.project.id);
        logTargetAvailability(projects, project, path, ids, node);
        if (node) {
            const target = targetNode(node);
            targets.push({ ...target, children: files ? undefined : [], metadata: { ...target.metadata, title: project.displayName ?? project.name } });
        }
    }
    return targets;
}

function logTargetAvailability(projects: ProjectService, project: ProjectFolder, path: string, ids: string[], node: FSNode | null): void {
    if (node && node.metadata._disabled !== true && node.metadata._readOnly !== true) return;
    const remote = projects.remoteMounts;
    console.info('[Project transfer]', { stage: 'target-availability', sources: ids, projectId: project.project.id,
        projectName: project.displayName ?? project.name, directory: project.project.directory, path, exists: !!node,
        disabled: node?.metadata._disabled === true, readOnly: node?.metadata._readOnly === true,
        reason: node?.metadata.navigationDescription,
        mounts: remote?.list(project.project.id).map(mount => ({ at: mount.at, endpoint: mount.endpoint,
            alias: mount.alias, root: mount.root, access: mount.access, status: remote.status(mount.mountId) })) ?? [] });
}

async function resolveTarget(fs: IFileSystem, path: string, projectId: string): Promise<FSNode | null> {
    try { return await fs.driver.getNode(path); }
    catch (error) {
        console.error('[Project transfer]', { stage: 'resolve-project-target', projectId, path,
            cause: describeCauseChain(error), error });
        throw error;
    }
}

function targetNode(node: FSNode): VFSNodeUI {
    return { id: node.path, type: 'directory', version: String(node.version),
        metadata: { title: String(node.metadata.title ?? node.name), path: node.path, parentPath: node.parentPath,
            tags: [], createdAt: new Date(node.createdAt).toISOString(), lastModified: new Date(node.modifiedAt).toISOString(),
            custom: { ...node.metadata } } };
}
