import { initApp, installMobileNavigation } from '@itookit/app-shell';
import { WORKSPACES } from 'mind-os/workspaces';
import { createBrowserUI } from 'mind-os/ui';
import { installHttpStatus } from './status-banner';
import { HttpViewClient, ViewExpiredError } from '@itookit/app-transport/http';

export async function startApplicationClient(onProgress: (message: string) => void, onShellReady?: () => void) {
    installMobileNavigation();
    const releaseStatus = installHttpStatus();
    const listeners = new AbortController();
    const client = new HttpViewClient(crypto.randomUUID(), '/api/application', globalThis.fetch.bind(globalThis),
        error => window.dispatchEvent(new CustomEvent('mindos:http-disconnected', {detail: {state: error instanceof ViewExpiredError ? 'expired' : 'reconnecting'}})),
        () => window.dispatchEvent(new CustomEvent('mindos:http-view-error')),
        () => window.dispatchEvent(new CustomEvent('mindos:http-reconnected')));
    for (const event of ['online', 'focus', 'mindos:http-retry']) window.addEventListener(event, () => client.retryConnection(), {signal: listeners.signal});
    try {
        const { services, backend, flowLibrary, fileTemplates } = await client.start();
        const app = await initApp({ services, backend, fileTemplates, workspaces: WORKSPACES,
            ui: createBrowserUI(flowLibrary), defaultSlug: 'start', startPage: true, onProgress, onShellReady,
            routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' } });
        app.onDestroy(() => { listeners.abort(); releaseStatus(); });
        app.onDestroy(() => client.close(), 'sources');
        return app;
    } catch (error) { listeners.abort(); releaseStatus(); await client.close().catch(() => {}); throw error; }
}
