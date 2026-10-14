// @file: llm-ui/components/templates/BranchIndicatorTemplates.ts

import { escapeHTML, ACTION_ICONS, t } from '@itookit/common';
import { BranchItem } from '../../domain/types';

export const BranchIndicatorTemplates = {

    renderIndicator(currentName: string, branchCount: number, canOpen = branchCount > 1): string {
        const countBadge = branchCount > 1
            ? `<span class="llm-branch-indicator-count">${branchCount}</span>`
            : '';

        const chevron = canOpen
            ? `<svg class="llm-branch-indicator-chevron" viewBox="0 0 24 24"
                     width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
               </svg>`
            : '';

        return `
            <button class="llm-branch-indicator-btn"
                    title="Branch: ${escapeHTML(currentName)}${branchCount > 1 ? ` (${branchCount} branches)` : ''}">
                <svg class="llm-branch-indicator-icon" viewBox="0 0 24 24" 
                     width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="6" y1="3" x2="6" y2="15"></line>
                    <circle cx="18" cy="6" r="3"></circle>
                    <circle cx="6" cy="18" r="3"></circle>
                    <path d="M18 9a9 9 0 0 1-9 9"></path>
                </svg>
                <span class="llm-branch-indicator-name">${escapeHTML(currentName)}</span>
                ${countBadge}
                ${chevron}
            </button>
            <div class="llm-branch-dropdown" style="display:none"></div>
        `;
    },

    renderDropdownItems(branches: BranchItem[], options: {deletable?: boolean; key?: (branch: BranchItem) => string} = {}): string {
        if (branches.length === 0) {
            return `<div class="llm-branch-dropdown__empty">No branches</div>`;
        }

        return branches.map(b => `
            <div class="llm-branch-dropdown__item ${b.isCurrent ? 'is-current' : ''}"
                 data-branch-name="${escapeHTML(options.key?.(b) ?? b.name)}"
                 title="${escapeHTML(b.name)}">
                <span class="llm-branch-dropdown__icon">${b.isCurrent ? '●' : '○'}</span>
                <span class="llm-branch-dropdown__name">${escapeHTML(b.name)}</span>
                ${b.isCurrent ? '<span class="llm-branch-dropdown__badge">current</span>' : ''}
                ${options.deletable === false ? '' : `<button type="button" class="llm-branch-dropdown__delete"
                    title="${escapeHTML(t(b.isCurrent ? 'branch.deleteCurrentHint' : 'branch.delete'))}"
                    aria-label="${escapeHTML(t('branch.delete') + ': ' + b.name)}" ${b.isCurrent ? 'disabled' : ''}>${ACTION_ICONS.delete}</button>`}
            </div>
        `).join('');
    },

    chevronUp:   IconTemplates.chevronUp,
    chevronDown:  IconTemplates.chevronDown,
};

import { IconTemplates } from './IconTemplates';
