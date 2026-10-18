import { folderBrowserPath, folderPathFromBrowserPath, resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectService } from '@itookit/app-contracts/services';
import { FILE_BROWSER_ICONS, t } from '@itookit/common';
import type { FSNode } from '@itookit/vfs-core';
import { sessionCreationReason } from './session-creation-policy';
import type { DirectoryListOptions } from '../workbench/directory-list';

type Actions = NonNullable<DirectoryListOptions['actions']>;
interface Commands { session(path: string): Promise<void>; project(): Promise<void>; entry(path: string, type: 'file' | 'directory'): Promise<void>; report(error: unknown): void }

/** Creation follows the source directory permissions, independently of sidebar grouping. */
export async function projectDirectoryActions(path: string, node: FSNode | null, projects: ProjectService | undefined, commands: Commands): Promise<Actions> {
    const target = resolveBrowserTarget(path), actions: Actions = [];
    const run = (action: () => Promise<void>) => () => { void action().catch(commands.report); };
    if (path === '/' && projects) actions.push({id: 'create-project', label: t('project.create'), icon: FILE_BROWSER_ICONS.addFolder, primary: true, run: run(commands.project)});
    if (projects && ['folder', 'project-conversations', 'remote'].includes(target.kind)) {
        const folder = target.kind === 'project-conversations' || target.kind === 'remote' ? target.folder : folderPathFromBrowserPath(path);
        const project = folder && await projects.forFolder(folder);
        if (project) {
            const reason = sessionCreationReason(projects, project.project.id);
            actions.push({id: 'create-session', label: t('project.createSession'), icon: FILE_BROWSER_ICONS.newSession, primary: true,
                disabled: !!reason, disabledReason: reason,
                run: run(() => commands.session(folderBrowserPath(project.path)))});
        }
    }
    if ((target.kind === 'project-files' || target.kind === 'files') && node?.type === 'directory') {
        for (const type of ['file', 'directory'] as const) actions.push({id: type === 'file' ? 'create-file' : 'create-folder',
            label: t(type === 'file' ? 'project.createFile' : 'project.createFolder'), icon: FILE_BROWSER_ICONS[type === 'file' ? 'addFile' : 'addFolder'], primary: type === 'file',
            disabled: node.metadata._readOnly === true || node.metadata._disabled === true, run: run(() => commands.entry(path, type))});
    }
    return actions;
}
