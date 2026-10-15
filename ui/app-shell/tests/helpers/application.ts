import { createApplicationClient, bindApplicationBackend } from '@itookit/app-core/host';
import type { LocalApplicationServices } from '@itookit/app-contracts/services';
import { SessionWorkbench, type SessionWorkbenchOptions } from '../../src/projects/SessionWorkbench';
import type { AppOptions } from '../../src/types';

export function createTestWorkbench(options: Omit<SessionWorkbenchOptions, 'backend'>): SessionWorkbench {
    const backend = bindApplicationBackend({ sessionRepository: options.repository, sessionFiles: options.files,
        projects: options.projects, kernel: { kernel: options.kernel } } as LocalApplicationServices);
    return new SessionWorkbench({ ...options, backend });
}
export async function initTestApp(options: Omit<AppOptions, 'backend'>) {
    const client = createApplicationClient(options.services as LocalApplicationServices);
    const { initApp } = await import('../../src/bootstrap');
    return initApp({ ...options, ...client });
}
