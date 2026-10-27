import {t} from '@itookit/common';
import {TOOLBOX_FILTERS, type ToolboxFilter} from './routes';

/** Visible category shortcuts complement the free-text search and optional filters. */
export class CategoryFilters {
    readonly element = document.createElement('div');
    private readonly buttons = new Map<ToolboxFilter, HTMLButtonElement>();
    constructor(select: (kind: ToolboxFilter) => void, agentsInWorkbench = false) {
        this.element.className = 'toolbox-categories';
        this.element.setAttribute('role', 'group'); this.element.setAttribute('aria-label', t('toolbox.filters'));
        for (const kind of TOOLBOX_FILTERS) {
            if (kind === 'agents' && agentsInWorkbench) continue;
            const button = document.createElement('button'); button.type = 'button'; button.textContent = t(`toolbox.${kind}`);
            button.dataset.toolboxFilter = kind; button.setAttribute('aria-pressed', 'false');
            button.onclick = () => select(kind); this.buttons.set(kind, button); this.element.append(button);
        }
    }
    update(value: ToolboxFilter): void {
        for (const [kind, button] of this.buttons) button.setAttribute('aria-pressed', String(kind === value));
    }
}
