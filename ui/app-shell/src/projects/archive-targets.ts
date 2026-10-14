import { projectRelativePath, folderBrowserPath, folderPathFromBrowserPath, resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectTarget, ProjectService } from '@itookit/app-contracts/services';

/** Sidebar encoding stops at the presentation boundary. */
export async function archiveTarget(path: string, projects: ProjectService): Promise<ProjectTarget> {
    const target = resolveBrowserTarget(path);
    if (target.kind === 'session') return { kind: 'session', sessionId: target.sessionId };
    if (target.kind === 'project-files') {
        const project = await projects.forFolder(target.folder);
        if (!project) throw new Error('Project not found');
        return { kind: 'file', projectId: project.project.id, path: projectRelativePath(target.path) };
    }
    if (target.kind === 'folder') {
        const folder = folderPathFromBrowserPath(path), project = await projects.forFolder(folder);
        return project?.path === folder ? { kind: 'project', projectId: project.project.id } : { kind: 'group', folder };
    }
    throw new Error('Select a project, Session or project file');
}
export async function archiveTargetPath(target: ProjectTarget, projects: ProjectService): Promise<string> {
    if (target.kind === 'session') return target.sessionId;
    if (target.kind === 'group') return folderBrowserPath(target.folder) || '/';
    const prefix = folderBrowserPath((await projects.get(target.projectId)).path);
    return target.kind === 'file' ? prefix + '/@files' + (target.path === '/' ? '' : target.path) : prefix;
}
