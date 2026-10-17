import { t } from '@itookit/common';
import { LayoutTemplates } from '../templates/LayoutTemplates';

export function updateCollapseAction(button: HTMLElement, collapsed: boolean): void {
    button.innerHTML = collapsed ? LayoutTemplates.expandIcon() : LayoutTemplates.collapseIcon();
    const label = t(collapsed ? 'chat.toolbar.expandAll' : 'chat.toolbar.collapseAll');
    button.setAttribute('title', label); button.setAttribute('aria-label', label);
}
