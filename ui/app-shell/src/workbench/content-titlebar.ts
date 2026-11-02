import {mountTitleBar as mountSharedTitleBar, navigationButton,
    type ContentTitleBarParts, type ContentTitleBarState} from '@itookit/ui-common';
import {installNavigationButtonPresentation} from '@itookit/ui-common-adapter';
import {ACTION_ICONS, t} from '@itookit/common';
import {navigateWorkspaceBack} from '../navigation/page-history';
const mounted = new WeakMap<HTMLElement, () => void>();

/** The shell supplies navigation policy; ui-common owns the complete visual layout. */
export function mountContentTitleBar(container: HTMLElement, parts: ContentTitleBarParts, windows: (at: HTMLElement) => () => void, navigate?: () => void) {
    mounted.get(container)?.();
    const releases: Array<() => void> = [];
    const back = parts.back ?? navigationButton({icon: ACTION_ICONS.back, label: t('workspace.mobile.back'), run: () => navigate ? navigate() : navigateWorkspaceBack(container)});
    back.classList.add('ui-nav-button');
    back.classList.add('workbench-content-back');
    if (!parts.back) releases.push(installNavigationButtonPresentation(back as HTMLButtonElement));
    const slot = document.createElement('span'); slot.className = 'ui-content-titlebar__actions'; releases.push(windows(slot));
    const summary = parts.menu?.querySelector('summary');
    summary?.classList.add('ui-nav-button');
    const view = mountSharedTitleBar(container, {...parts, back, trailing: [...(parts.trailing ?? []), slot], statePresentation: {
        dirtyLabel: t('workspace.titlebar.unsaved'),
    }});
    const previous = container.dataset.editorMobileNavigation; container.dataset.editorMobileNavigation = 'embedded';
    let closed = false;
    const destroy = () => {
        if (closed) return; closed = true;
        releases.forEach(release => release()); view.destroy(); summary?.classList.remove('ui-nav-button'); back.classList.remove('workbench-content-back');
        if (previous === undefined) delete container.dataset.editorMobileNavigation; else container.dataset.editorMobileNavigation = previous;
        if (mounted.get(container) === destroy) mounted.delete(container);
    };
    mounted.set(container, destroy);
    return {update(state: ContentTitleBarState) {if (!closed) view.update(state);}, destroy};
}
