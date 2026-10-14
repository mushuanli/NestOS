import type { IFileSystem } from '@itookit/vfs-core';
import type { FavoriteFileChanges } from './contracts';

/** Follow committed VFS events and drain metadata updates before releasing the view. */
export function trackFavoriteFiles(favorites: FavoriteFileChanges, projectId: string, fs: IFileSystem): () => Promise<void> {
    let pending = Promise.resolve();
    const errors: unknown[] = [];
    const enqueue = (operation: () => Promise<void>) => {
        pending = pending.then(operation).catch(error => { errors.push(error); });
    };
    const stops = [
        fs.on('node:deleted', event => enqueue(() => favorites.deleteFiles(projectId, event.payload.requestedPaths))),
        fs.on('node:renamed', event => enqueue(() => favorites.moveFiles(projectId, event.payload.nodes))),
        fs.on('node:moved', event => enqueue(() => favorites.moveFiles(projectId, event.payload.nodes))),
    ];
    return async () => {
        for (const stop of stops) stop();
        await pending;
        if (errors.length) throw new AggregateError(errors, 'Favorite updates failed');
    };
}
