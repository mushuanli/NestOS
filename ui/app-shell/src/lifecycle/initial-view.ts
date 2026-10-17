import {parseSessionRoute, resolveBrowserTarget} from '@itookit/app-contracts';
import type {ApplicationBackend, OpenedApplicationView} from '@itookit/app-contracts/services';

export function openInitialView(backend: ApplicationBackend, documents: string[], resource?: string): Promise<OpenedApplicationView> {
    return backend.openView(initialViewRequest(documents, resource));
}

export function initialViewRequest(documents: string[], resource?: string) {
    let initialSessionId: string | undefined, branch: string | undefined;
    try {
        const route = resource ? parseSessionRoute(resource) : undefined;
        const target = route && resolveBrowserTarget(route.path);
        if (target?.kind === 'session') {initialSessionId = target.sessionId; branch = route?.branch;}
    } catch { /* The normal resource loader owns malformed-route diagnostics. */ }
    return {documents, branch, taskAttachmentKey: 'ui.privileged.active-task',
        workbench: {chatControls: true, initialNavigation: !resource, initialSessionId, displayedFilesPolicy: 'gitignore' as const}};
}
