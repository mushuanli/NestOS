import { ACTION_ICONS, ENTITY_ICONS, FILE_BROWSER_ICONS, FILE_ICONS } from '@itookit/common';
import type { ContextMenuBuilder } from '@itookit/ui-common';
import type { VFSNodeUI } from '@itookit/vfs-ui';

const icons: Record<string, string> = {
    'create-session': FILE_BROWSER_ICONS.newSession, 'create-file': FILE_BROWSER_ICONS.addFile, 'create-folder': FILE_BROWSER_ICONS.addFolder,
    'enter-project': ENTITY_ICONS.project, 'remount-project': ENTITY_ICONS.remoteProject, 'unmount-project': ACTION_ICONS.close,
    'project-harness': ENTITY_ICONS.agent, 'twin-analysis': ACTION_ICONS.ai,
    'native-rename': ACTION_ICONS.edit, 'native-delete': ACTION_ICONS.delete, 'native-archive': ENTITY_ICONS.history,
    'native-export': ACTION_ICONS.export, 'native-family': ENTITY_ICONS.branch, 'native-parent': FILE_BROWSER_ICONS.up,
    'new-child': ENTITY_ICONS.branch, 'move-under': FILE_BROWSER_ICONS.move, 'promote-session': FILE_BROWSER_ICONS.up,
    'delete-session-only': ACTION_ICONS.delete, 'reset-task': ACTION_ICONS.rerun,
    'session-tasks': ENTITY_ICONS.tool, 'session-files': FILE_ICONS.folder, 'rerun-session': ACTION_ICONS.rerun,
    'close-session': ACTION_ICONS.close,
};

/** Project action semantics stay in the host; the browser only renders menu presentation. */
export function projectIconMenu(build: ContextMenuBuilder<VFSNodeUI>): ContextMenuBuilder<VFSNodeUI> {
    return (item, defaults) => build(item, defaults).map(entry => entry.type === 'separator' ? entry : {
        ...entry, iconOnly: true,
        iconHTML: entry.iconHTML ?? icons[entry.id] ?? (entry.id.startsWith('project-sync-') ? ENTITY_ICONS.sync : ACTION_ICONS.settings),
    });
}
