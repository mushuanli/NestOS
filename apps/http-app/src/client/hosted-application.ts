import {initApp, installMobileNavigation, type AppHandle, type AppRecoveryState} from '@itookit/app-shell';
import {WORKSPACES, ROUTE_ALIASES} from 'nestos-web/workspaces';
import {createBrowserUI} from 'nestos-web/ui';
import {installHttpStatus} from './status-banner';
import {connectApplication, type ApplicationConnection} from './application-connection';
import {stylesReady} from './styles-ready';
import {ViewRecovery} from './view-recovery';

export async function startApplicationClient(onProgress: (message: string) => void, onShellReady?: () => void,
    connection: ApplicationConnection = connectApplication()): Promise<AppHandle> {
    if (!performance.getEntriesByName('nestos:entry').length) performance.mark('nestos:entry');
    installMobileNavigation();
    let activeConnection = connection, releaseStatus = () => {};
    const open = async (recovery?: AppRecoveryState) => mount(activeConnection, onProgress, onShellReady, recovery);
    const initial = await open();
    const owner = new ViewRecovery<AppRecoveryState, AppHandle>(initial, async state => {
        activeConnection = connectApplication();
        const next = await open(state);
        watch(); return next;
    });
    function watch(): void {
        releaseStatus();
        releaseStatus = installHttpStatus({connection: activeConnection, recover: () => owner.recover()});
    }
    watch();
    return new Proxy(initial, {get: (_target, key) => {
        if (key === 'destroy') return async () => {releaseStatus(); await owner.close();};
        const value = Reflect.get(owner.current, key);
        return typeof value === 'function' ? value.bind(owner.current) : value;
    }});
}

async function mount(connection: ApplicationConnection, onProgress: (message: string) => void,
    onShellReady?: () => void, recovery?: AppRecoveryState): Promise<AppHandle> {
    try {
        const [{services, backend, flowLibrary, fileTemplates, initialView}] = await Promise.all([connection.ready, stylesReady()]);
        const app = await initApp({services, backend, fileTemplates, workspaces: WORKSPACES, initialView, recovery,
            ui: createBrowserUI(flowLibrary), defaultSlug: 'start', startPage: true, onProgress, onShellReady,
            onEditorReady: markEditorReady, routeAliases: ROUTE_ALIASES});
        app.onDestroy(() => connection.close(), 'sources');
        return app;
    } catch (error) {await connection.close().catch(() => {}); throw error;}
}

function markEditorReady(): void {
    performance.mark('nestos:editor-ready');
    performance.measure('nestos:entry-to-editor', 'nestos:entry', 'nestos:editor-ready');
    if (performance.getEntriesByName('nestos:document').length)
        performance.measure('nestos:document-to-editor', 'nestos:document', 'nestos:editor-ready');
}
