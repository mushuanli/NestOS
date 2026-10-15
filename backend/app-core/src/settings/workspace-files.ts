import { FSError } from '@itookit/vfs-core';
import type { IFileSystem, IVFSManager } from '@itookit/vfs-core';

import type { SettingsWorkspaceSource, WorkspaceFileSource } from '@itookit/app-contracts/settings';
export type { WorkspaceFileSource } from '@itookit/app-contracts/settings';

/** Resolve workspace files only for operations that actually consume them. */
export class SettingsFiles {
    private readonly opened = new Map<string, Promise<IFileSystem>>();
    constructor(private readonly vfs: IVFSManager, private readonly sources: readonly SettingsWorkspaceSource[]) {
        for (const source of sources) if (!source.fs && typeof source.workspace !== 'string')
            throw new FSError('EINVAL', 'Settings source requires a workspace identity or filesystem');
    }
    descriptions() { return this.sources.map(({ name, description }) => ({ name, description })); }
    open(name: string): Promise<IFileSystem> {
        const source = this.sources.find(source => source.name === name);
        if (!source) return Promise.reject(new Error(`Workspace source not configured: ${name}`));
        let pending = this.opened.get(name);
        if (!pending) {
            pending = source.fs ? Promise.resolve(source.fs) : this.resolve(source.workspace!);
            this.opened.set(name, pending);
            void pending.catch(() => { if (this.opened.get(name) === pending) this.opened.delete(name); });
        }
        return pending;
    }
    private resolve(workspace: string): Promise<IFileSystem> {
        if (typeof workspace !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(workspace)) return Promise.reject(new FSError('EINVAL', 'Invalid workspace identity'));
        return this.vfs.openFileSystem('/home/admin/' + workspace);
    }
    async tags(): Promise<WorkspaceFileSource[]> {
        const rows = await Promise.all(this.sources.filter(source => source.internal !== false).map(async source => ({ ...source, fs: await this.open(source.name) })));
        return rows.filter(source => source.fs.external !== true && source.fs.capabilities.tags);
    }
}
export async function writeWorkspaceFile(fs: IFileSystem, path: string, content: import('@itookit/vfs-core').FileContent): Promise<void> {
    if (await fs.driver.exists(path)) await fs.driver.writeContent(path, content);
    else {
        const index = path.lastIndexOf('/');
        await fs.driver.createFile({ name: path.slice(index + 1), parentPath: path.slice(0, index) || '/', content: content instanceof Uint8Array ? new Uint8Array(content).buffer : content, recursive: true });
    }
}
