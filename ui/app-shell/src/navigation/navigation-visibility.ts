/** Hidden navigation has no read or observation work; current content owns its own lifecycle. */
export function observeNavigationVisibility(layout: HTMLElement, sidebar: HTMLElement, changed: (visible: boolean) => void): () => void {
    const workspace = layout.closest('.workspace-view'), media = window.matchMedia?.('(max-width: 768px)');
    let previous: boolean | undefined;
    const sync = () => {
        const section = sidebar.querySelector('.workbench-sidebar__section[data-section="navigation"]');
        const visible = !!workspace?.classList.contains('active') && !sidebar.classList.contains('is-collapsed')
            && !(section?.hasAttribute('hidden') || section?.classList.contains('is-collapsed'))
            && (!media?.matches || layout.dataset.mobileView === 'list');
        if (previous !== visible) { previous = visible; changed(visible); }
    };
    const observer = new MutationObserver(sync);
    for (const element of [workspace, layout, sidebar]) if (element) observer.observe(element, {attributes: true, attributeFilter: ['class', 'data-mobile-view']});
    observer.observe(sidebar, {subtree: true, attributes: true, attributeFilter: ['class', 'hidden']});
    media?.addEventListener?.('change', sync); sync();
    return () => {observer.disconnect(); media?.removeEventListener?.('change', sync);};
}
