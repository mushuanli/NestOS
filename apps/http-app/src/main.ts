import { createApplicationRuntime } from '@itookit/app-core';
import { initApp, installMobileNavigation, windowSessionLeaseToken } from '@itookit/app-shell';
import { createPiAgentDriver } from '@itookit/piagent-driver';
import { WORKSPACES } from 'mind-os/workspaces';
import { BrowserSkillToolHandlerFactory } from 'mind-os/skill-tools';
import { createBrowserUI } from 'mind-os/ui';
import { HttpStorageBackend } from './client/backend';

async function main(): Promise<void> {
    installMobileNavigation();
    const runtime = await createApplicationRuntime({
        backend: new HttpStorageBackend(),
        remoteSourceProvider: createPiAgentDriver(),
        ownerKind: 'web',
        sessionOwnerToken: windowSessionLeaseToken(),
        kernelPlatform: { skillToolHandlerFactory: new BrowserSkillToolHandlerFactory() },
    });
    try {
        await initApp({ runtime, workspaces: WORKSPACES, defaultSlug: 'chat',
            routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' },
            ui: createBrowserUI() });
    } catch (error) { await runtime.dispose(); throw error; }
}

main().catch(error => console.error('[Bootstrap] Fatal:', error));
