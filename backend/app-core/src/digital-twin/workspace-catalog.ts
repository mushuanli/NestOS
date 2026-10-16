import type { IFileSystem } from '@itookit/vfs-core';
import type { TwinSourceCatalog } from './domain';
import { documentPath } from './project-catalog';

const WORKSPACES = ['emails', 'minds', 'home', 'projects'];
/** Ordinary workspace documents are discoverable; rules decide which ones may be read. */
export async function discoverWorkspaces(fs: IFileSystem, catalog: TwinSourceCatalog): Promise<void> {
    for (const name of WORKSPACES) {
        const root = `/home/admin/${name}`, projectId = `@workspace/${name}`;
        catalog.projects.push(projectId);
        try {
            const node = await fs.driver.getNode(root);
            if (node && !node.metadata.isProtected && !node.tags.includes('private')) await walk(fs, root, projectId, catalog);
            catalog.completeScopes.push(`${projectId}/file`);
        } catch { catalog.errors.push(`${projectId}/file`); }
    }
}
async function walk(fs: IFileSystem, root: string, projectId: string, catalog: TwinSourceCatalog): Promise<void> {
    const queue = [root]; let visited = 0;
    while (queue.length) {
        for (const node of await fs.driver.getChildren(queue.shift()!)) {
            if (++visited > 100000 || catalog.resources.length >= 10000) throw new Error('TWIN_SOURCE_COUNT_LIMIT');
            if (node.metadata.isProtected || node.tags.includes('private') || node.name.startsWith('.') || node.name === 'node_modules') continue;
            if (node.type === 'directory') queue.push(node.path);
            else if (node.type === 'file' && documentPath(node.path)) catalog.resources.push({ kind: 'file', location: 'local', projectId,
                projectName: projectId.slice('@workspace/'.length), target: node.path, path: node.path.slice(root.length + 1),
                directoryPath: node.path, label: typeof node.metadata.title === 'string' ? node.metadata.title : node.name, version: String(node.version) });
        }
    }
}
