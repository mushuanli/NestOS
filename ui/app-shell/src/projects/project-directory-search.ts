import { folderPathFromBrowserPath, projectRelativePath, resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectService, ProjectSearch, ProjectSearchMatch } from '@itookit/app-contracts/services';
import { ProjectSearchPanel } from './project-search-panel';

/** Page searches use source queries; the sidebar keeps its separate loaded-tree filter. */
export async function createProjectDirectorySearch(path: string, projects: ProjectService, search: ProjectSearch,
    open: (row: ProjectSearchMatch, query: string) => Promise<void>): Promise<ProjectSearchPanel | undefined> {
    const target = resolveBrowserTarget(path);
    const files = target.kind === 'project-files';
    if (!files && !['folder', 'project-conversations', 'remote'].includes(target.kind)) return;
    const folder = files || target.kind === 'project-conversations' || target.kind === 'remote' ? target.folder : folderPathFromBrowserPath(path);
    if (!folder) return;
    const project = await projects.forFolder(folder);
    if (!project) return;
    const directory = files ? projectRelativePath(target.path).replace(/^\//, '') : undefined;
    const panel = new ProjectSearchPanel(search, open, undefined, {
        scopes: files ? ['file-name', 'file-content', 'file-path'] : ['session-title', 'session-content', 'session-prompt'],
        query: files ? {directory} : target.kind === 'remote' ? {profileId: target.profileId, archived: target.archived} : undefined,
        sessions: !files, archived: false, compact: true,
    });
    panel.project(project.path);
    return panel;
}
