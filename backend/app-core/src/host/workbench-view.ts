import type { SessionBrowserDependencies, SessionOpenView, WorkbenchView } from '@itookit/app-contracts/services';
import { createSessionBrowser } from '../session/session-browser';
import { SessionLifecycleService } from '../session/session-lifecycle';
import { ProjectSearch } from '../projects/project-search';

/** Prepare independent observations together, releasing both if either preparation fails. */
export async function prepareWorkbenchView(deps: SessionBrowserDependencies, preload: boolean, initialNavigation: boolean,
    prepareSession?: () => Promise<SessionOpenView | undefined>): Promise<WorkbenchView> {
    const [workspace, session] = await Promise.allSettled([
        createWorkbenchView(deps, preload, initialNavigation), prepareSession?.(),
    ]);
    if (workspace.status === 'rejected' || session.status === 'rejected') {
        await Promise.allSettled([
            workspace.status === 'fulfilled' ? workspace.value.browser.dispose() : undefined,
            session.status === 'fulfilled' ? session.value?.dispose() : undefined,
        ]);
        throw workspace.status === 'rejected' ? workspace.reason : (session as PromiseRejectedResult).reason;
    }
    return {...workspace.value, initialSession: session.value};
}

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
