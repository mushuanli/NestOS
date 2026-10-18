import {ACTION_ICONS, t} from '@itookit/common';

/** A host-owned window switcher can join an editor's existing title bar. */
export function openedButton(open: () => void) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'workbench-window-list';
    button.innerHTML = ACTION_ICONS.opened; button.title = t('workbench.opened'); button.setAttribute('aria-haspopup', 'dialog'); button.onclick = open;
    const count = document.createElement('span'); count.className = 'workbench-compact-navigation__count'; button.append(count);
    return {button, update(total: number) {count.textContent = String(total); button.setAttribute('aria-label', `${t('workbench.opened')} (${total})`);}};
}
