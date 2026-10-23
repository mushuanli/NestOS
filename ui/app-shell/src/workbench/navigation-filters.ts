import { FILE_BROWSER_ICONS, TOOLBOX_ICONS, t } from '@itookit/common';
import { decorateButton } from './controls';

export interface NavigationFilterChip { label: string; remove(): void }

/** A shared filter surface keeps the same controls mounted across screen sizes. */
export class NavigationFilters {
    readonly trigger = document.createElement('button');
    readonly summary = document.createElement('div');
    readonly content = document.createElement('div');
    private readonly dialog = document.createElement('dialog');
    private readonly abort = new AbortController();
    constructor(private readonly label = t('workbench.filters')) {
        this.trigger.type = 'button'; this.trigger.className = 'workbench-filters__trigger';
        this.trigger.setAttribute('aria-haspopup', 'dialog'); this.trigger.setAttribute('aria-expanded', 'false');
        decorateButton(this.trigger, TOOLBOX_ICONS.settings, label);
        this.summary.className = 'workbench-filters__summary'; this.summary.hidden = true;
        this.content.className = 'workbench-filters__content'; this.dialog.className = 'workbench-filters';
        this.dialog.setAttribute('aria-label', label);
        const header = document.createElement('div'), title = document.createElement('strong'), close = document.createElement('button');
        header.className = 'workbench-filters__header'; title.textContent = label; close.type = 'button';
        decorateButton(close, FILE_BROWSER_ICONS.close, t('action.close'), true);
        close.onclick = () => this.dialog.close(); header.append(title, close); this.dialog.append(header, this.content);
        this.trigger.onclick = () => this.open();
        this.dialog.addEventListener('close', () => { this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.focus(); });
        this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.dialog.close(); });
        window.addEventListener('resize', () => this.position(), {signal: this.abort.signal});
    }
    update(chips: NavigationFilterChip[]): void {
        const label = this.label + (chips.length ? ` (${chips.length})` : '');
        decorateButton(this.trigger, TOOLBOX_ICONS.settings, label);
        this.trigger.setAttribute('aria-label', label); this.summary.hidden = !chips.length;
        this.summary.replaceChildren(...chips.map(chip => {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = chip.label;
            button.title = t('workbench.removeFilter', {name: chip.label}); button.setAttribute('aria-label', button.title);
            button.onclick = chip.remove; return button;
        }));
    }
    private open(): void {
        if (this.dialog.open) return;
        if (!this.dialog.isConnected) document.body.append(this.dialog);
        this.position(); this.dialog.showModal(); this.trigger.setAttribute('aria-expanded', 'true');
    }
    private position(): void {
        const rect = this.trigger.getBoundingClientRect();
        this.dialog.style.setProperty('--filter-top', `${Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 360))}px`);
        this.dialog.style.setProperty('--filter-left', `${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328))}px`);
    }
    destroy(): void { this.abort.abort(); if (this.dialog.open) this.dialog.close(); this.dialog.remove(); }
}
