import { FSError, type IFileSystem } from '@itookit/vfs-core';
import { decodeFavorites, MAX_FAVORITES } from './codec';
import type { FavoriteUpdate, ProjectFavorite, ProjectFavoriteStore } from './contracts';

/** Atomic SeqFile persistence; no project navigation or target lifecycle policy. */
export class SeqProjectFavoriteStore implements ProjectFavoriteStore {
    constructor(private readonly fs: IFileSystem) {}
    async read(projectId: string): Promise<ProjectFavorite[]> {
        const path = this.path(projectId);
        if (!await this.fs.driver.exists(path)) return [];
        return decodeFavorites(await this.fs.meta.seq!.getEntry(path, 'items'));
    }
    async update(projectId: string, update: FavoriteUpdate): Promise<{ items: ProjectFavorite[]; changed: boolean }> {
        const path = this.path(projectId);
        // A no-op request must not create the file: `update` runs once here (probe) and
        // once inside the transaction, so it has to stay pure.
        if (!await this.fs.driver.exists(path)) {
            if (!update([]).length) return { items: [], changed: false };
            await this.create(projectId);
        }
        let items: ProjectFavorite[] = [], changed = false;
        await this.fs.meta.seq!.transaction!(async tx => {
            const previous = decodeFavorites(await tx.getEntry(path, 'items'));
            items = update(previous);
            if (items.length > MAX_FAVORITES) throw new FSError('ENOSPC', 'Project favorite limit reached');
            const encoded = JSON.stringify(items);
            // Validate the complete output before publishing any policy result.
            decodeFavorites(encoded);
            changed = encoded !== JSON.stringify(previous);
            if (changed) await tx.setEntry(path, 'items', encoded);
        });
        return { items, changed };
    }
    private async create(projectId: string): Promise<void> {
        try { await this.fs.driver.createFile({ parentPath: this.directory(projectId), name: FILE_NAME, type: 'seqfile', recursive: true }); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
    }
    private directory(projectId: string): string {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new FSError('EINVAL', 'Invalid project identity');
        return `/var/lib/projects/${projectId}`;
    }
    private path(projectId: string): string {
        return `${this.directory(projectId)}/${FILE_NAME}`;
    }
}

const FILE_NAME = 'favorites.seq';
