import { initApp, installMobileNavigation } from '@itookit/app-shell';
import { WORKSPACES } from 'mind-os/workspaces';
import { createBrowserUI } from 'mind-os/ui';
import { installHttpStatus } from './status-banner';
import { HttpViewClient } from './view-client';

export async function startApplicationClient(onProgress: (message: string) => void) {
    installMobileNavigation();
    const releaseStatus = installHttpStatus();
    const client = new HttpViewClient(crypto.randomUUID());
    try {
        const { services, backend, flowLibrary, fileTemplates } = await client.start();
        const app = await initApp({ services, backend, fileTemplates, workspaces: WORKSPACES,
            ui: createBrowserUI(flowLibrary), defaultSlug: 'chat', onProgress,
            routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' } });
        app.onDestroy(releaseStatus);
        app.onDestroy(() => client.close(), 'sources');
        return app;
    } catch (error) { releaseStatus(); await client.close().catch(() => {}); throw error; }
}
