import {ACTION_ICONS, t} from '@itookit/common';

/** Responsive presentation leaves navigation and persistence with the host. */
export function installNavigationButtonPresentation(button: HTMLButtonElement): () => void {
    const media = window.matchMedia?.('(max-width: 768px)');
    const update = () => {
        button.innerHTML = media?.matches ? ACTION_ICONS.back : ACTION_ICONS.sidebar;
        button.title = t(media?.matches ? 'workspace.mobile.back' : 'workspace.sidebar.toggle');
        button.setAttribute('aria-label', button.title);
    };
    media?.addEventListener?.('change', update); update();
    return () => media?.removeEventListener?.('change', update);
}
