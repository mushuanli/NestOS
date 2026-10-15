import type { SessionBrowserDependencies, WorkbenchView } from '@itookit/app-contracts/services';
import { createSessionBrowser } from '../session/session-browser';
import { SessionLifecycleService } from '../session/session-lifecycle';
import { ProjectSearch } from '../projects/project-search';

/** Assemble one workspace read model where the repository and file queries execute. */
export async function createWorkbenchView(deps: SessionBrowserDependencies, preload = false): Promise<WorkbenchView> {
    const lifecycle = deps.lifecycle ?? new SessionLifecycleService({ repository: deps.repository, kernel: deps.kernel });
    const browser = await createSessionBrowser({ ...deps, lifecycle });
    if (!preload) return { browser, lifecycle, search: deps.projects ? new ProjectSearch(deps.projects) : undefined };
    try {
        const [node, nodes, navigation] = await Promise.all([browser.fs.driver.getNode('/'), browser.fs.driver.getChildren('/'),
            deps.projects?.sessions.navigation({ includeSessions: false })]);
        return { browser, lifecycle, search: deps.projects ? new ProjectSearch(deps.projects) : undefined,
            navigation,
            directory: { revision: browser.fs.revision, node, nodes } };
    } catch (error) { await browser.dispose(); throw error; }
}
