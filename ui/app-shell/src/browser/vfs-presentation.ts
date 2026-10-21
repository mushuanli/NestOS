import { ACTION_ICONS, FILE_BROWSER_ICONS, FILE_ICONS, VFS_TOOLBAR_ICONS, fileTypeIcon, t, traceBoot, type LocaleKey } from '@itookit/common';
import { createVFSUI, type VFSUIOptions, type VFSPresentationOptions } from '@itookit/vfs-ui';
import type { IFileSystem } from '@itookit/vfs-core';

/** Keep MindOS presentation policies outside the independently usable browser. */
export const mindOSVFSPresentation: VFSPresentationOptions = {
    translate: (key, params) => t(key as LocaleKey, params),
    fileIcon: fileTypeIcon,
    trace: traceBoot,
    icons: { delete: ACTION_ICONS.delete, close: ACTION_ICONS.close, favorite: ACTION_ICONS.favorite,
        pin: FILE_ICONS.pin, folder: FILE_ICONS.folder, addFile: FILE_BROWSER_ICONS.addFile,
        addFolder: FILE_BROWSER_ICONS.addFolder, refresh: FILE_BROWSER_ICONS.refresh,
        import: VFS_TOOLBAR_ICONS.import, export: VFS_TOOLBAR_ICONS.export, more: FILE_BROWSER_ICONS.more },
};

export function createMindOSVFSUI(options: VFSUIOptions, fs: IFileSystem) {
    return createVFSUI({ ...options, presentation: options.presentation ?? mindOSVFSPresentation }, fs);
}
