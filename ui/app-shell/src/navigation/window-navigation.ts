import {t} from '@itookit/common';
const navigationLeases = new WeakMap<HTMLElement, () => void>();

/** Borrow the real program navigation, preserving its nodes, listeners and live state. */
export function mountApplicationNavigation(container: HTMLElement, close: () => void): (() => void) | undefined {
    const navigation = document.querySelector<HTMLElement>('.app-sidebar');
    if (!navigation) return;
    navigationLeases.get(navigation)?.();
    const anchor = document.createComment('application navigation'); navigation.before(anchor);
    const lifetime = new AbortController(); let released = false;
    container.append(navigation);
    navigation.addEventListener('click', event => {
        const button = (event.target as Element).closest('button, a');
        if (button && !button.matches(':disabled')) close();
    }, {capture: true, signal: lifetime.signal});
    const release = () => {
        if (released) return; released = true; lifetime.abort();
        if (anchor.isConnected) anchor.replaceWith(navigation); else navigation.remove();
        if (navigationLeases.get(navigation) === release) navigationLeases.delete(navigation);
    };
    navigationLeases.set(navigation, release); return release;
}

/** Reveal the current module's navigation without opening a resource or discarding its editors. */
export function revealWorkspaceNavigation(container?: HTMLElement | null): void {
    const layout = container?.closest<HTMLElement>('.mm-layout'), sidebar = layout?.querySelector<HTMLElement>('.mm-sidebar');
    if (!layout || !sidebar) throw Object.assign(new Error(t('workbench.navigationUnavailable')), {code: 'WORKSPACE_NAVIGATION_UNAVAILABLE'});
    sidebar.hidden = false; sidebar.inert = false; sidebar.classList.remove('is-collapsed');
    delete layout.dataset.workspaceOpening; layout.dataset.mobileView = 'list';
}
