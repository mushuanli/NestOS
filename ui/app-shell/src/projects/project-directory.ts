import type { FSNode, IFileSystem } from '@itookit/vfs-core';

/** Both directory and tree views expose members of backend-declared transparent containers. */
export async function projectDirectoryNodes(fs: IFileSystem, path: string): Promise<FSNode[]> {
    const nodes = await fs.driver.getChildren(path);
    const rows = await Promise.all(nodes.filter(node => node.metadata.navigationHidden !== true).map(node => node.metadata.navigationTransparent === true
        ? projectDirectoryNodes(fs, String(node.metadata.directoryPath ?? node.path)) : [node]));
    return rows.flat();
}
