import {installNavigationButtonPresentation} from '@itookit/ui-common';
import {openedButton} from './opened-button';
import {ACTION_ICONS, t} from '@itookit/common';

/** The host keeps project context and document switching independent of editor internals. */
export function compactNavigation(container: HTMLElement, context: string, back: () => void, open: (origin: HTMLButtonElement) => void) {
    const root = document.createElement('div'); root.className = 'workbench-compact-navigation';
    const button = (icon: string, label: string, action: () => void) => {
        const element = document.createElement('button'); element.type = 'button'; element.innerHTML = icon;
        element.title = label; element.setAttribute('aria-label', label); element.onclick = action; return element;
    };
    const label = document.createElement('div'); label.className = 'workbench-compact-navigation__label';
    const title = document.createElement('strong'), project = document.createElement('small');
    project.textContent = context; project.title = context; project.hidden = !context; label.append(title, project);
    const opened = openedButton(open);
    const navigate = button(ACTION_ICONS.sidebar, t('workspace.sidebar.toggle'), back);
    const cleanup = installNavigationButtonPresentation(navigate);
    root.append(navigate, label, opened.button); container.append(root);
    return {update(name: string, total: number, currentContext = context, navigationLabel?: HTMLElement) {
        if (navigationLabel) { if (label.firstElementChild !== navigationLabel) label.replaceChildren(navigationLabel); }
        else if (label.firstElementChild !== title) label.replaceChildren(title, project);
        project.textContent = currentContext; project.title = currentContext; project.hidden = !currentContext;
        title.textContent = name; title.title = name; opened.update(total);
    }, destroy() { cleanup(); root.remove(); }};
}
