import type { SessionBrowserDependencies, WorkbenchView } from '@itookit/app-contracts/services';
import { createSessionBrowser } from '../session/session-browser';
import { SessionLifecycleService } from '../session/session-lifecycle';
import { ProjectSearch } from '../projects/project-search';

/** Assemble one workspace read model where the repository and file queries execute. */
export async function createWorkbenchView(deps: SessionBrowserDependencies, preload = false, initialNavigation = true): Promise<WorkbenchView> {
    const lifecycle = deps.lifecycle ?? new SessionLifecycleService({ repository: deps.repository, kernel: deps.kernel });
    const browser = await createSessionBrowser({ ...deps, lifecycle });
    try {
        const [directory, navigation] = await Promise.all([
            preload && initialNavigation ? Promise.all([browser.fs.driver.getNode('/'), browser.fs.driver.getChildren('/')]) : undefined,
            initialNavigation ? deps.projects?.navigation({ path: '/' }) : undefined]);
        return { browser, lifecycle, search: deps.projects ? new ProjectSearch(deps.projects) : undefined,
            navigation,
            directory: directory ? { revision: browser.fs.revision, node: directory[0], nodes: directory[1] } : undefined };
    } catch (error) { await browser.dispose(); throw error; }
}
