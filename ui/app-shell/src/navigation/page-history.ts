interface PageState { workspaceId: string; resourceId: string | null; mindosPage: number; mobileView?: string }

/** Only return within the application's own history; a direct link has a local fallback. */
export function backToPreviousPage(fallback: () => void): void {
    if (Number(history.state?.mindosPage) > 0) history.back();
    else {
        fallback();
        if (history.state?.mindosPage !== undefined) history.replaceState({...history.state, mobileView: 'list'}, '');
    }
}

export function writePageHistory(workspaceId: string, resourceId: string | null, hash: string,
    mode: 'push' | 'replace', mobileView?: string): void {
    const page = Number(history.state?.mindosPage) || 0;
    if (location.hash === hash && history.state?.mindosPage !== undefined) return;
    const push = mode === 'push' && location.hash !== hash && history.state?.mindosPage !== undefined;
    const state: PageState = {workspaceId, resourceId, mindosPage: page + Number(push), mobileView};
    if (push) history.pushState(state, '', hash); else history.replaceState(state, '', hash);
}
