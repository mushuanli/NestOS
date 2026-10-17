// @file: llm-ui/components/indicators/BranchIndicatorView.ts

import type { IBranchPresenter } from '../../domain/ports/IBranchPresenter';
import type { IEditorEventBus } from '../../domain/events';
import type { DOMCache } from '../common';
import { EventCleanup, TimerManager } from '../common';
import { BranchIndicatorTemplates } from '../templates/BranchIndicatorTemplates';
import type { IBranchStore } from '../../domain/ports/IBranchStore';

/**
 * 实现 IBranchPresenter
 * 
 * Shell 只调用 refresh() 和 flash()，
 * 内部的下拉菜单、事件委托完全封装。
 */
export class BranchIndicatorView implements IBranchPresenter {
    private events = new EventCleanup();
    private timers = new TimerManager();
    private unsub: (() => void) | null = null;

    constructor(
        private domCache: DOMCache,
        private bus: IEditorEventBus,
        private branchStore: IBranchStore
    ) {
        this.unsub = this.branchStore.onChange(() => this.render());
        // Initial state may already be cached, so refresh need not emit a change.
        this.render();
    }

    async refresh(): Promise<void> {
        await this.branchStore.refresh();
    }

    flash(): void {
        const el = this.domCache.byId('llm-branch-indicator');
        const btn = el?.querySelector('.llm-branch-indicator-btn') as HTMLElement;
        if (!btn) return;

        btn.classList.add('llm-branch-indicator-btn--flash');
        this.timers.setTimeout(
            () => btn.classList.remove('llm-branch-indicator-btn--flash'),
            600
        );
    }

    private render(): void {
        const el = this.domCache.byId('llm-branch-indicator');
        if (!el) return;

        this.domCache.invalidate('llm-branch-indicator');

        const branches = this.branchStore.current;
        const current = this.branchStore.currentBranch;
        const name = current?.name || 'main';

        this.events.cleanup();
        el.innerHTML = BranchIndicatorTemplates.renderIndicator(name, branches.length);
        if (branches.length <= 1) return;

        const btn = el.querySelector('.llm-branch-indicator-btn') as HTMLElement;
        const dropdown = el.querySelector('.llm-branch-dropdown') as HTMLElement;
        if (!btn || !dropdown) return;

        this.events.add(dropdown, 'click', ((event: MouseEvent) => this.handleDropdownClick(event, dropdown)) as EventListener);

        this.events.add(btn, 'click', ((e: MouseEvent) => {
            e.stopPropagation();
            this.toggleDropdown(dropdown);
        }) as EventListener);

        this.events.add(document, 'click', ((e: MouseEvent) => {
            if (!el.contains(e.target as Node)) {
                this.closeDropdown(dropdown);
            }
        }) as EventListener);
    }

    private toggleDropdown(dropdown: HTMLElement): void {
        dropdown.style.display !== 'none'
            ? this.closeDropdown(dropdown)
            : this.openDropdown(dropdown);
    }

    private openDropdown(dropdown: HTMLElement): void {
        dropdown.innerHTML = BranchIndicatorTemplates.renderDropdownItems(
            this.branchStore.current
        );
        dropdown.style.display = 'block';

    }

    private handleDropdownClick(event: MouseEvent, dropdown: HTMLElement): void {
        const target = event.target as HTMLElement;
        const item = target.closest<HTMLElement>('.llm-branch-dropdown__item');
        const branchName = item?.dataset.branchName;
        if (!branchName) return;
        event.stopPropagation();
        const deleteButton = target.closest<HTMLButtonElement>('.llm-branch-dropdown__delete');
        if (deleteButton) {
            if (deleteButton.disabled) return;
            this.closeDropdown(dropdown);
            this.bus.emit('branch:delete', { branchName });
        } else if (!item?.classList.contains('is-current')) {
            this.closeDropdown(dropdown);
            this.bus.emit('branch:switch', { branchName });
        }
    }

    private closeDropdown(dropdown: HTMLElement): void {
        dropdown.style.display = 'none';
        dropdown.innerHTML = '';
    }

    destroy(): void {
        this.unsub?.();
        this.events.cleanup();
        this.timers.destroy();
    }
}
