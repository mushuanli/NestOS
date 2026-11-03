import { t } from '@itookit/common';
import type { VFSUIShell, DirectoryBulkAction } from '@itookit/vfs-ui';

/** Reuses VFS menu policy and the existing export, delete and move commands. */
export function directoryBulkActions(ui: VFSUIShell, beforeRun?: (ids: string[]) => void): DirectoryBulkAction[] {
    return (['export', 'copy', 'move', 'delete'] as const).map(id => ({ id, label: t(id === 'export' ? 'action.export' : `workbench.${id}`),
        allows: ids => ui.allowsBulkAction(id, ids), run: ids => {beforeRun?.(ids); return ui.runBulkAction(id, ids);} }));
}
