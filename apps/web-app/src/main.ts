import { configureAppCache } from './app-cache';
import { createPiAgentDriver } from '@itookit/piagent-driver';
import { initApp, installMobileNavigation, windowSessionLeaseToken } from '@itookit/app-shell';
import { createApplicationRuntime } from '@itookit/app-core';
import { openIndexedDBBackend } from '@itookit/vfsdriver-indexeddb';
import { createBrowserUI } from './ui';
import { WORKSPACES } from './config/modules';
import { BrowserSkillToolHandlerFactory } from './kernel/browser-skill-tools';
import { WebProjectSync } from './sync';

// Dev must always load the current workspace source graph.
void configureAppCache(import.meta.env.DEV).catch(error => console.warn('App cache setup failed', error));

async function main() {
    installMobileNavigation();
    const backend = await openIndexedDBBackend({ dbName: 'MindOS-v3' });
    const ui = createBrowserUI();
    const remoteSourceProvider = createPiAgentDriver();
    const sync = new WebProjectSync(backend, remoteSourceProvider);
    const runtime = await createApplicationRuntime({
        remoteSourceProvider,
        sync: { provider: sync, coordinator: sync.coordinator },
        backend,
        ownerKind: 'web',
        // Same tab keeps its lease identity across reloads; other tabs keep their own.
        sessionOwnerToken: windowSessionLeaseToken(),
        kernelPlatform: {
            skillToolHandlerFactory: new BrowserSkillToolHandlerFactory(),
        },
    });
    sync.projects = runtime.projects;
    sync.service = runtime.projectSync;
    try {
        await initApp({
            runtime,
            projectSyncSetup: (id, signal) => sync.setup(id, signal),
            projectSyncDirectory: (id, signal) => sync.directory(id, signal),
            workspaces: WORKSPACES,
            defaultSlug: 'chat',
            routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' },
            ui,
        });
    } catch (error) {
        await runtime.dispose();
        throw error;
    }
}

main().catch(err => console.error('[Bootstrap] Fatal:', err));
