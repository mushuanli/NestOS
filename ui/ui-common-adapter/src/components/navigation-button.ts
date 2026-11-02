import {ACTION_ICONS, t} from '@itookit/common';
import {MOBILE_NAVIGATION_QUERY} from '@itookit/ui-common';

/** Responsive presentation leaves navigation and persistence with the host. */
export function installNavigationButtonPresentation(button: HTMLButtonElement): () => void {
    button.classList.add('ui-nav-button');
    const media = window.matchMedia?.(MOBILE_NAVIGATION_QUERY);
    const update = () => {
        button.innerHTML = media?.matches ? ACTION_ICONS.back : ACTION_ICONS.sidebar;
        button.title = t(media?.matches ? 'workspace.mobile.back' : 'workspace.sidebar.toggle');
        button.setAttribute('aria-label', button.title);
    };
    media?.addEventListener?.('change', update); update();
    return () => media?.removeEventListener?.('change', update);
}
