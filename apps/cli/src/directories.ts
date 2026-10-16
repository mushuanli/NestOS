import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { DirectorySourceProvider } from '@itookit/app-core';
import { FSError, createFileSystemSource, type FileSystemSourceOwner, type IFileSystem } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';

/** Node-host directory sources used by CLI --set-home / --add-dir / RequestWorkspaceAccess. */
export class CliDirectorySourceProvider implements DirectorySourceProvider {
    private readonly sources = new Map<string, Promise<FileSystemSourceOwner>>();

    constructor(private readonly profileRoot: string) {}

    async selectDirectory(): Promise<string | null> {
        return null;
    }

    async openDirectory(directory: string): Promise<IFileSystem> {
        const canonical = await realpath(directory).catch(error => {
            if (error?.code === 'ENOENT') throw new FSError('ENOENT', 'Host directory unavailable', 'openDirectory', directory);
            throw error;
        });
        let pending = this.sources.get(canonical);
        if (!pending) {
            pending = this.open(canonical);
            this.sources.set(canonical, pending);
        }
        try {
            return (await pending).fs;
        } catch (error) {
            this.sources.delete(canonical);
            throw error;
        }
    }

    async dispose(): Promise<void> {
        const sources = [...this.sources.values()];
        this.sources.clear();
        const results = await Promise.allSettled(sources.map(async source => (await source).dispose()));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
    }

    private async open(canonical: string): Promise<FileSystemSourceOwner> {
        const digest = createHash('sha256').update(canonical).digest('hex');
        const sidecarDir = path.join(this.profileRoot, '_meta', 'session-sources', digest);
        await mkdir(sidecarDir, { recursive: true });
        const backend = await openLocalFSBackend({
            rootDir: canonical,
            sidecarDir,
            createDb: NodeSqliteSidecarDb.open,
        });
        try {
            return await createFileSystemSource({ tags: false, backend, viewId: `cli-directory:${digest}` });
        } catch (error) {
            await backend.close();
            throw error;
        }
    }
}
