import type { IFileSystem } from '@itookit/vfs-core';
import { refreshDirectoryList } from './directory-list';

/** Refresh after committed mutations, including moves completed in the shared picker. */
export function watchDirectoryList(fs: IFileSystem, panel: HTMLElement, error: (reason: unknown) => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { if (panel.isConnected && !panel.closest('[hidden]')) void refreshDirectoryList(panel).catch(error); }, 30);
    };
    const stops = (['node:created', 'node:deleted', 'node:moved', 'node:renamed'] as const).map(type => fs.on(type, refresh));
    return () => { if (timer) clearTimeout(timer); stops.forEach(stop => stop()); };
}
