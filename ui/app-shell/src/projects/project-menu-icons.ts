import { ACTION_ICONS, CHAT_ICONS, TOOLBOX_ICONS, PROJECT_ACTION_ICONS, FILE_BROWSER_ICONS } from '@itookit/common';
import type { ContextMenuBuilder } from '@itookit/ui-common-adapter';
import type { VFSNodeUI } from '@itookit/vfs-ui';

const icons: Record<string, string> = {
    'project-status': ACTION_ICONS.info, 'project-settings': PROJECT_ACTION_ICONS.settings,
    'upload-file': PROJECT_ACTION_ICONS.upload, 'download-file': PROJECT_ACTION_ICONS.download,
    moveTo: PROJECT_ACTION_ICONS.move, export: PROJECT_ACTION_ICONS.upload,
    'edit-tags': PROJECT_ACTION_ICONS.tags, 'favorite-toggle': PROJECT_ACTION_ICONS.favorite,
    rename: CHAT_ICONS.edit, delete: CHAT_ICONS.delete, copyTo: CHAT_ICONS.copy, duplicate: CHAT_ICONS.copy,
    'refresh-project-binding': ACTION_ICONS.refreshView,
    'project-sync-settings': PROJECT_ACTION_ICONS.settings, 'project-sync-status': ACTION_ICONS.info,
    'project-sync-setup': TOOLBOX_ICONS.connections, 'project-sync-now': ACTION_ICONS.refreshView,
    'project-sync-recover': ACTION_ICONS.refreshView, 'project-sync-reconcile': TOOLBOX_ICONS.tasks,
    'project-sync-conflicts': PROJECT_ACTION_ICONS.warning, 'project-sync-directory': TOOLBOX_ICONS.files,
    'project-sync-unbind': PROJECT_ACTION_ICONS.disconnect,
    'create-project': FILE_BROWSER_ICONS.addFolder,
    'create-session': FILE_BROWSER_ICONS.newSession, 'create-file': FILE_BROWSER_ICONS.addFile, 'create-folder': FILE_BROWSER_ICONS.addFolder,
    'enter-project': PROJECT_ACTION_ICONS.enter, 'remount-project': TOOLBOX_ICONS.connections, 'unmount-project': PROJECT_ACTION_ICONS.disconnect,
    'project-harness': TOOLBOX_ICONS.terminal, 'twin-analysis': ACTION_ICONS.ai,
    'native-rename': CHAT_ICONS.edit, 'native-delete': CHAT_ICONS.delete, 'native-archive': PROJECT_ACTION_ICONS.archive,
    'native-export': PROJECT_ACTION_ICONS.upload, 'native-family': ACTION_ICONS.branch, 'native-parent': FILE_BROWSER_ICONS.up,
    'new-child': ACTION_ICONS.branch, 'move-under': FILE_BROWSER_ICONS.move, 'promote-session': FILE_BROWSER_ICONS.up,
    'delete-session-only': CHAT_ICONS.delete, 'reset-task': ACTION_ICONS.rerun,
    'session-tasks': TOOLBOX_ICONS.tasks, 'session-files': TOOLBOX_ICONS.files, 'rerun-session': ACTION_ICONS.rerun,
    'close-session': PROJECT_ACTION_ICONS.close,
};

/** Project action semantics stay in the host; the browser only renders menu presentation. */
export function projectIconMenu(build: ContextMenuBuilder<VFSNodeUI>): ContextMenuBuilder<VFSNodeUI> {
    return (item, defaults) => build(item, defaults).map(entry => entry.type === 'separator' ? entry : {
        ...entry, iconOnly: false, danger: entry.danger || ['delete','unmount-project','native-delete','delete-session-only'].includes(entry.id),
        iconHTML: icons[entry.id] ?? entry.iconHTML ?? (entry.id.startsWith('project-sync-') ? ACTION_ICONS.refreshView : PROJECT_ACTION_ICONS.settings),
    });
}
