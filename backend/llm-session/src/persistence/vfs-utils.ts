// @file: llm-conversation/src/persistence/vfs-utils.ts
// Shared VFS traversal utilities used by SessionRepository.

import type { FSNode } from '@itookit/vfs-core';

/**
 * Recursively collect all file nodes under the given directory listing.
 * Skips directories that cannot be read (permissions, transient errors).
 */
export async function collectAllFileNodes(
    getChildren: (path: string) => Promise<FSNode[]>,
    nodes: FSNode[],
): Promise<FSNode[]> {
    const result: FSNode[] = [];
    for (const node of nodes) {
        if (node.type === 'file') {
            result.push(node);
        } else if (node.type === 'directory') {
            try {
                const children = await getChildren(node.path);
                result.push(...await collectAllFileNodes(getChildren, children));
            } catch { /* ignore unreadable directories */ }
        }
    }
    return result;
}
