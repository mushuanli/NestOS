import { initApp, installMobileNavigation } from '@itookit/app-shell';
import { WORKSPACES, ROUTE_ALIASES } from 'mind-os/workspaces';
import { createBrowserUI } from 'mind-os/ui';
import { installHttpStatus } from './status-banner';
import {connectApplication, type ApplicationConnection} from './application-connection';
import {stylesReady} from './styles-ready';

export async function startApplicationClient(onProgress: (message: string) => void, onShellReady?: () => void,
    connection: ApplicationConnection = connectApplication()) {
    if (!performance.getEntriesByName('mindos:entry').length) performance.mark('mindos:entry');
    installMobileNavigation();
    const releaseStatus = installHttpStatus({connection});
    try {
        const [{services, backend, flowLibrary, fileTemplates, initialView}] = await Promise.all([connection.ready, stylesReady()]);
        const app = await initApp({ services, backend, fileTemplates, workspaces: WORKSPACES,
            initialView,
            ui: createBrowserUI(flowLibrary), defaultSlug: 'start', startPage: true, onProgress, onShellReady,
            onEditorReady: () => {
                performance.mark('mindos:editor-ready');
                performance.measure('mindos:entry-to-editor', 'mindos:entry', 'mindos:editor-ready');
                if (performance.getEntriesByName('mindos:document').length) performance.measure('mindos:document-to-editor', 'mindos:document', 'mindos:editor-ready');
            },
            routeAliases: ROUTE_ALIASES });
        app.onDestroy(releaseStatus);
        app.onDestroy(() => connection.close(), 'sources');
        return app;
    } catch (error) { releaseStatus(); await connection.close().catch(() => {}); throw error; }
}
