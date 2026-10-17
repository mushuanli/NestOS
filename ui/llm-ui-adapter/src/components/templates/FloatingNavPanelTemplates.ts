// @file: llm-ui/components/templates/FloatingNavPanelTemplates.ts

import { escapeHTML } from '@itookit/common';
import { BranchItem } from '../../domain/types';
import { ChatNavItem } from '../../domain/ports/INavigationPresenter';

export const FloatingNavPanelTemplates = {
    /**
     * 渲染面板主结构
     */
    renderPanel: (
        currentUserIdx: number,
        totalUsers: number,
        hasSelection: boolean,
        isAllSelected: boolean,
        selectedCount: number,
        _viewMode: 'list' | 'tree', // 保留参数兼容，但不再使用
        listContent: string,
        branchDropdownHtml: string,
        contextEnabled: boolean,
    ): string => `
        <div class="llm-nav-panel__header">
            <span class="llm-nav-panel__title">Chat Navigator</span>
            <div class="llm-nav-panel__workspace-switches" role="group" aria-label="Workspace views">
                <button class="llm-nav-panel__view-switch ${contextEnabled ? 'is-active' : ''}"
                        data-action="toggle-context" aria-pressed="${contextEnabled}"
                        title="Toggle selected rounds, or all visible rounds, in LLM history">
                    <span aria-hidden="true">◉</span><span>LLM History</span>
                </button>
            </div>
            <span class="llm-nav-panel__counter">${currentUserIdx + 1} / ${totalUsers}</span>
            <button class="llm-nav-panel__close" title="Close (Esc)">×</button>
        </div>
        
        ${branchDropdownHtml}

        <div class="llm-nav-panel__toolbar">
            <!-- 左侧：选择相关 -->
            <div class="llm-nav-panel__toolbar-group">
                <button class="llm-nav-panel__btn llm-nav-panel__btn--checkbox ${isAllSelected ? 'checked' : ''}" 
                        data-action="toggle-select-all" 
                        title="${isAllSelected ? 'Deselect All' : 'Select All'}">
                    <span class="llm-nav-panel__checkbox-icon"></span>
                </button>
                ${hasSelection ? `
                    <span class="llm-nav-panel__selection-count">${selectedCount} selected</span>
                ` : ''}
            </div>

            <div class="llm-nav-panel__toolbar-sep"></div>

            <!-- 中间：批量操作 -->
            <div class="llm-nav-panel__toolbar-group llm-nav-panel__toolbar-group--actions ${hasSelection ? 'visible' : ''}">
                <button class="llm-nav-panel__btn" data-action="batch-toggle" title="Toggle Fold Selected">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </button>
                <button class="llm-nav-panel__btn" data-action="batch-copy" title="Copy Selected">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                </button>
                <button class="llm-nav-panel__btn llm-nav-panel__btn--context-include" data-action="context-include" title="Include selected rounds in future LLM context">＋</button>
                <button class="llm-nav-panel__btn llm-nav-panel__btn--context-exclude" data-action="context-exclude" title="Exclude selected rounds from future LLM context">−</button>
                <button class="llm-nav-panel__btn llm-nav-panel__btn--danger" data-action="batch-delete" title="Delete Selected">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
                <button class="llm-nav-panel__btn" data-action="clear-selection" title="Clear Selection">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>

            <!-- 右侧：视图控制 -->
            <div class="llm-nav-panel__toolbar-group llm-nav-panel__toolbar-group--view ${hasSelection ? 'hidden' : ''}">
                <button class="llm-nav-panel__btn" data-action="fold-all" title="Fold All">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="4 14 10 14 10 20"></polyline>
                        <polyline points="20 10 14 10 14 4"></polyline>
                    </svg>
                </button>
                <button class="llm-nav-panel__btn" data-action="unfold-all" title="Unfold All">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <polyline points="9 21 3 21 3 15"></polyline>
                    </svg>
                </button>
                <div class="llm-nav-panel__toolbar-sep"></div>
                <button class="llm-nav-panel__btn" data-action="prev" title="Previous (↑)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="18 15 12 9 6 15"></polyline>
                    </svg>
                </button>
                <button class="llm-nav-panel__btn" data-action="next" title="Next (↓)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
            </div>
        </div>
        
        <div class="llm-nav-panel__list">
            ${listContent}
        </div>
        
        <div class="llm-nav-panel__footer">
            <span class="llm-nav-panel__hint">
                <kbd>↑↓</kbd> Navigate &nbsp;
                <kbd>←→</kbd> Switch Branch &nbsp;
                <kbd>Shift+→</kbd> Create Branch &nbsp;
                <kbd>Shift+Click</kbd> Range Select &nbsp;
                <kbd>Esc</kbd> Close
            </span>
        </div>
    `,

    /**
     * 渲染空状态
     */
    renderEmpty: (): string => `
        <div class="llm-nav-panel__empty">No messages yet</div>
    `,

    /**
     * 渲染 Branch 选择栏，支持 "All" 选项
     */
    renderBranchBar: (branches: BranchItem[], filterBranch: string | null): string => {
        //const currentBranch = branches.find(b => b.isCurrent);
        const displayName = filterBranch === null
            ? `All (${branches.length} branches)`
            : (filterBranch || 'main');
        const hasManyBranches = branches.length > 1;

        return `
            <div class="llm-nav-panel__branch-bar">
                <div class="llm-nav-panel__branch-selector-wrapper">
                    <div class="llm-nav-panel__branch-selector ${hasManyBranches ? 'llm-nav-panel__branch-selector--interactive' : ''}" 
                         ${hasManyBranches ? 'data-branch-toggle="true"' : ''}>
                        <svg class="llm-nav-panel__branch-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="6" y1="3" x2="6" y2="15"></line>
                            <circle cx="18" cy="6" r="3"></circle>
                            <circle cx="6" cy="18" r="3"></circle>
                            <path d="M18 9a9 9 0 0 1-9 9"></path>
                        </svg>
                        <span class="llm-nav-panel__branch-label">${escapeHTML(displayName)}</span>
                        ${hasManyBranches ? `
                            <svg class="llm-nav-panel__branch-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        ` : ''}
                    </div>
                    ${hasManyBranches ? `
                        <div class="llm-nav-panel__branch-dropdown" style="display:none;"></div>
                    ` : ''}
                </div>
            </div>
        `;
    },

    /**
     * 渲染 Branch Dropdown，包含 "All" 选项
     */
    renderBranchDropdownItems: (branches: BranchItem[], filterBranch: string | null): string => {
        const isAllSelected = filterBranch === null;

        const allItem = `
            <div class="llm-nav-panel__branch-item ${isAllSelected ? 'llm-nav-panel__branch-item--current' : ''}" 
                 data-branch-name="__all__">
                <span class="llm-nav-panel__branch-item-dot">${isAllSelected ? '●' : '○'}</span>
                <span class="llm-nav-panel__branch-item-name">All (${branches.length} branches)</span>
            </div>
            <div class="llm-nav-panel__branch-separator"></div>
        `;

        const branchItems = branches.map(branch => {
            const currentClass = !isAllSelected && filterBranch === branch.name
                ? 'llm-nav-panel__branch-item--current'
                : '';
            return `
                <div class="llm-nav-panel__branch-item ${currentClass}" 
                     data-branch-name="${escapeHTML(branch.name)}"
                     data-branch-head="${escapeHTML(branch.headNodeId)}">
                    <span class="llm-nav-panel__branch-item-dot">${currentClass ? '●' : '○'}</span>
                    <span class="llm-nav-panel__branch-item-name">${escapeHTML(branch.name)}</span>
                    <div class="llm-nav-panel__branch-item-actions">
                        <button class="llm-nav-panel__branch-item-btn" 
                                data-branch-item-action="rename" title="Rename">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                            </svg>
                        </button>
                        ${!branch.isCurrent ? `
                            <button class="llm-nav-panel__branch-item-btn llm-nav-panel__branch-item-btn--danger" 
                                    data-branch-item-action="delete" title="Delete">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        return allItem + branchItems;
    },

    renderBranchRenameInput: (currentName: string): string => `
        <div class="llm-nav-panel__branch-rename">
            <input type="text" class="llm-nav-panel__branch-rename-input" 
                   value="${escapeHTML(currentName)}" maxlength="50" />
            <button class="llm-nav-panel__branch-rename-btn" data-rename-action="confirm" title="Confirm">✓</button>
            <button class="llm-nav-panel__branch-rename-btn" data-rename-action="cancel" title="Cancel">✕</button>
        </div>
    `,

    /**
     * 统一列表项渲染：同时显示 fold、branch 信息、子分支
     */
    renderUnifiedItem: (
        item: ChatNavItem,
        idx: number,
        isActive: boolean,
        isSelected: boolean,
        timeStr: string,
        title: string
    ): string => {
        const icon = item.role === 'user' ? '👤' : '🤖';
        const foldIcon = item.isCollapsed ? '▶' : '▼';
        const activeClass = isActive ? 'llm-nav-item--active' : '';
        const collapsedClass = item.isCollapsed ? 'llm-nav-item--collapsed' : '';
        const contextExcluded = item.contextMode === 'exclude';

        // Branch 信息
        const hasBranches = (item.siblingCount || 0) > 1;
        const branchBadge = hasBranches
            ? `<span class="llm-nav-item__branch-badge" title="Branch ${item.siblingIndex! + 1} of ${item.siblingCount}">${item.siblingIndex! + 1}/${item.siblingCount}</span>`
            : '';

        const branchName = item.branchName
            ? `<span class="llm-nav-item__branch-name" title="Branch: ${escapeHTML(item.branchName)}">${escapeHTML(item.branchName)}</span>`
            : '';

        // 子分支列表（分叉点）
        const childBranchesHtml = item.childBranches && item.childBranches.length > 0
            ? `<div class="llm-nav-item__child-branches">
                <span class="llm-nav-item__fork-icon" title="Branch point - ${item.childBranches.length} branches">⑂</span>
                ${item.childBranches.map(child => `
                    <span class="llm-nav-item__branch-tag ${child.isCurrent ? 'is-current' : ''}" 
                          data-branch-tag="${escapeHTML(child.name)}" 
                          title="Switch to branch: ${escapeHTML(child.name)}">
                        ${escapeHTML(child.name)}
                    </span>
                `).join('')}
                <button class="llm-nav-item__branch-btn llm-nav-item__branch-btn--create" 
                        data-action="create-branch" 
                        title="Create new branch from this point">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
            </div>`
            : '';

        // Branch 操作按钮
        const branchActionsHtml = FloatingNavPanelTemplates.renderBranchActions(item);

        return `
            <div class="llm-nav-item ${activeClass} ${collapsedClass} ${contextExcluded ? 'llm-nav-item--context-excluded' : ''} ${isSelected ? 'selected' : ''}"
                 data-id="${item.id}" 
                 data-index="${idx}">
                <div class="llm-nav-item__checkbox ${isSelected ? 'checked' : ''}" data-checkbox="true"></div>
                <span class="llm-nav-item__fold" data-fold="true">${foldIcon}</span>
                <span class="llm-nav-item__icon">${icon}</span>
                <div class="llm-nav-item__content">
                    <div class="llm-nav-item__header">
                        <span class="llm-nav-item__title">${escapeHTML(title)}</span>
                        ${branchName}
                        ${branchBadge}
                        ${contextExcluded ? '<span class="llm-nav-item__context-badge" title="Excluded from future LLM context">Context off</span>' : ''}
                        <button class="llm-nav-item__context-toggle ${contextExcluded ? 'is-excluded' : 'is-included'}"
                                data-action="toggle-round-context"
                                aria-pressed="${!contextExcluded}"
                                title="${contextExcluded ? 'Include this Round in future LLM context' : 'Exclude this Round from future LLM context'}">
                            <span aria-hidden="true">${contextExcluded ? '○' : '●'}</span>
                            <span class="llm-nav-item__context-toggle-label">Context</span>
                        </button>
                        <span class="llm-nav-item__time">${timeStr}</span>
                    </div>
                    <div class="llm-nav-item__preview">${escapeHTML(item.preview)}</div>
                    
                    ${childBranchesHtml}
                    
                    ${branchActionsHtml}
                </div>
                <span class="llm-nav-item__index">#${idx + 1}</span>
            </div>
        `;
    },

    /**
     * 渲染 Branch 操作按钮（统一视图中使用）
     */
    renderBranchActions: (item: ChatNavItem): string => {
        const hasBranches = (item.siblingCount || 0) > 1;

        // 如果没有分支且没有子节点，只显示创建分支按钮
        if (!hasBranches && !item.hasChildren) {
            return `
                <div class="llm-nav-item__branch-actions">
                    <button class="llm-nav-item__branch-btn" 
                            data-action="open-create-menu"
                            title="Create Conversation branch or Flow node">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                </div>
            `;
        }

        return `
            <div class="llm-nav-item__branch-actions">
                ${hasBranches ? `
                    <button class="llm-nav-item__branch-btn" 
                            data-action="prev-branch" 
                            title="Previous Branch (←)"
                            ${(item.siblingIndex || 0) === 0 ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                    </button>
                    <button class="llm-nav-item__branch-btn" 
                            data-action="next-branch" 
                            title="Next Branch (→)"
                            ${(item.siblingIndex || 0) >= (item.siblingCount || 1) - 1 ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                ` : ''}
                <button class="llm-nav-item__branch-btn" 
                        data-action="open-create-menu"
                        title="Create Conversation branch or Flow node">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
                ${item.hasChildren ? `
                    <button class="llm-nav-item__branch-btn" 
                            data-action="show-children" 
                            title="Show Child Branches">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </button>
                ` : ''}
            </div>
        `;
    },
};
