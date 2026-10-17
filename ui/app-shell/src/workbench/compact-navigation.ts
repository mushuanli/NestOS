import {ACTION_ICONS, t} from '@itookit/common';

/** The host keeps project context and document switching independent of editor internals. */
export function compactNavigation(container: HTMLElement, context: string, back: () => void, open: () => void) {
    const root = document.createElement('div'); root.className = 'workbench-compact-navigation';
    const button = (icon: string, label: string, action: () => void) => {
        const element = document.createElement('button'); element.type = 'button'; element.innerHTML = icon;
        element.title = label; element.setAttribute('aria-label', label); element.onclick = action; return element;
    };
    const label = document.createElement('div'); label.className = 'workbench-compact-navigation__label';
    const title = document.createElement('strong'), project = document.createElement('small');
    project.textContent = context; project.title = context; project.hidden = !context; label.append(title, project);
    const opened = button(ACTION_ICONS.opened, t('workbench.opened'), open); opened.setAttribute('aria-haspopup', 'dialog');
    const count = document.createElement('span'); count.className = 'workbench-compact-navigation__count'; opened.append(count);
    root.append(button(ACTION_ICONS.back, t('workspace.mobile.backToList'), back), label, opened); container.append(root);
    return {update(name: string, total: number) {
        title.textContent = name; title.title = name; count.textContent = String(total);
        opened.setAttribute('aria-label', `${t('workbench.opened')} (${total})`);
    }, destroy() { root.remove(); }};
}
