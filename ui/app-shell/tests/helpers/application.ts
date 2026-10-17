import { SessionCommand } from '@itookit/llm-session/contracts';
import { createApplicationClient, bindApplicationBackend } from '@itookit/app-core/host';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';
import { SessionWorkbench, type SessionWorkbenchOptions } from '../../src/projects/SessionWorkbench';
import type { AppOptions } from '../../src/types';

export function createTestWorkbench(options: Omit<SessionWorkbenchOptions, 'backend'>): SessionWorkbench {
    let snapshot: any;
    const backend = bindApplicationBackend({ sessionRepository: options.repository, sessionFiles: options.files,
        projects: options.projects, kernel: { kernel: options.kernel }, directoryMounts: options.directoryMounts,
        prepareSession: options.prepareSession,
        commandBus: { execute: async (command: string, args: any) => {
            if (command === 'vcs.branch.switch') { snapshot.view.manifest.currentBranch = args.branchName; return; }
            if (command === SessionCommand.GetSnapshot) return snapshot;
            const view = options.repository.getLoadState ? await options.repository.getLoadState(args.sessionId)
                : { manifest: await options.repository.getManifest(args.sessionId), settings: {} };
            snapshot = { view }; return snapshot;
        } } } as LocalApplicationServices);
    return new SessionWorkbench({ ...options, backend });
}
export async function initTestApp(options: Omit<AppOptions, 'backend'>) {
    const client = createApplicationClient(options.services as LocalApplicationServices);
    // Navigation fixtures provide partial services; full view opening uses real-runtime integration tests.
    const backend = {...client.backend}; delete (backend as Partial<typeof backend>).openView;
    const { initApp } = await import('../../src/bootstrap');
    return initApp({ ...options, ...client, backend });
}
