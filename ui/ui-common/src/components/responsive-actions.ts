export interface ResponsiveActionsOptions {
    container: HTMLElement;
    toolbar: HTMLElement;
    actions: readonly HTMLElement[];
    minWidth: number;
    fallbackFocus: HTMLElement;
}

/** Move the original controls so handlers, disabled state and IDs stay intact. */
export function installResponsiveActions(options: ResponsiveActionsOptions): () => void {
    const entries = options.actions.map(action => {
        const marker = document.createComment('toolbar-action'); action.before(marker);
        return { action, marker };
    });
    let disposed = false, expanded = false;
    const update = () => {
        if (disposed) return;
        const wide = options.container.getBoundingClientRect().width >= options.minWidth;
        if (wide === expanded) return;
        expanded = wide;
        const focused = document.activeElement;
        for (const { action, marker } of entries) wide ? options.toolbar.append(action) : marker.after(action);
        if (entries.some(({ action }) => action === focused)) {
            (wide ? focused as HTMLElement : options.fallbackFocus).focus({ preventScroll: true });
        }
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(options.container);
    window.addEventListener('resize', update); update();
    return () => {
        disposed = true; observer?.disconnect(); window.removeEventListener('resize', update);
        for (const { action, marker } of entries) { marker.after(action); marker.remove(); }
    };
}
