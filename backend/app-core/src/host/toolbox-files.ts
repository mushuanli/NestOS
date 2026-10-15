import { createFileSystemView, type IFileSystem } from '@itookit/vfs-core';
import { TOOLBOX_KINDS, type ToolboxKind } from '@itookit/app-contracts';

/** Resolve granted mount boundaries and link checks where their storage lives. */
export function createToolboxFiles(sources: Record<ToolboxKind, IFileSystem>) {
    return createFileSystemView({ viewId: 'toolbox:admin', mounts: TOOLBOX_KINDS.map(kind => ({
        mountId: kind, at: '/' + kind, fs: sources[kind],
        access: ['prompts', 'mcp', 'tools', 'providers', 'connections'].includes(kind) ? 'ro' : 'rw' })) });
}
