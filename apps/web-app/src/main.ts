import { createMindosLlmPresets } from '@itookit/kernel-adapters/llm/presets';
import { SnapshotService } from './storage/snapshots';
import { createApplicationClient, bindLocalApplicationServices } from '@itookit/app-core/host';
import { configureAppCache } from './app-cache';
import { createPiAgentDriver } from '@itookit/piagent-driver';
import { initApp, installMobileNavigation, windowSessionLeaseToken } from '@itookit/app-shell';
import { createApplicationRuntime, createMindosFlowLibrary } from '@itookit/app-core';
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
    const ui = createBrowserUI(createMindosFlowLibrary());
    const remoteSourceProvider = createPiAgentDriver();
    const sync = new WebProjectSync(backend, remoteSourceProvider);
    const runtime = await createApplicationRuntime({
        startupMode: 'interactive',
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
    const client = createApplicationClient(bindLocalApplicationServices(runtime), { snapshots: vfs => new SnapshotService(vfs, 'MindOS-v3') });
    sync.projects = runtime.projects;
    sync.service = runtime.projectSync;
    try {
        const app = await initApp({
            fileTemplates: { agent: JSON.stringify(createMindosLlmPresets().agents, null, 2) },
            ...client,
            projectSyncSetup: (id, signal) => sync.setup(id, signal),
            projectSyncDirectory: (id, signal) => sync.directory(id, signal),
            workspaces: WORKSPACES,
            defaultSlug: 'chat',
            routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' },
            ui,
        });
        app.onDestroy(() => runtime.dispose(), 'sources');
        app.onDestroy(() => client.close(), 'sources');
    } catch (error) {
        try { await client.close(); } finally { await runtime.dispose(); }
        throw error;
    }
}

main().catch(err => console.error('[Bootstrap] Fatal:', err));
