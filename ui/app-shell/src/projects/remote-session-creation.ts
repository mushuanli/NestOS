import {resolveBrowserTarget} from '@itookit/app-contracts';
import type {FSNode} from '@itookit/vfs-core';

/** Use the backend's advertised draft entry without probing the remote provider again. */
export function remoteSessionCreationPath(path: string, nodes: readonly FSNode[]): string | undefined {
    const target = resolveBrowserTarget(path);
    if (target.kind !== 'remote' || !target.profileId || target.nativeSessionId || target.draft || target.archived) return;
    return nodes.find(node => {
        if (node.metadata._disabled) return false;
        const entry = resolveBrowserTarget(node.path);
        return entry.kind === 'remote' && entry.draft && entry.folder === target.folder && entry.profileId === target.profileId;
    })?.path;
}
