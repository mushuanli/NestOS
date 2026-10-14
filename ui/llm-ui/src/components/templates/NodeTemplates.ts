import { renderFlowIdentity } from '../history/FlowIdentity';
// @file: llm-ui/components/templates/NodeTemplates.ts

import { ExecutionNode, SessionGroup } from '@itookit/llm-session/contracts';
import { escapeHTML, ACTION_ICONS, t } from '@itookit/common';
import { type Citation } from '@itookit/driver-llm/contracts';
import { LayoutTemplates } from './LayoutTemplates';

export class NodeTemplates {
    /**
     * 格式化时间显示
     */
    private static formatTime(timestamp: number): string {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();

        const isToday =
            date.getFullYear() === now.getFullYear() &&
            date.getMonth() === now.getMonth() &&
            date.getDate() === now.getDate();

        const isSameYear = date.getFullYear() === now.getFullYear();

        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (isToday) {
            return timeStr;
        }

        if (isSameYear) {
            const dateStr = date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
            return `${dateStr} ${timeStr}`;
        }

        const dateStr = date.toLocaleDateString([], {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        return `${dateStr} ${timeStr}`;
    }

    private static renderBranchNav(
        siblingIndex: number,
        siblingCount: number,
        branchName?: string,
    ): string {
        const hasSiblings = siblingCount > 1;

        const branchNameHtml = branchName
            ? `<span class="llm-ui-branch-name">${escapeHTML(branchName)}</span>`
            : '';

        const navHtml = hasSiblings
            ? `
            <button class="llm-icon-btn" data-action="prev-sibling" title="Previous Branch" ${siblingIndex === 0 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
            </button>
            <span class="llm-ui-branch-indicator">
                ${branchNameHtml}
                <span class="llm-ui-branch-count">${siblingIndex + 1}/${siblingCount}</span>
            </span>
            <button class="llm-icon-btn" data-action="next-sibling" title="Next Branch" ${siblingIndex === siblingCount - 1 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
            </button>
            <div class="llm-ui-sep"></div>
        `
            : '';

        const manageHtml = `
            <button class="llm-icon-btn" data-action="create-branch" title="Create Branch">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="6" y1="3" x2="6" y2="15"></line>
                    <circle cx="18" cy="6" r="3"></circle>
                    <circle cx="6" cy="18" r="3"></circle>
                    <path d="M18 9a9 9 0 0 1-9 9"></path>
                </svg>
            </button>
            <div class="llm-ui-sep"></div>
        `;

        return navHtml + manageHtml;
    }

    static renderUserBubble(
        group: SessionGroup,
        preview: string,
        isCollapsed: boolean = false,
    ): string {
        const collapsedClass = isCollapsed ? 'is-collapsed' : '';
        const timeStr = this.formatTime(group.timestamp);
        const branchHtml = this.renderBranchNav(
            group.siblingIndex ?? 0,
            group.siblingCount ?? 1,
            group.branchInfo?.name,
        );

        const chevron = isCollapsed
            ? LayoutTemplates.chevronDown()
            : LayoutTemplates.chevronUp();

        return `
        <div class="llm-ui-bubble llm-ui-bubble--user ${collapsedClass}"
             data-round-id="${escapeHTML(group.roundId ?? '')}"
             data-round-role="user"
             data-context-mode="${escapeHTML(group.historyPolicy ?? 'include')}"
             data-context-source="default">
            <div class="llm-ui-bubble__header">
                <div class="llm-ui-avatar">👤</div>
                
                <div class="llm-ui-header-preview">${escapeHTML(preview)}</div>
                <div class="llm-ui-time">${timeStr}</div>

                <div class="llm-ui-actions" style="margin-left: auto; display: flex; gap: 4px;">
                     ${branchHtml}
                     
                     <button class="llm-icon-btn" data-action="delete" title="Delete">🗑️</button>
                     <button class="llm-icon-btn" data-action="resend" title="Resend">↻</button>
                     <button class="llm-icon-btn" data-action="edit" title="Edit">✎</button>
                     <button class="llm-icon-btn" data-action="copy" title="Copy">📋</button>
                     <button class="llm-icon-btn" data-action="collapse" title="Toggle">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            ${chevron}
                        </svg>
                     </button>
                </div>
            </div>
            <div class="llm-ui-bubble__content">
                <div class="llm-ui-mount-point" id="user-mount-${group.id}"></div>
                
                <div class="llm-ui-edit-actions" style="display:none;">
                    <button class="llm-btn llm-btn--primary" data-action="confirm-edit">Save & Run</button>
                    <button class="llm-btn" data-action="save-only">Save Only</button>
                    <button class="llm-btn" data-action="cancel-edit">Cancel</button>
                </div>
            </div>
        </div>`;
    }

    static renderReadActions(collapsed = false): string {
        return `<div class="llm-ui-actions">
            <button type="button" class="llm-icon-btn" data-action="copy" title="${t('action.copy')}" aria-label="${t('action.copy')}">${ACTION_ICONS.copy}</button>
            <button type="button" class="llm-icon-btn" data-action="collapse" title="${t('flow.history.toggle')}" aria-label="${t('flow.history.toggle')}" aria-expanded="${!collapsed}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">${collapsed ? LayoutTemplates.chevronDown() : LayoutTemplates.chevronUp()}</svg>
            </button></div>`;
    }

    static renderAgentHeader(
        node: ExecutionNode,
        preview: string,
        icon: string,
        isCollapsed: boolean = false,
    ): string {
        if (node.messageRole) return `<div class="llm-ui-node__header">
            ${node.data.metaInfo?.nativeRole ? `<span class="llm-ui-node__name">${escapeHTML(node.name)}</span>` : renderFlowIdentity(node)}
            <span class="llm-ui-node__status llm-ui-node__status--${node.status}">${escapeHTML(node.status)}</span>
            <div class="llm-ui-time">${this.formatTime(node.startTime)}</div>${this.renderReadActions(isCollapsed)}</div>`;
        const timeStr = this.formatTime(node.startTime);
        const branchHtml = this.renderBranchNav(
            node.data.metaInfo?.siblingIndex ?? 0,
            node.data.metaInfo?.siblingCount ?? 1,
            node.data.metaInfo?.branchName,
        );

        const agentId = node.data.metaInfo?.agentId;
        const isClickable = node.executorType === 'agent' && agentId;

        // 修复：添加 data-action="edit-agent" 使事件委托能捕获点击
        const iconHtml = isClickable
            ? `<div class="llm-ui-node__icon llm-ui-node__icon--clickable" 
                    data-action="edit-agent" 
                    data-agent-id="${escapeHTML(agentId)}" 
                    title="Edit Agent: ${escapeHTML(agentId)}">${icon}</div>`
            : `<div class="llm-ui-node__icon">${icon}</div>`;

        const chevron = isCollapsed
            ? LayoutTemplates.chevronDown()
            : LayoutTemplates.chevronUp();

        return `
        <div class="llm-ui-node__header">
            ${iconHtml}
            <span class="llm-ui-node__name">${escapeHTML(node.name)}</span>
            <span class="llm-ui-header-preview">${escapeHTML(preview)}</span>
            <span class="llm-ui-node__status llm-ui-node__status--${node.status}">${node.status}</span>
            <div class="llm-ui-time">${timeStr}</div>

            <div class="llm-ui-actions" style="margin-left: auto; display: flex; gap: 4px;">
                ${branchHtml}

                <button class="llm-icon-btn" data-action="delete" title="Delete">🗑️</button>
                <button class="llm-icon-btn" data-action="regenerate" title="Regenerate">↻</button>
                <button class="llm-icon-btn" data-action="edit" title="Edit">✎</button>
                <button class="llm-icon-btn" data-action="copy" title="Copy">📋</button>
                <button class="llm-icon-btn" data-action="collapse" title="Toggle">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                        ${chevron}
                    </svg>
                </button>
            </div>
        </div>`;
    }

    static renderTool(node: ExecutionNode, icon: string): string {
        const result = node.data.error ?? node.data.output;
        const hasResult = result !== undefined && result !== '' || node.status === 'success';
        const resultDisplay = hasResult ? 'block' : 'none';
        const resultText = result !== undefined
            ? (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
            : '';

        return `
        <div class="llm-ui-node__header">
            <div class="llm-ui-node__icon">${icon}</div>
            <span class="llm-ui-node__name">${escapeHTML(node.name)}</span>
            <span class="llm-ui-node__status llm-ui-node__status--${node.status}">${node.status}</span>
        </div>
        <div class="llm-ui-node__body">
            ${node.data.input ? `<div class="llm-ui-node__input"><pre>${escapeHTML(
                typeof node.data.input === 'string' ? node.data.input : JSON.stringify(node.data.input, null, 2)
            )}</pre></div>` : ''}
            <div class="llm-ui-node__result" style="display:${resultDisplay}">${escapeHTML(resultText)}</div>
            <div class="llm-ui-node__progress" role="status" hidden></div>
            <div class="llm-ui-node__children"></div>
        </div>`;
    }

    static renderThinking(thought: string, hasThought: boolean, status?: string): string {
        const collapsedClass = hasThought && status && status !== 'running' ? ' llm-ui-thought--collapsed' : '';
        return `
        <div class="llm-ui-thought${collapsedClass}" style="display: ${hasThought ? 'block' : 'none'}">
            <div class="llm-ui-thought__label">💭 Thinking</div>
            <div class="llm-ui-thought__content">${escapeHTML(thought)}</div>
        </div>`;
    }

    /** 联网搜索结果引用块。 */
    static renderCitations(citations: Citation[], collapsed = true): string {
        if (!citations.length) return '';
        const items = citations.map(c => `
            <a class="llm-ui-citations__item" href="${escapeHTML(c.url ?? '#')}" target="_blank" rel="noopener">
                <span class="llm-ui-citations__icon">${ACTION_ICONS.search}</span>
                <span class="llm-ui-citations__text">
                    <span class="llm-ui-citations__title">${escapeHTML(c.text || c.title || c.url || 'Web search')}</span>
                    ${c.url ? `<span class="llm-ui-citations__url">${escapeHTML(c.url)}</span>` : ''}
                </span>
            </a>`).join('');
        return `
        <div class="llm-ui-citations${collapsed ? ' llm-ui-citations--collapsed' : ''}">
            <div class="llm-ui-citations__label">${ACTION_ICONS.search} 搜索结果引用 (${citations.length})</div>
            <div class="llm-ui-citations__list">${items}</div>
        </div>`;
    }
}
