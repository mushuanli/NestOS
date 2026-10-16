import { initApp, installMobileNavigation } from '@itookit/app-shell';
import { WORKSPACES } from 'mind-os/workspaces';
import { createBrowserUI } from 'mind-os/ui';
import { installHttpStatus } from './status-banner';
import { HttpViewClient } from '@itookit/app-transport/http';

export async function startApplicationClient(onProgress: (message: string) => void, onShellReady?: () => void) {
    installMobileNavigation();
    const releaseStatus = installHttpStatus();
    const client = new HttpViewClient(crypto.randomUUID(), '/api/application', globalThis.fetch.bind(globalThis), () => window.dispatchEvent(new CustomEvent('mindos:http-disconnected')));
    try {
        const { services, backend, flowLibrary, fileTemplates } = await client.start();
        const app = await initApp({ services, backend, fileTemplates, workspaces: WORKSPACES,
            ui: createBrowserUI(flowLibrary), defaultSlug: 'start', startPage: true, onProgress, onShellReady,
            routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' } });
        app.onDestroy(releaseStatus);
        app.onDestroy(() => client.close(), 'sources');
        return app;
    } catch (error) { releaseStatus(); await client.close().catch(() => {}); throw error; }
}
