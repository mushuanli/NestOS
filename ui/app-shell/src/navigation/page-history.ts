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
    if (location.hash === hash && history.state?.nestosPage !== undefined) return;
    const push = mode === 'push' && location.hash !== hash && history.state?.nestosPage !== undefined;
    const state: PageState = {workspaceId, resourceId, nestosPage: page + Number(push), mobileView};
    if (push) history.pushState(state, '', hash); else history.replaceState(state, '', hash);
}
