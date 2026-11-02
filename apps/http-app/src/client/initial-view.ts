import {initialViewRequest, INITIAL_CHAT_DOCUMENTS, parseWorkspaceHash} from '@itookit/app-shell/startup';
import {ROUTE_ALIASES} from 'nestos-web/workspaces';
import {parseSessionRoute, resolveBrowserTarget} from '@itookit/app-contracts';

export function initialView(hash: string) {
    const route = parseWorkspaceHash(hash, 'start');
    const chat = route.slug === 'chat' || Object.hasOwn(ROUTE_ALIASES, route.slug);
    return {request: chat ? initialViewRequest(INITIAL_CHAT_DOCUMENTS, route.resource) : undefined,
        editor: chat ? chatEditor(route.resource) : route.slug};
}

function chatEditor(resource?: string): 'chat' | undefined {
    if (!resource) return;
    if (resource.replace(/^\//, '').startsWith('draft:')) return 'chat';
    try {
        const target = resolveBrowserTarget(parseSessionRoute(resource).path);
        if (target.kind === 'session' || target.kind === 'project-draft'
            || target.kind === 'remote' && (target.nativeSessionId || target.draft)) return 'chat';
    } catch { /* The resource loader reports invalid routes without fetching an unrelated editor. */ }
}
