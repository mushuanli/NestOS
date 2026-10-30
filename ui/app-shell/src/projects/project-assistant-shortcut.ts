import {conversationResourcePath, resolveBrowserTarget} from '@itookit/app-contracts';
import type {VFSNodeUI} from '@itookit/vfs-ui';
import type {ShortcutRequest} from '../navigation/assistant-actions';

export function projectAssistantShortcut(item: VFSNodeUI): ShortcutRequest {
    const title = item.metadata.title || item.id;
    const resource = conversationResourcePath(item.id);
    const projectId = item.metadata.custom.projectId;
    const context = typeof item.metadata.custom.projectName === 'string' ? item.metadata.custom.projectName : undefined;
    if (typeof projectId === 'string' && item.type === 'directory' && !resource.includes('/@'))
        return {title, context, target: {kind: 'directory', projectId, path: ''}};
    // Flow paths are separate from session routes and must retain their namespace.
    if (!resource.startsWith('/@flows')) {
        try {
            const target = resolveBrowserTarget(resource);
            if (target.kind === 'session') return {title, context, target: {kind: 'resource', workspace: 'chat', resource: target.sessionId}};
        } catch { /* Other project navigation entries retain their canonical route. */ }
    }
    return {title, context, target: {kind: 'resource', workspace: 'chat', resource}};
}
