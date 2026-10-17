/** Project the active screen onto the shell without relying on CSS relational selectors. */
export function installMobileShellState(): () => void {
    const body = document.body, previous = body.dataset.mobileNavigation;
    const abort = new AbortController(); let closed = false;
    const sync = () => {
        if (closed) return;
        const workspace = body.querySelector('.workspace-view.active');
        const layout = workspace?.querySelector<HTMLElement>('.mm-layout');
        const immersive = layout?.dataset.mobileView === 'detail' && layout.dataset.mobileHeader === 'embedded';
        const focused = document.activeElement;
        const composing = focused instanceof Element && workspace?.contains(focused)
            && focused.closest('[data-editor-composing="true"]') && !focused.closest('[hidden]');
        const state = immersive ? 'immersive' : composing ? 'composing' : 'standard';
        if (body.dataset.mobileNavigation !== state) body.dataset.mobileNavigation = state;
    };
    const observer = new MutationObserver(sync);
    observer.observe(body, {subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'hidden', 'data-mobile-view', 'data-mobile-header', 'data-editor-composing']});
    document.addEventListener('focusin', sync, {signal: abort.signal});
    document.addEventListener('focusout', () => queueMicrotask(sync), {signal: abort.signal});
    sync();
    return () => {
        closed = true; observer.disconnect(); abort.abort();
        if (previous === undefined) delete body.dataset.mobileNavigation; else body.dataset.mobileNavigation = previous;
    };
}
