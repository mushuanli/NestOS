// @file: llm-ui/components/FloatingNavPanel.ts

import type { INavigationPresenter, NavPanelData, ChatNavItem } from '../domain/ports/INavigationPresenter';
import { formatTime } from '../utils/timeUtils';
import { IconTemplates } from './templates/IconTemplates';
import type { IEditorEventBus } from '../domain/events';
import type { BranchItem } from '../domain/types';
import { EventCleanup, TimerManager } from './common';
import { FloatingNavPanelTemplates } from './templates/FloatingNavPanelTemplates';
import { Toast } from '@itookit/ui-common';
import { showConfirmDialog } from '@itookit/ui-common';

export interface FloatingNavWorkspaceActions {
    onSetContext: (roundIds: string[], mode: 'include' | 'exclude') => Promise<void>;
}


/**
 * 实现 INavigationPresenter
 * 
 * Shell 只调用 toggle(), update(), destroy()
 * 内部 700+ 行的交互逻辑完全封装。
 */
export class FloatingNavPanel implements INavigationPresenter {
    private panel: HTMLElement | null = null;
    private _isVisible = false;

    // 数据（只读，由 update 设置）
    private allItems: ChatNavItem[] = [];
    private filteredItems: ChatNavItem[] = [];
    private branches: BranchItem[] = [];

    // 本地视图状态
    private currentIndex = -1;
    private lastSelectedIndex = -1;
    private selectedIds = new Set<string>();
    private filterBranch: string | null = null;

    private bus: IEditorEventBus;
    private events = new EventCleanup();
    private timers = new TimerManager();
    private panelEvents = new EventCleanup();

    constructor(
        private container: HTMLElement,
        bus: IEditorEventBus,
        private workspaceActions?: FloatingNavWorkspaceActions,
        private readOnly = false,
    ) {
        this.bus = bus;
    }

    // ================================================================
    // INavigationPresenter 实现
    // ================================================================

    get isVisible(): boolean {
        return this._isVisible;
    }

    update(data: NavPanelData): void {
        this.allItems = data.items;
        this.branches = data.branches;

        this.syncFilterBranch();
        this.applyFilter();
        this.pruneSelection();

        if (data.currentSessionId) {
            const idx = this.filteredItems.findIndex(
                item => item.id === data.currentSessionId
            );
            if (idx !== -1) this.currentIndex = idx;
        }

        if (this._isVisible) this.render();
    }

    toggle(): void {
        this._isVisible ? this.hide() : this.show();
    }

    destroy(): void {
        this.hide();
        this.panelEvents.cleanup();
        this.events.cleanup();
        this.timers.destroy();
        this.allItems = [];
        this.filteredItems = [];
        this.branches = [];
        this.selectedIds.clear();
    }

    // ================================================================
    // 显示/隐藏
    // ================================================================

    private show(): void {
        if (this._isVisible) return;
        this._isVisible = true;
        this.render();
        this.bindKeyboard();
    }

    private hide(): void {
        if (!this._isVisible) return;
        this._isVisible = false;
        this.selectedIds.clear();
        this.unbindKeyboard();

        if (this.panel) {
            this.panel.classList.add('llm-nav-panel--hiding');
            this.timers.setTimeout(() => {
                this.panel?.remove();
                this.panel = null;
            }, 200);
        }
    }

    // ================================================================
    // 工具栏操作
    // ================================================================

    /**
     * 工具栏操作分为两类：
     *
     * 本地操作：立即更新 UI，不需要等事件回流
     *   - toggle-select-all, clear-selection, prev, next
     *
     * 远程操作：只 emit 意图，等 update() 推新数据后自动刷新
     *   - batch-delete, batch-copy, fold-all, unfold-all
     */
    private async handleToolbarAction(action?: string): Promise<void> {
        if (this.readOnly && ['batch-delete', 'toggle-context', 'context-include', 'context-exclude'].includes(action ?? '')) return;
        switch (action) {
            // --- 本地操作：立即更新 UI ---
            case 'toggle-select-all':
                this.toggleSelectAll();
                break;

            case 'clear-selection':
                this.selectedIds.clear();
                this.syncSelectionUI();
                this.updateToolbarState();
                break;

            case 'prev':
                this.navigatePrev();
                break;

            case 'next':
                this.navigateNext();
                break;

            case 'toggle-context':
                await this.toggleContextForSelectionOrAll();
                break;

            case 'context-include':
                await this.setSelectedContextMode('include');
                break;

            case 'context-exclude':
                await this.setSelectedContextMode('exclude');
                break;

            // --- 远程操作：emit 意图，等数据回流 ---
            case 'fold-all':
                this.bus.emit('nav:foldAll', {});
                // 本地乐观更新折叠图标
                this.filteredItems.forEach(i => (i.isCollapsed = true));
                this.render();
                break;

            case 'unfold-all':
                this.bus.emit('nav:unfoldAll', {});
                this.filteredItems.forEach(i => (i.isCollapsed = false));
                this.render();
                break;

            case 'batch-toggle':
                this.selectedIds.forEach(id => {
                    this.bus.emit('nav:toggleFold', { sessionId: id });
                    const item = this.filteredItems.find(i => i.id === id);
                    if (item) item.isCollapsed = !item.isCollapsed;
                });
                this.render();
                break;

            case 'batch-delete':
                await this.handleBatchDelete();
                break;

            case 'batch-copy':
                if (this.selectedIds.size > 0) {
                    this.bus.emit('batch:copy', { ids: Array.from(this.selectedIds) });
                    this.selectedIds.clear();
                    // 不 render：copy 不改变列表数据
                    this.syncSelectionUI();
                    this.updateToolbarState();
                }
                break;
        }
    }

    /**
     * 批量删除
     *
     * 关键改动：不再自行 render
     * 只发出 intent，由事件链路回流后通过 update() 刷新
     */
    private async handleBatchDelete(): Promise<void> {
        if (this.selectedIds.size === 0) return;

        const ids = Array.from(this.selectedIds);
        const confirmed = await showConfirmDialog(
            `Delete ${ids.length} message(s)? Associated branches may also be removed.`
        );
        if (!confirmed) return;

        // 乐观更新：立即从本地视图中移除
        this.optimisticRemove(ids);

        // 发出意图，等待事件回流
        this.bus.emit('batch:delete', { ids });
    }

    /**
     * 乐观移除：立即更新本地视图，不等服务端确认
     *
     * 如果删除失败，下次 update() 会用正确数据覆盖。
     */
    private optimisticRemove(ids: string[]): void {
        const idSet = new Set(ids);
        this.allItems = this.allItems.filter(item => !idSet.has(item.id));
        this.selectedIds.clear();
        this.applyFilter();
        this.render();
    }

    // ================================================================
    // 选择逻辑（纯本地状态）
    // ================================================================

    private toggleSelectAll(): void {
        if (this.selectedIds.size === this.filteredItems.length) {
            this.selectedIds.clear();
        } else {
            this.filteredItems.forEach(i => this.selectedIds.add(i.id));
        }
        this.syncSelectionUI();
        this.updateToolbarState();
    }

    private toggleSelection(id: string): void {
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
        } else {
            this.selectedIds.add(id);
        }
        this.syncSelectionUI();
        this.updateToolbarState();
    }

    private selectRange(start: number, end: number): void {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        for (let i = min; i <= max; i++) {
            if (this.filteredItems[i]) {
                this.selectedIds.add(this.filteredItems[i].id);
            }
        }
        this.syncSelectionUI();
        this.updateToolbarState();
    }

    private pruneSelection(): void {
        const validIds = new Set(this.filteredItems.map(i => i.id));
        this.selectedIds = new Set([...this.selectedIds].filter(id => validIds.has(id)));
    }

    // ================================================================
    // 过滤（纯计算）
    // ================================================================

    private syncFilterBranch(): void {
        if (this.filterBranch === null) return;
        const currentBranch = this.branches.find(b => b.isCurrent);
        if (currentBranch) this.filterBranch = currentBranch.name;
    }

    private applyFilter(): void {
        if (this.filterBranch === null) {
            this.filteredItems = this.allItems.map((item, idx) => ({ ...item, index: idx }));
        } else {
            this.filteredItems = this.allItems
                .filter(item => item.memberOfBranches?.includes(this.filterBranch!))
                .map((item, idx) => ({ ...item, index: idx }));
        }
    }

    // ================================================================
    // Branch 下拉操作（远程意图）
    // ================================================================

    private handleBranchSelect(branchName: string): void {
        if (this.filterBranch === branchName) return;

        this.filterBranch = branchName;
        this.applyFilter();
        this.bus.emit('branch:switch', { branchName });
        this.render();
    }

    private handleBranchSelectAll(): void {
        this.filterBranch = null;
        this.applyFilter();
        this.render();
    }

    private handleBranchRename(oldName: string, newName: string): void {
        if (newName && newName !== oldName) {
            this.bus.emit('branch:rename', { oldName, newName });
            // 不 render：等 branch_renamed 事件回流
        }
    }

    private handleBranchDelete(branchName: string): void {
        this.bus.emit('branch:delete', { branchName });
        // 不 render：等 branch_deleted 事件回流
    }

    // ================================================================
    // 项目点击处理
    // ================================================================

    private handleItemClick(e: MouseEvent): void {
        const target = e.target as HTMLElement;
        const itemEl = target.closest('.llm-nav-item') as HTMLElement;
        if (!itemEl) return;

        const id = itemEl.dataset.id!;
        const idx = parseInt(itemEl.dataset.index!);

        // 子分支标签 → 切换 branch（远程）
        const branchTag = target.closest('[data-branch-tag]') as HTMLElement;
        if (branchTag?.dataset.branchTag) {
            this.bus.emit('branch:switch', { branchName: branchTag.dataset.branchTag });
            return;
        }

        // action 按钮（远程）
        const actionBtn = target.closest('[data-action]') as HTMLElement;
        if (actionBtn && itemEl.contains(actionBtn)) {
            this.handleItemAction(actionBtn.dataset.action!, id, idx, actionBtn);
            return;
        }

        // checkbox（本地）
        if (target.closest('[data-checkbox]')) {
            if (e.shiftKey && this.lastSelectedIndex !== -1) {
                this.selectRange(this.lastSelectedIndex, idx);
            } else {
                this.toggleSelection(id);
            }
            this.lastSelectedIndex = idx;
            return;
        }

        // fold 按钮（混合：本地乐观 + 远程同步）
        if (target.closest('[data-fold]')) {
            this.bus.emit('nav:toggleFold', { sessionId: id });
            const itemData = this.filteredItems[idx];
            if (itemData) itemData.isCollapsed = !itemData.isCollapsed;
            this.updateFoldIcon(itemEl, itemData?.isCollapsed ?? false);
            return;
        }

        // 默认：导航到该会话（本地高亮 + 远程滚动）
        this.currentIndex = idx;
        this.updateHighlight();
        this.bus.emit('nav:scrollTo', { sessionId: id });
    }

    private handleItemAction(action: string, sessionId: string, index: number, actionButton?: HTMLElement): void {
        if (this.readOnly) return;
        switch (action) {
            case 'toggle-round-context': {
                const item = this.filteredItems[index];
                if (item?.roundId) {
                    void this.applyContextMode(
                        [item.roundId],
                        item.contextMode === 'exclude' ? 'include' : 'exclude',
                    );
                }
                break;
            }
            case 'prev-branch':
            case 'next-branch':
                this.bus.emit('branch:switchById', { headNodeId: sessionId });
                break;
            case 'create-branch':
                this.bus.emit('branch:create', { sourceNodeId: sessionId });
                break;
            case 'open-create-menu':
                if (actionButton) void this.openCreateMenu(actionButton, sessionId);
                break;
        }
    }

    private async openCreateMenu(anchor: HTMLElement, sourceNodeId: string): Promise<void> {
        this.panel?.querySelector('.llm-nav-create-menu')?.remove();
        const menu = document.createElement('div');
        menu.className = 'llm-nav-create-menu';
        menu.innerHTML = `<strong>Conversation</strong>
            <button data-create-branch>Create Branch</button>`;
        anchor.closest('.llm-nav-item__branch-actions')?.append(menu);
        menu.querySelector('[data-create-branch]')?.addEventListener('click', () => {
            this.bus.emit('branch:create', { sourceNodeId });
            menu.remove();
        });
    }

    // ================================================================
    // 渲染（纯粹基于当前数据状态）
    // ================================================================

    private render(): void {
        this.panelEvents.cleanup();
        this.panel?.remove();

        this.panel = document.createElement('div');
        this.panel.className = 'llm-nav-panel';

        const userItems = this.filteredItems.filter(i => i.role === 'user');
        const totalUsers = userItems.length;
        const currentUserIdx = this.currentIndex >= 0
            ? userItems.findIndex(u => u.index <= this.currentIndex)
            : -1;

        const hasSelection = this.selectedIds.size > 0;
        const isAllSelected = this.selectedIds.size === this.filteredItems.length
            && this.filteredItems.length > 0;

        const listContent = this.filteredItems.length === 0
            ? FloatingNavPanelTemplates.renderEmpty()
            : this.renderUnifiedList();

        const branchBarHtml = FloatingNavPanelTemplates.renderBranchBar(
            this.branches, this.filterBranch
        );
        const contextItems = hasSelection
            ? this.filteredItems.filter(item => this.selectedIds.has(item.id))
            : this.filteredItems;

        this.panel.innerHTML = FloatingNavPanelTemplates.renderPanel(
            currentUserIdx, totalUsers,
            hasSelection, isAllSelected, this.selectedIds.size,
            'list', listContent, branchBarHtml,
            contextItems.some(item => item.contextMode !== 'exclude'),
        );

        this.restrictReadActions();
        this.container.appendChild(this.panel);
        this.bindPanelEvents();
        this.updateHighlight();

        requestAnimationFrame(() => {
            this.panel?.classList.add('llm-nav-panel--visible');
        });
    }

    private renderUnifiedList(): string {
        return this.filteredItems.map((item, idx) => {
            const isActive = idx === this.currentIndex;
            const isSelected = this.selectedIds.has(item.id);
            const timeStr = formatTime(item.timestamp);
            const title = item.role === 'user'
                ? 'You'
                : (item.agentName || 'Assistant');

            return FloatingNavPanelTemplates.renderUnifiedItem(
                item, idx, isActive, isSelected, timeStr, title
            );
        }).join('');
    }

    private restrictReadActions(): void {
        if (!this.readOnly) return;
        this.panel?.querySelectorAll('.llm-nav-panel__workspace-switches, .llm-nav-panel__branch-bar, .llm-nav-panel__footer, .llm-nav-item__branch-actions, .llm-nav-item__child-branches, [data-action="toggle-round-context"], [data-action="context-include"], [data-action="context-exclude"], [data-action="batch-delete"]').forEach(element => element.remove());
    }

    // ================================================================
    // 面板事件绑定
    // ================================================================

    private bindPanelEvents(): void {
        if (!this.panel) return;

        const closeBtn = this.panel.querySelector('.llm-nav-panel__close');
        if (closeBtn) {
            this.panelEvents.add(closeBtn, 'click', () => this.hide());
        }

        this.panel.querySelectorAll<HTMLElement>('.llm-nav-panel__btn, .llm-nav-panel__view-switch').forEach(btn => {
            this.panelEvents.add(btn, 'click', ((e: MouseEvent) => {
                e.stopPropagation();
                this.handleToolbarAction(btn.dataset.action);
            }) as EventListener);
        });

        this.bindBranchBarEvents();

        const listContainer = this.panel.querySelector('.llm-nav-panel__list');
        if (listContainer) {
            this.panelEvents.add(listContainer, 'click', ((e: MouseEvent) => {
                this.handleItemClick(e);
            }) as EventListener);
        }
    }

    private bindBranchBarEvents(): void {
        if (!this.panel) return;

        const branchBar = this.panel.querySelector('.llm-nav-panel__branch-bar');
        if (!branchBar) return;

        const selector = branchBar.querySelector('[data-branch-toggle]');
        const dropdown = branchBar.querySelector(
            '.llm-nav-panel__branch-dropdown'
        ) as HTMLElement;

        if (selector && dropdown) {
            this.panelEvents.add(selector, 'click', ((e: MouseEvent) => {
                e.stopPropagation();
                const isOpen = dropdown.style.display !== 'none';
                isOpen
                    ? this.closeBranchDropdown(dropdown)
                    : this.openBranchDropdown(dropdown);
            }) as EventListener);
        }
    }

    private openBranchDropdown(dropdown: HTMLElement): void {
        dropdown.innerHTML = FloatingNavPanelTemplates.renderBranchDropdownItems(
            this.branches, this.filterBranch
        );
        dropdown.style.display = 'block';

        const chevron = this.panel?.querySelector('.llm-nav-panel__branch-chevron');
        if (chevron) {
            chevron.innerHTML = IconTemplates.chevronUp;
        }

        // "All" 选项
        const allItem = dropdown.querySelector('[data-branch-name="__all__"]');
        if (allItem) {
            this.panelEvents.add(allItem, 'click', ((e: MouseEvent) => {
                e.stopPropagation();
                this.closeBranchDropdown(dropdown);
                this.handleBranchSelectAll();
            }) as EventListener);
        }

        // 各分支选项
        dropdown
            .querySelectorAll('.llm-nav-panel__branch-item:not([data-branch-name="__all__"])')
            .forEach(item => {
                this.panelEvents.add(item, 'click', ((e: MouseEvent) => {
                    e.stopPropagation();
                    const el = e.currentTarget as HTMLElement;
                    const branchName = el.dataset.branchName;
                    if (!branchName) return;
                    this.closeBranchDropdown(dropdown);
                    this.handleBranchSelect(branchName);
                }) as EventListener);

                const renameBtn = item.querySelector('[data-branch-item-action="rename"]');
                if (renameBtn) {
                    this.panelEvents.add(renameBtn, 'click', ((e: MouseEvent) => {
                        e.stopPropagation();
                        const branchItem = (e.currentTarget as HTMLElement)
                            .closest('.llm-nav-panel__branch-item') as HTMLElement;
                        const oldName = branchItem?.dataset.branchName;
                        if (oldName) {
                            this.startBranchRename(branchItem, oldName, dropdown);
                        }
                    }) as EventListener);
                }

                const deleteBtn = item.querySelector('[data-branch-item-action="delete"]');
                if (deleteBtn) {
                    this.panelEvents.add(deleteBtn, 'click', ((e: MouseEvent) => {
                        e.stopPropagation();
                        const branchItem = (e.currentTarget as HTMLElement)
                            .closest('.llm-nav-panel__branch-item') as HTMLElement;
                        const branchName = branchItem?.dataset.branchName;
                        if (branchName) {
                            this.closeBranchDropdown(dropdown);
                            this.handleBranchDelete(branchName);
                        }
                    }) as EventListener);
                }
            });

        // 外部点击关闭
        this.timers.setTimeout(() => {
            if (this.panel) {
                this.panelEvents.add(this.panel, 'click', ((e: MouseEvent) => {
                    const wrapper = this.panel?.querySelector(
                        '.llm-nav-panel__branch-selector-wrapper'
                    );
                    if (wrapper && !wrapper.contains(e.target as Node)) {
                        this.closeBranchDropdown(dropdown);
                    }
                }) as EventListener);
            }
        }, 0);
    }

    private closeBranchDropdown(dropdown: HTMLElement): void {
        dropdown.style.display = 'none';
        dropdown.innerHTML = '';

        const chevron = this.panel?.querySelector('.llm-nav-panel__branch-chevron');
        if (chevron) {
            chevron.innerHTML = IconTemplates.chevronDown;
        }
    }

    private startBranchRename(
        branchItemEl: HTMLElement,
        oldName: string,
        dropdown: HTMLElement
    ): void {
        const nameEl = branchItemEl.querySelector(
            '.llm-nav-panel__branch-item-name'
        ) as HTMLElement;
        const actionsEl = branchItemEl.querySelector(
            '.llm-nav-panel__branch-item-actions'
        ) as HTMLElement;
        if (!nameEl) return;

        if (actionsEl) actionsEl.style.display = 'none';

        nameEl.outerHTML = FloatingNavPanelTemplates.renderBranchRenameInput(oldName);

        const renameContainer = branchItemEl.querySelector(
            '.llm-nav-panel__branch-rename'
        ) as HTMLElement;
        const input = renameContainer?.querySelector(
            '.llm-nav-panel__branch-rename-input'
        ) as HTMLInputElement;
        if (!input) return;

        input.focus();
        input.select();

        const confirm = () => {
            const newName = input.value.trim();
            this.closeBranchDropdown(dropdown);
            this.handleBranchRename(oldName, newName);
        };

        const cancel = () => {
            if (dropdown.style.display !== 'none') {
                this.openBranchDropdown(dropdown);
            }
        };

        const confirmBtn = renameContainer.querySelector('[data-rename-action="confirm"]');
        if (confirmBtn) {
            this.panelEvents.add(confirmBtn, 'click', ((e: MouseEvent) => {
                e.stopPropagation();
                confirm();
            }) as EventListener);
        }

        const cancelBtn = renameContainer.querySelector('[data-rename-action="cancel"]');
        if (cancelBtn) {
            this.panelEvents.add(cancelBtn, 'click', ((e: MouseEvent) => {
                e.stopPropagation();
                cancel();
            }) as EventListener);
        }

        this.panelEvents.add(input, 'keydown', ((e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
            else if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
        }) as EventListener);
    }

    // ================================================================
    // UI 同步方法（纯本地 DOM 操作）
    // ================================================================

    private syncSelectionUI(): void {
        if (!this.panel) return;
        this.panel.querySelectorAll<HTMLElement>('.llm-nav-item').forEach(el => {
            const id = el.dataset.id!;
            const isSelected = this.selectedIds.has(id);
            el.classList.toggle('selected', isSelected);
            el.querySelector('.llm-nav-item__checkbox')
                ?.classList.toggle('checked', isSelected);
        });
    }

    private updateToolbarState(): void {
        if (!this.panel) return;

        const hasSelection = this.selectedIds.size > 0;
        const isAllSelected = this.selectedIds.size === this.filteredItems.length
            && this.filteredItems.length > 0;

        const selectAllBtn = this.panel.querySelector('[data-action="toggle-select-all"]');
        selectAllBtn?.classList.toggle('checked', isAllSelected);

        const countEl = this.panel.querySelector('.llm-nav-panel__selection-count');
        if (countEl) countEl.textContent = `${this.selectedIds.size} selected`;

        const actionsGroup = this.panel.querySelector(
            '.llm-nav-panel__toolbar-group--actions'
        );
        const viewGroup = this.panel.querySelector(
            '.llm-nav-panel__toolbar-group--view'
        );
        actionsGroup?.classList.toggle('visible', hasSelection);
        viewGroup?.classList.toggle('hidden', hasSelection);
    }

    private selectedRoundIds(): string[] {
        const selected = this.filteredItems.filter(item => this.selectedIds.has(item.id));
        return [...new Set(selected.map(item => item.roundId).filter(Boolean))];
    }

    private async setSelectedContextMode(mode: 'include' | 'exclude'): Promise<void> {
        const roundIds = this.selectedRoundIds();
        if (roundIds.length === 0) return;
        await this.applyContextMode(roundIds, mode);
    }

    private async toggleContextForSelectionOrAll(): Promise<void> {
        const selected = this.selectedRoundIds();
        const roundIds = selected.length > 0
            ? selected
            : [...new Set(this.filteredItems.map(item => item.roundId).filter(Boolean))];
        if (roundIds.length === 0) return;
        const target = new Set(roundIds);
        const hasIncluded = this.allItems.some(item => target.has(item.roundId) && item.contextMode !== 'exclude');
        await this.applyContextMode(roundIds, hasIncluded ? 'exclude' : 'include');
    }

    private async applyContextMode(roundIds: string[], mode: 'include' | 'exclude'): Promise<void> {
        try {
            await this.workspaceActions?.onSetContext(roundIds, mode);
            const targets = new Set(roundIds);
            this.allItems.forEach(item => {
                if (targets.has(item.roundId)) item.contextMode = mode;
            });
            this.applyFilter();
            this.render();
        } catch (error) {
            Toast.error(error instanceof Error ? error.message : 'Failed to update LLM context');
        }
    }

    private updateHighlight(): void {
        if (!this.panel) return;

        this.panel.querySelectorAll('.llm-nav-item').forEach((item, idx) => {
            item.classList.toggle('llm-nav-item--active', idx === this.currentIndex);
        });

        const userItems = this.filteredItems.filter(i => i.role === 'user');
        const currentUserIdx = this.currentIndex >= 0
            ? userItems.findIndex(u => u.index <= this.currentIndex)
            : -1;
        const counter = this.panel.querySelector('.llm-nav-panel__counter');
        if (counter) {
            counter.textContent = `${currentUserIdx + 1} / ${userItems.length}`;
        }
    }

    private updateFoldIcon(itemEl: HTMLElement, isCollapsed: boolean): void {
        const foldEl = itemEl.querySelector('.llm-nav-item__fold');
        if (foldEl) foldEl.textContent = isCollapsed ? '▶' : '▼';
        itemEl.classList.toggle('llm-nav-item--collapsed', isCollapsed);
    }

    // ================================================================
    // 键盘导航
    // ================================================================

    private bindKeyboard(): void {
        this.events.add(document, 'keydown', ((e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            switch (e.key) {
                case 'Escape':
                    e.preventDefault();
                    if (this.selectedIds.size > 0) {
                        this.selectedIds.clear();
                        this.syncSelectionUI();
                        this.updateToolbarState();
                    } else {
                        this.hide();
                    }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.navigatePrev();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.navigateNext();
                    break;
                case 'ArrowLeft':
                case 'ArrowRight':
                    this.handleArrowKey(e);
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (this.currentIndex >= 0) {
                        this.bus.emit('nav:scrollTo', {
                            sessionId: this.filteredItems[this.currentIndex].id,
                        });
                    }
                    break;
                case 'a':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        this.filteredItems.forEach(i => this.selectedIds.add(i.id));
                        this.syncSelectionUI();
                        this.updateToolbarState();
                    }
                    break;
            }
        }) as EventListener);
    }

    private handleArrowKey(e: KeyboardEvent): void {
        if (this.readOnly) return;
        if (this.currentIndex < 0) return;
        e.preventDefault();

        const item = this.filteredItems[this.currentIndex];
        if (!item) return;

        if (e.key === 'ArrowRight' && e.shiftKey) {
            this.bus.emit('branch:create', { sourceNodeId: item.id });
        } else if (e.key === 'ArrowLeft' && (item.siblingIndex ?? 0) > 0) {
            this.bus.emit('branch:switchById', { headNodeId: item.id });
        } else if (e.key === 'ArrowRight' &&
            (item.siblingIndex ?? 0) < (item.siblingCount || 1) - 1) {
            this.bus.emit('branch:switchById', { headNodeId: item.id });
        }
    }

    private unbindKeyboard(): void {
        this.events.cleanup();
    }

    // ================================================================
    // 导航
    // ================================================================

    private navigatePrev(): void {
        for (let i = this.currentIndex - 1; i >= 0; i--) {
            if (this.filteredItems[i].role === 'user') {
                this.currentIndex = i;
                this.updateHighlight();
                this.bus.emit('nav:scrollTo', { sessionId: this.filteredItems[i].id });
                this.scrollItemIntoView(i);
                break;
            }
        }
    }

    private navigateNext(): void {
        for (let i = this.currentIndex + 1; i < this.filteredItems.length; i++) {
            if (this.filteredItems[i].role === 'user') {
                this.currentIndex = i;
                this.updateHighlight();
                this.bus.emit('nav:scrollTo', { sessionId: this.filteredItems[i].id });
                this.scrollItemIntoView(i);
                break;
            }
        }
    }

    private scrollItemIntoView(index: number): void {
        const itemEl = this.panel?.querySelector(`[data-index="${index}"]`) as HTMLElement;
        itemEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // formatTime moved to utils/timeUtils.ts

}
