import { createApplicationRuntime } from '@itookit/app-core';
import { initApp, installMobileNavigation, windowSessionLeaseToken } from '@itookit/app-shell';
import { createPiAgentDriver } from '@itookit/piagent-driver';
import { WORKSPACES } from 'mind-os/workspaces';
import { BrowserSkillToolHandlerFactory } from 'mind-os/skill-tools';
import { createBrowserUI } from 'mind-os/ui';
import { HttpStorageBackend } from './client/backend';
import { installHttpStatus } from './client/status-banner';
import { createStartupStatus } from './client/startup-status';

const startup = createStartupStatus();
async function main(): Promise<void> {
    installHttpStatus();
    installMobileNavigation();
    const runtime = await createApplicationRuntime({
        onProgress: message => startup.progress(message),
        backend: new HttpStorageBackend(),
        remoteSourceProvider: createPiAgentDriver(),
        ownerKind: 'web',
        sessionOwnerToken: windowSessionLeaseToken(),
        kernelPlatform: { skillToolHandlerFactory: new BrowserSkillToolHandlerFactory() },
    });
    try {
        await initApp({ runtime, workspaces: WORKSPACES, defaultSlug: 'chat',
            onProgress: message => startup.progress(message),
            routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' },
            ui: createBrowserUI() });
    } catch (error) { await runtime.dispose(); throw error; }
    startup.ready();
}

main().catch(error => { console.error('[Bootstrap] Fatal:', error); startup.fail(error); });
