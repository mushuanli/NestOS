import {contentTitleBar, installNavigationButtonPresentation, navigationButton} from '@itookit/ui-common-adapter';
import {windowNavigation, type WindowNavigation} from './window-navigation';
import {openedButton} from './opened-button';
import {ACTION_ICONS, t} from '@itookit/common';

/** Compatibility adapter delegates all content title layout to ui-common. */
export function compactNavigation(container: HTMLElement, context: string, back: () => void, open: (origin: HTMLButtonElement) => void, actions?: WindowNavigation) {
    const navigate = navigationButton({icon: ACTION_ICONS.sidebar, label: t('workspace.sidebar.toggle'), run: back});
    navigate.classList.add('workbench-content-back');
    const cleanup = installNavigationButtonPresentation(navigate), opened = openedButton(open);
    const navigation = actions ? windowNavigation(actions) : undefined;
    let view = contentTitleBar({leading: [navigate], trailing: [...(navigation?.buttons ?? []), opened.button]});
    view.element.classList.add('workbench-compact-navigation'); container.append(view.element);
    let custom: HTMLElement | undefined;
    return {update(name: string, total: number, currentContext = context, label?: HTMLElement, canGoUp = false) {
        navigation?.update(canGoUp); opened.update(total);
        if (custom !== label) {
            view.destroy(); custom = label;
            view = contentTitleBar({leading: [navigate], title: label, contextEmbedded: !!label, trailing: [...(navigation?.buttons ?? []), opened.button]});
            view.element.classList.add('workbench-compact-navigation'); container.append(view.element);
        }
        view.update({title: name, context: currentContext});
    }, destroy() {cleanup(); navigation?.destroy(); opened.destroy(); view.destroy();}};
}
