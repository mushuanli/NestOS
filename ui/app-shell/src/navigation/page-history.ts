import {createModuleLogger, randomUUID} from '@itookit/common';
import {MOBILE_NAVIGATION_QUERY} from '@itookit/ui-common';
const log = createModuleLogger('navigation-history');
export interface PagePresentation { mobileView?: string; navigationScope?: string }
interface PageState extends PagePresentation { workspaceId: string; resourceId: string | null; nestosPage: number }

/** Capture the page being left before opening a resource changes its sidebar or editor. */
export function rememberPagePresentation(presentation: PagePresentation): void {
    if (history.state?.nestosPage === undefined) return;
    history.replaceState({...history.state, ...presentation}, '');
}

/** Only return within the application's own history; a direct link has a local fallback. */
export function backToPreviousPage(fallback: () => void): void {
    if (Number(history.state?.nestosPage) > 0) history.back();
    else {
        fallback();
        if (history.state?.nestosPage !== undefined) history.replaceState({...history.state, mobileView: 'list'}, '');
    }
}

export function writePageHistory(workspaceId: string, resourceId: string | null, hash: string,
    mode: 'push' | 'replace', mobileView?: string): void {
    const page = Number(history.state?.nestosPage) || 0;
    const current = history.state as PageState | null;
    const same = location.hash === hash && current?.workspaceId === workspaceId && current.resourceId === resourceId
        && (mobileView === undefined || current.mobileView === mobileView);
    if (same && current?.nestosPage !== undefined) return;
    const push = mode === 'push' && !same && current?.nestosPage !== undefined;
    const state: PageState = {workspaceId, resourceId, nestosPage: page + Number(push), mobileView};
    const operationId=randomUUID(), started=performance.now(), stage=push?'push':'replace';
    try {
        if (push) history.pushState(state, '', hash); else history.replaceState(state, '', hash);
        log.debug('history.write', {operation: 'navigation.history', operationId, stage, result: 'success', page: state.nestosPage, durationMs: Math.round(performance.now()-started)});
    } catch(error) {
        log.warn('history.write', {operation: 'navigation.history', operationId, stage, result: 'failure', code: 'HISTORY_WRITE_FAILED',
            errorType: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now()-started)});
        throw error;
    }
}

/** Every responsive title control shares the same mobile Back policy. */
export function navigateWorkspaceBack(container:HTMLElement, toggleSidebar?:()=>void):void {
    const layout=container.closest<HTMLElement>('.mm-layout');
    if (window.matchMedia?.(MOBILE_NAVIGATION_QUERY).matches)
        backToPreviousPage(()=>{if(layout)layout.dataset.mobileView='list';});
    else if(toggleSidebar)toggleSidebar();
    else layout?.querySelector('.mm-sidebar')?.classList.toggle('is-collapsed');
}
