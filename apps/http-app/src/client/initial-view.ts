import {initialViewRequest, INITIAL_CHAT_DOCUMENTS, parseWorkspaceHash} from '@itookit/app-shell/startup';
import {ROUTE_ALIASES} from 'mind-os/workspaces';

export function initialView(hash: string) {
    const route = parseWorkspaceHash(hash, 'start');
    const chat = route.slug === 'chat' || Object.hasOwn(ROUTE_ALIASES, route.slug);
    return {request: chat ? initialViewRequest(INITIAL_CHAT_DOCUMENTS, route.resource) : undefined,
        editor: chat ? 'chat' : route.slug};
}
