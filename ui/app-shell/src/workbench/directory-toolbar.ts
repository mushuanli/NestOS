import { FILE_BROWSER_ICONS, t } from '@itookit/common';
import { decorateButton } from './controls';
import type { DirectoryListOptions } from './directory-list';

/** Source queries and local filters share one responsive toolbar and search lifecycle. */
export class DirectoryToolbar {
    readonly element = document.createElement('div');
    readonly input = document.createElement('input');
    private readonly group = document.createElement('div');
    private focused = false;
    constructor(private readonly options: DirectoryListOptions, refresh: () => void, private readonly render: () => void) {
        this.element.className = 'workbench-directory__toolbar'; this.element.dataset.overflow = String(!!options.menu);
        if (options.parent && !options.breadcrumbs) this.element.append(this.button(t('workbench.parent'), options.parent, FILE_BROWSER_ICONS.up));
        if (options.refresh) this.element.append(this.button(t('workbench.refresh'), refresh, FILE_BROWSER_ICONS.refresh));
        this.addActions(); this.addSearch(); this.addMenu();
    }
    get query(): string { return this.input.value; }
    get filtering(): boolean { return !!this.options.search && !!this.query.trim(); }
    get searching(): boolean { return !!this.query.trim() || this.focused; }
    private button(label: string, run: () => void, icon?: string, iconOnly = true): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = run;
        return icon ? decorateButton(button, icon, label, iconOnly) : button;
    }
    private addActions(): void {
        for (const entry of this.options.actions ?? []) {
            const button = this.button(entry.label, entry.run, entry.icon, entry.iconOnly ?? true);
            button.disabled = !!entry.disabled; button.dataset.directoryAction = entry.disabled ? 'disabled' : 'enabled';
            if (entry.disabled && entry.disabledReason) button.title = entry.disabledReason;
            if (entry.id) button.dataset.action = entry.id;
            if (entry.primary) button.dataset.variant = 'primary';
            this.element.append(button);
        }
    }
    private addMenu(): void {
        if (!this.options.menu) return;
        const more = this.button(t('workbench.actions'), () => {
            const rect = more.getBoundingClientRect(); this.options.menu!(new MouseEvent('contextmenu', {clientX: rect.left, clientY: rect.bottom}));
        }, FILE_BROWSER_ICONS.more);
        more.dataset.action = 'directory-menu'; this.element.append(more);
    }
    private addSearch(): void {
        this.group.className = 'workbench-directory__search'; this.input.type = 'search';
        this.input.placeholder = t(this.options.search ? 'workbench.search' : 'workbench.filter');
        this.input.setAttribute('aria-label', this.input.placeholder); this.group.append(this.input);
        if (this.options.search?.controls) this.group.append(this.options.search.controls);
        this.element.append(this.group);
        this.options.search?.controls?.addEventListener('change', () => this.input.focus());
        this.input.oninput = () => this.changed();
        this.group.addEventListener('focusin', event => { if (event.target === this.input) this.focused = true; this.render(); });
        this.group.addEventListener('focusout', () => queueMicrotask(() => {
            if (!this.group.contains(document.activeElement)) this.focused = false;
            this.render();
        }));
        this.group.onkeydown = event => { if (event.key === 'Escape') this.apply(''); };
    }
    private apply(query: string): void {
        this.input.value = query;
        if (!query) { this.focused = false; this.input.blur(); }
        this.changed();
    }
    private changed(): void {
        this.options.search?.setQuery(this.query, query => this.apply(query)); this.render();
    }
}
