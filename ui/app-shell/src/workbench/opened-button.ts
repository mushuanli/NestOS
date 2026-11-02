import {ACTION_ICONS, t} from '@itookit/common';
import {navigationButton} from '@itookit/ui-common-adapter';

/** A host-owned window switcher can join an editor's existing title bar. */
export function openedButton(open: (origin: HTMLButtonElement) => void) {
    const button = navigationButton({icon: ACTION_ICONS.opened, label: t('workbench.opened'), popup: 'dialog', run: open});
    button.classList.add('workbench-window-list');
    const count = document.createElement('span'); count.className = 'ui-nav-button__count'; button.append(count);
    return {button, update(total: number) {count.textContent = String(total); button.setAttribute('aria-label', `${t('workbench.opened')} (${total})`);}};
}
