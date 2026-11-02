import {ACTION_ICONS, t} from '@itookit/common';
import {createWindowManagement} from '@itookit/vfs-ui';

/** A host-owned window switcher can join an editor's existing title bar. */
export function openedButton(open: (origin: HTMLButtonElement) => void) {
    const view = createWindowManagement({open, iconHTML: ACTION_ICONS.opened, label: t('workbench.opened')});
    view.button.classList.add('workbench-window-list', 'ui-nav-button');
    return view;
}
