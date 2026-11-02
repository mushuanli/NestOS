import {installNavigationButtonPresentation} from '@itookit/ui-common-adapter';
import {backToPreviousPage} from '../navigation/page-history';

export function mountNavigation(container: HTMLElement, sidebar: HTMLElement, editor: HTMLElement): () => void {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'kanban__sidebar-toggle';
    const release = installNavigationButtonPresentation(button);
    button.onclick = () => backToPreviousPage(() => {
        const layout = sidebar.closest<HTMLElement>('.mm-layout'); if (layout) layout.dataset.mobileView = 'list';
    });
    container.append(button); editor.dataset.editorMobileNavigation = 'embedded';
    return () => {release(); button.remove(); delete editor.dataset.editorMobileNavigation;};
}
