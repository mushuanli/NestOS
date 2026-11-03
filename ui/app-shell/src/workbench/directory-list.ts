import { createDirectoryList as createList, type DirectoryListOptions, type VFSUIShell } from '@itookit/vfs-ui';
import { directoryPresentation, directoryBulkIcon } from './directory-presentation';
import { refreshDirectorySelection } from '@itookit/vfs-ui';
export { refreshDirectoryList, refreshDirectorySelection, relocateDirectoryList } from '@itookit/vfs-ui';
export type { DirectoryEntry, DirectoryListOptions } from '@itookit/vfs-ui';

/** Business services stay in the host; the library owns directory rendering. */
export function createDirectoryList(options: DirectoryListOptions): HTMLElement {
    const presentation = directoryPresentation();
    return createList({...options,
        bulkActions: options.bulkActions?.map(action => ({...action, icon: action.icon ?? directoryBulkIcon(action.id)})),
        presentation: {...presentation, ...options.presentation, icons: {...presentation.icons, ...options.presentation?.icons}},
    });
}
export function watchDirectorySelection(panel: HTMLElement, source: Pick<VFSUIShell, 'on' | 'getSnapshot'>): () => void {
    let selected = source.getSnapshot().selectedIds.join('\0');
    return source.on('stateChanged', ({ state }) => {
        const next = [...state.selectedItemIds].join('\0');
        if (next !== selected) { selected = next; refreshDirectorySelection(panel); }
    });
}
