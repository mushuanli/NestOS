import type { IFileSystem } from '@itookit/vfs-core';

import type { WorkspaceFileSource } from '@itookit/app-contracts/settings';
export type { WorkspaceFileSource } from '@itookit/app-contracts/settings';

export function workspaceFiles(sources: readonly WorkspaceFileSource[], name: string): IFileSystem {
    const source = sources.find(source => source.name === name);
    if (!source) throw new Error(`Workspace source not configured: ${name}`);
    return source.fs;
}
export async function writeWorkspaceFile(fs: IFileSystem, path: string, content: import('@itookit/vfs-core').FileContent): Promise<void> {
    if (await fs.driver.exists(path)) await fs.driver.writeContent(path, content);
    else {
        const index = path.lastIndexOf('/');
        await fs.driver.createFile({ name: path.slice(index + 1), parentPath: path.slice(0, index) || '/', content: content instanceof Uint8Array ? new Uint8Array(content).buffer : content, recursive: true });
    }
}
