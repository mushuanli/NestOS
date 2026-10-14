// @file: llm-ui/components/input/plugins/PopupPanel.ts

import { escapeAttr, escapeHTML } from '@itookit/common';

/**
 * 弹出面板基类
 * 
 * History 和 Slash 命令共享的弹出列表 UI 逻辑：
 * - 向上弹出定位
 * - 键盘导航（↑/↓/Enter/Esc）
 * - 点击选中
 * - 点击外部关闭
 * - 动画
 * 
 * 参考：VS Code QuickPick、Raycast 列表
 */
export interface PopupItem {
    id: string;
    label: string;
    description?: string;
    icon?: string;
    group?: string;
    /** 用于搜索匹配的额外文本 */
    searchText?: string;
    /** 是否带参数（slash 命令用） */
    hasArgs?: boolean;
    /** 快捷键提示（可选） */
    shortcut?: string;
}

export interface PopupPanelOptions {
    toggle?: { label: string; checked?: boolean; onChange: (checked: boolean) => void };
    /** 最大可见条数 */
    maxVisible?: number;
    /** 是否显示搜索框 */
    showSearch?: boolean;
    /** 搜索框占位符 */
    searchPlaceholder?: string;
    /** 空状态文本 */
    emptyText?: string;
    /** 底部提示文本 */
    footerHint?: string;
    /** 面板修饰类：'history' | 'slash' */
    variant?: 'history' | 'slash';
    /** 是否启用入场动画 */
    animated?: boolean;
    /** 删除按钮回调（history 用） */
    onDelete?: (item: PopupItem) => void;
}

export class PopupPanel {
    private panel: HTMLElement;
    private listEl: HTMLElement;
    private searchInput: HTMLInputElement | null = null;
    private items: PopupItem[] = [];
    private filteredItems: PopupItem[] = [];
    private selectedIndex = 0;
    private visible = false;
    private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

    private onSelect: ((item: PopupItem) => void) | null = null;
    private onClose: (() => void) | null = null;

    constructor(
        private anchor: HTMLElement,
        private options: PopupPanelOptions = {}
    ) {
        this.panel = this.createPanel();
        this.listEl = this.panel.querySelector('.llm-popup__list')!;

        // 改为挂载到 body，避免 overflow: hidden 裁剪
        document.body.appendChild(this.panel);
    }

    get isVisible(): boolean {
        return this.visible;
    }

    // ================================================================
    // 公共 API
    // ================================================================

    show(
        items: PopupItem[],
        callbacks: {
            onSelect: (item: PopupItem) => void;
            onClose?: () => void;
        }
    ): void {
        this.items = items;
        this.filteredItems = [...items];
        this.selectedIndex = 0;
        this.onSelect = callbacks.onSelect;
        this.onClose = callbacks.onClose ?? null;

        this.renderItems();
        this.panel.classList.add('llm-popup--visible');
        this.visible = true;

        this.positionPanel();

        if (this.searchInput) {
            this.searchInput.value = '';
            this.searchInput.focus();
        }

        requestAnimationFrame(() => {
            this.outsideClickHandler = (e: MouseEvent) => {
                if (!this.panel.contains(e.target as Node)) {
                    this.hide();
                }
            };
            document.addEventListener('click', this.outsideClickHandler, true);
        });
    }

    hide(): void {
        if (!this.visible) return;

        this.panel.classList.remove('llm-popup--visible');
        this.visible = false;

        if (this.outsideClickHandler) {
            document.removeEventListener('click', this.outsideClickHandler, true);
            this.outsideClickHandler = null;
        }

        this.onClose?.();
    }

    /**
     * 更新过滤（外部搜索时调用）
     */
    updateItems(items: PopupItem[]): void {
        this.items = items;
        this.filter(this.searchInput?.value ?? '');
    }

    filter(query: string): void {
        if (!query.trim()) {
            this.filteredItems = [...this.items];
        } else {
            const q = query.toLowerCase();
            this.filteredItems = this.items.filter(item =>
                item.label.toLowerCase().includes(q) ||
                item.description?.toLowerCase().includes(q) ||
                item.searchText?.toLowerCase().includes(q)
            );
        }

        this.selectedIndex = 0;
        this.renderItems();
    }

    /**
     * 键盘事件处理（由 Plugin 的 onKeyDown 调用）
     * 返回 true 表示已消费
     */
    handleKeyDown(e: KeyboardEvent): boolean {
        if (!this.visible) return false;

        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                this.moveSelection(-1);
                return true;

            case 'ArrowDown':
                e.preventDefault();
                this.moveSelection(1);
                return true;

            case 'Enter':
            case 'Tab':
                // Nothing selected means the typed text is no longer a popup choice (for example
                // `/sk-review <args>` after the command was inserted). Let the input handle it so
                // the command can actually be sent instead of being swallowed here.
                if (this.filteredItems.length === 0) return false;
                e.preventDefault();
                this.selectCurrent();
                return true;

            case 'Escape':
                e.preventDefault();
                this.hide();
                return true;

            default:
                return false;
        }
    }

    // ================================================================
    // 内部
    // ================================================================

    private createPanel(): HTMLElement {
        const el = document.createElement('div');

        // 基类 + 变体修饰 + 动画修饰
        let cls = 'llm-popup';
        if (this.options.variant) {
            cls += ` llm-popup--${this.options.variant}`;
        }
        if (this.options.animated) {
            cls += ' llm-popup--animated';
        }
        el.className = cls;

        let html = '';

        if (this.options.showSearch) {
            html += `
                <div class="llm-popup__search">
                    <input type="text"
                           class="llm-popup__search-input"
                           placeholder="${escapeAttr(this.options.searchPlaceholder || 'Search...')}"
                           autocomplete="off"
                           spellcheck="false">
                </div>
            `;
        }

        html += `<div class="llm-popup__list"></div>`;

        if (this.options.toggle) {
            html += `<label class="llm-popup__footer"><input type="checkbox" data-popup-toggle
                ${this.options.toggle.checked ? 'checked' : ''}> ${escapeHTML(this.options.toggle.label)}</label>`;
        }

        if (this.options.footerHint) {
            html += `
                <div class="llm-popup__footer">
                    ${escapeHTML(this.options.footerHint)}
                </div>
            `;
        }

        el.innerHTML = html;

        el.querySelector<HTMLInputElement>('[data-popup-toggle]')?.addEventListener('change', event => {
            this.options.toggle?.onChange((event.target as HTMLInputElement).checked);
        });

        // 搜索绑定
        this.searchInput = el.querySelector('.llm-popup__search-input');
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => {
                this.filter(this.searchInput!.value);
            });
            this.searchInput.addEventListener('keydown', (e) => {
                this.handleKeyDown(e);
            });
        }

        // 列表点击委托
        const list = el.querySelector('.llm-popup__list')!;
        list.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;

            // 删除按钮
            const deleteBtn = target.closest('.llm-popup__item-delete') as HTMLElement;
            if (deleteBtn) {
                e.stopPropagation();
                const itemEl = deleteBtn.closest('.llm-popup__item') as HTMLElement;
                const idx = parseInt(itemEl?.dataset.index || '0');
                const item = this.filteredItems[idx];
                if (item) {
                    this.options.onDelete?.(item);
                    // 从列表中移除
                    this.items = this.items.filter(i => i.id !== item.id);
                    this.filteredItems = this.filteredItems.filter(i => i.id !== item.id);
                    if (this.selectedIndex >= this.filteredItems.length) {
                        this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
                    }
                    this.renderItems();

                    if (this.filteredItems.length === 0) {
                        this.hide();
                    }
                }
                return;
            }

            // 选中项
            const itemEl = target.closest('.llm-popup__item') as HTMLElement;
            if (itemEl) {
                const idx = parseInt(itemEl.dataset.index || '0');
                this.selectedIndex = idx;
                this.selectCurrent();
            }
        });

        return el;
    }

    // ================================================================
    // 渲染
    // ================================================================

    private renderItems(): void {
        if (this.filteredItems.length === 0) {
            this.listEl.innerHTML = `
                <div class="llm-popup__empty">
                    ${escapeHTML(this.options.emptyText || 'No results')}
                </div>
            `;
            return;
        }

        let html = '';
        let currentGroup = '';
        const maxVisible = this.options.maxVisible ?? 10;
        //const variant = this.options.variant;
        const hasDelete = !!this.options.onDelete;

        this.filteredItems.slice(0, maxVisible).forEach((item, index) => {
            // 分组标题
            if (item.group && item.group !== currentGroup) {
                currentGroup = item.group;
                html += `<div class="llm-popup__group-title">${escapeHTML(currentGroup)}</div>`;
            }

            const selectedCls = index === this.selectedIndex
                ? ' llm-popup__item--selected' : '';
            const argsCls = item.hasArgs
                ? ' llm-popup__item--has-args' : '';
            const dimmedCls = item.group
                ? ' llm-popup__item--dimmed' : '';

            const icon = item.icon
                ? `<span class="llm-popup__item-icon">${item.icon}</span>`
                : '';

            const desc = item.description
                ? `<span class="llm-popup__item-desc">${escapeHTML(item.description)}</span>`
                : '';

            const shortcut = item.shortcut
                ? `<span class="llm-popup__item-shortcut">${escapeHTML(item.shortcut)}</span>`
                : '';

            const deleteBtn = hasDelete
                ? `<button class="llm-popup__item-delete" title="Remove from history">×</button>`
                : '';

            html += `
                <div class="llm-popup__item${selectedCls}${argsCls}${dimmedCls}" data-index="${index}">
                    ${icon}
                    <span class="llm-popup__item-label">${escapeHTML(item.label)}</span>
                    ${desc}
                    ${shortcut}
                    ${deleteBtn}
                </div>
            `;
        });

        if (this.filteredItems.length > maxVisible) {
            const remaining = this.filteredItems.length - maxVisible;
            html += `
                <div class="llm-popup__more">
                    +${remaining} more
                </div>
            `;
        }

        this.listEl.innerHTML = html;
    }

    // ================================================================
    // 导航
    // ================================================================

    private moveSelection(delta: number): void {
        const len = Math.min(this.filteredItems.length, this.options.maxVisible ?? 10);
        if (len === 0) return;

        this.selectedIndex = ((this.selectedIndex + delta) % len + len) % len;
        this.updateSelectionUI();
        this.scrollToSelected();
    }

    private selectCurrent(): void {
        const item = this.filteredItems[this.selectedIndex];
        if (item) {
            // onSelect MUST fire before hide() so that callbacks can still read
            // state that hide() / onClose() would clear (e.g. MentionPlugin uses
            // mentionStart and cachedSuggestions which are reset by close()).
            this.onSelect?.(item);
            this.hide();
        }
    }

    private updateSelectionUI(): void {
        this.listEl.querySelectorAll('.llm-popup__item').forEach((el, i) => {
            el.classList.toggle('llm-popup__item--selected', i === this.selectedIndex);
        });
    }

    private scrollToSelected(): void {
        const selected = this.listEl.querySelector('.llm-popup__item--selected');
        selected?.scrollIntoView({ block: 'nearest' });
    }

    private positionPanel(): void {
        const anchorRect = this.anchor.getBoundingClientRect();
        const inputContainer = this.anchor.closest('.llm-input');
        const containerRect = inputContainer?.getBoundingClientRect() || anchorRect;

        // 使用 fixed 定位（相对于 viewport）
        this.panel.style.position = 'fixed';
        this.panel.style.bottom = `${window.innerHeight - containerRect.top + 4}px`;
        this.panel.style.left = `${containerRect.left}px`;
        this.panel.style.width = `${containerRect.width}px`;
        this.panel.style.right = 'auto';
    }

    // ================================================================
    // 清理
    // ================================================================
    destroy(): void {
        this.hide();
        this.panel.remove();
    }
}
