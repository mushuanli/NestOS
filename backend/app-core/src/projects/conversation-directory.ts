import { CHAT_ICONS, harnessPresentation, t } from '@itookit/common';
import { projectConversationsPath, projectConversationEntryPath, remoteSessionPath, type BrowserTarget } from '@itookit/app-contracts';
import type { FSNode } from '@itookit/vfs-core';
import type { RemoteSessionProjection } from '../session/remote-session-projection';
import { localConversationSource, readConversationPage } from './conversation-page';

function aliasNode(directory: string, node: FSNode): FSNode {
    return {...node, path: projectConversationEntryPath(directory, node.path), parentPath: directory,
        name: '@entry:' + encodeURIComponent(node.path), metadata: {...node.metadata, navigationTarget: node.path}};
}
function unavailableNode(folder: string, source: string): FSNode {
    const node = conversationDirectoryNode(folder);
    return {...node, path: remoteSessionPath(folder, source === 'remote' ? undefined : source.replace(/^remote:/, '')), type: 'file', size: 0,
        metadata: {...node.metadata, title: t('project.sourceUnavailable', {name: harnessPresentation(source.replace(/^remote:/, '')).label}), _disabled: true}};
}
function continuationNode(directory: string, target: Extract<BrowserTarget, {kind: 'project-conversations'}>, cursor: string): FSNode {
    const node = conversationDirectoryNode(target.folder);
    if (target.recent) return aliasNode(directory, {...node, metadata: {...node.metadata, title: t('project.moreConversations'), conversationMore: true}});
    const path = directory + '/@page:' + encodeURIComponent(cursor);
    return {...node, path, name: path.slice(path.lastIndexOf('/') + 1), parentPath: directory,
        metadata: {...node.metadata, title: t('harness.more'), conversationMore: true, navigationTarget: path}};
}

export function conversationDirectoryNode(folder: string, recent = false, cursor?: string): FSNode {
    const path = projectConversationsPath(folder, {recent, cursor});
    return {path, name: path.slice(path.lastIndexOf('/') + 1), parentPath: path.slice(0, path.lastIndexOf('/')), type: 'directory',
        createdAt: 0, modifiedAt: 0, version: 1, tags: [], icon: CHAT_ICONS.more,
        metadata: {title: t('project.conversations'), _readOnly: true, _fixedEntry: true, _showAll: true, _fileDetails: false,
            ...(recent ? {navigationTransparent: true, directoryPath: projectConversationsPath(folder)} : {})}};
}
export function conversationNavigationNodes(folder: string): FSNode[] {
    const full = conversationDirectoryNode(folder);
    return [conversationDirectoryNode(folder, true), {...full, metadata: {...full.metadata, navigationHidden: true}}];
}

export async function conversationDirectory(directory: string, target: Extract<BrowserTarget, {kind: 'project-conversations'}>,
    local: Promise<FSNode[]>, remote: () => ReturnType<RemoteSessionProjection['timeline']>): Promise<FSNode[]> {
    const localNodes = await local, timeline = await remote();
    try {
        const page = await readConversationPage([localConversationSource(localNodes), ...timeline.sources], target.cursor, target.recent ? 15 : 50);
        const errors = page.errors.map(({source}) => unavailableNode(target.folder, source));
        const actions = target.recent ? [] : timeline.actions.filter(action => !action.path.endsWith('/@new'));
        const nodes = [...actions, ...page.nodes, ...errors].map(node => aliasNode(directory, node));
        if (page.cursor) nodes.push(continuationNode(directory, target, page.cursor));
        return nodes;
    } finally {await timeline.close();}
}
