import {createBrowserImageTools} from '@itookit/image-tools/browser';
import { createNestosLlmPresets } from '@itookit/kernel-adapters/llm/presets';
import { SnapshotService } from './storage/snapshots';
import { createApplicationClient, bindLocalApplicationServices } from '@itookit/app-core/host';
import { configureAppCache } from './app-cache';
import { createNestOSNodeDriver } from '@itookit/nestos-node-driver';
import { initApp, installMobileNavigation, windowSessionLeaseToken } from '@itookit/app-shell';
import { createApplicationRuntime, createNestosFlowLibrary } from '@itookit/app-core';
import { openIndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { createBrowserUI } from './ui';
import { WORKSPACES, ROUTE_ALIASES } from './config/modules';
import {createStartupStatus, stylesReady} from './startup';
import { BrowserSkillToolHandlerFactory } from './kernel/browser-skill-tools';
import { WebProjectSync } from './sync';

// Dev must always load the current workspace source graph.
void configureAppCache(import.meta.env.DEV).catch(error => console.warn('App cache setup failed', error));

async function main(styles: Promise<void>) {
    installMobileNavigation();
    const {runtime, client, sync} = await createLocalClient();
    try {
        await styles;
        const app = await initApp({
            fileTemplates: { agent: JSON.stringify(createNestosLlmPresets().agents, null, 2) },
            ...client,
            projectSyncSetup: (id, signal) => sync.setup(id, signal),
            projectSyncDirectory: (id, signal) => sync.directory(id, signal),
            workspaces: WORKSPACES,
            defaultSlug: 'start', startPage: true,
            routeAliases: ROUTE_ALIASES,
            ui: createBrowserUI(createNestosFlowLibrary()),
        });
        app.onDestroy(() => runtime.dispose(), 'sources');
        app.onDestroy(() => client.close(), 'sources');
    } catch (error) {
        try { await client.close(); } finally { await runtime.dispose(); }
        throw error;
    }
}

async function createLocalClient() {
    const backend = await openIndexedDBBackend({dbName: 'MindOS-v3'}), remoteSourceProvider = createNestOSNodeDriver();
    const sync = new WebProjectSync(backend, remoteSourceProvider);
    const runtime = await createApplicationRuntime({
        startupMode: 'interactive', remoteSourceProvider, backend, ownerKind: 'web',
        sync: {provider: sync, coordinator: sync.coordinator},
        // Same tab keeps its lease identity across reloads; other tabs keep their own.
        sessionOwnerToken: windowSessionLeaseToken(),
        kernelPlatform: {additionalTools: createBrowserImageTools(), skillToolHandlerFactory: new BrowserSkillToolHandlerFactory()},
    });
    try {
        const client = createApplicationClient(bindLocalApplicationServices(runtime), {snapshots: vfs => new SnapshotService(vfs, 'MindOS-v3')});
        sync.projects = runtime.projects; sync.service = runtime.projectSync;
        return {runtime, client, sync};
    } catch (error) {await runtime.dispose(); throw error;}
}

const startup = createStartupStatus(), styles = stylesReady();
void Promise.all([main(styles), styles]).catch(error => {
    console.error('[Bootstrap] Fatal:', error); startup.fail(error);
});
