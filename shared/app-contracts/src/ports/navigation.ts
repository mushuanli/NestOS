import type { FSNode, FileSystemContext } from '@itookit/vfs-core';

/** Read metadata only; ignore-file text avoids extra discovery probes during first rendering. */
export interface NavigationDirectory {
    revision: number;
    stale?: boolean;
    node: FSNode | null;
    nodes: FSNode[];
    ignore?: { node: FSNode | null; content?: string };
}
export interface NavigationView {
    files: FileSystemContext;
    documents: Record<string, unknown>;
    directory: NavigationDirectory;
}
