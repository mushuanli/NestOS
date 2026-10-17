/** Keep the app inside the visible viewport when mobile keyboards resize it. */
export function installMobileViewport(): () => void {
    const viewport = window.visualViewport;
    if (!viewport) return () => {};
    const root = document.documentElement, property = '--app-visible-height';
    const previous = root.style.getPropertyValue(property);
    const sync = () => {
        if (!window.matchMedia('(max-width: 768px)').matches) { root.style.removeProperty(property); return; }
        if (viewport.scale !== 1) return;
        root.style.setProperty(property, `${Math.round(viewport.height)}px`);
    };
    viewport.addEventListener('resize', sync); window.addEventListener('resize', sync); sync();
    return () => {
        viewport.removeEventListener('resize', sync); window.removeEventListener('resize', sync);
        if (previous) root.style.setProperty(property, previous); else root.style.removeProperty(property);
    };
}
