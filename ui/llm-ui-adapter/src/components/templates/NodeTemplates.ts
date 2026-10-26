import { renderFlowIdentity } from '../history/FlowIdentity';
// @file: llm-ui/components/templates/NodeTemplates.ts

import { ExecutionNode, SessionGroup } from '@itookit/llm-session/contracts';
import { escapeHTML, ACTION_ICONS, CHAT_ICONS, TOOLBOX_ICONS, t } from '@itookit/common';
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

        return navHtml;
    }

    static statusLabel(status: string): string {
        const labels: Record<string, string> = {
            queued: t('chatMessage.status.queued'), running: t('chatMessage.status.running'),
            success: t('chatMessage.status.success'), failed: t('chatMessage.status.failed'),
            aborted: t('chatMessage.status.aborted'),
        };
        return labels[status] ?? status;
    }

    private static action(action: string, label: string, icon: string): string {
        return `<button type="button" class="llm-icon-btn" data-action="${action}"
            title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}">${icon}</button>`;
    }

    private static collapseButton(collapsed: boolean): string {
        return `<button type="button" class="llm-icon-btn" data-action="collapse"
            title="${t('flow.history.toggle')}" aria-label="${t('flow.history.toggle')}" aria-expanded="${!collapsed}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                ${collapsed ? LayoutTemplates.chevronDown() : LayoutTemplates.chevronUp()}</svg></button>`;
    }

    static renderReadActions(collapsed = false): string {
        return `<div class="llm-ui-actions">${this.action('copy', t('action.copy'), CHAT_ICONS.copy)}${this.collapseButton(collapsed)}</div>`;
    }

    private static renderActions(user: boolean, branch: string, collapsed: boolean, argumentsInput = false): string {
        return `<div class="llm-ui-actions">
            ${this.action('copy', t('action.copy'), CHAT_ICONS.copy)}
            ${this.action(user ? 'resend' : 'regenerate', t(user ? 'chatMessage.resend' : 'chatMessage.retry'), ACTION_ICONS.rerun)}
            ${this.collapseButton(collapsed)}
            ${user ? this.action(argumentsInput ? 'edit-arguments' : 'edit', t(argumentsInput ? 'callable.input.arguments' : 'branch.edit'), CHAT_ICONS.edit) + this.action('create-branch', t('branch.continue'), ACTION_ICONS.branch) : ''}
            ${this.renderMoreMenu(`${branch}
                ${user ? '' : this.action('create-branch', t('branch.continue'), ACTION_ICONS.branch) + this.action('edit', t('action.edit'), CHAT_ICONS.edit)}
                ${this.action('delete', t('action.delete'), CHAT_ICONS.delete)}`)}
        </div>`;
    }

    static renderMoreMenu(content = ''): string {
        return `<details class="llm-ui-message-more">
            <summary title="${t('chat.toolbar.more')}" aria-label="${t('chat.toolbar.more')}">${CHAT_ICONS.more}</summary>
            <div class="llm-ui-message-more__items">${content}</div>
        </details>`;
    }

    static renderUserBubble(group: SessionGroup, preview: string, isCollapsed = false): string {
        const branch = this.renderBranchNav(group.siblingIndex ?? 0, group.siblingCount ?? 1, group.branchInfo?.name);
        const parameters = group.callInput?.admitted?.parameters;
        return `<div class="llm-ui-bubble llm-ui-bubble--user ${isCollapsed ? 'is-collapsed' : ''}"
            data-round-id="${escapeHTML(group.roundId ?? '')}" data-round-role="user"
            data-context-mode="${escapeHTML(group.historyPolicy ?? 'include')}" data-context-source="default">
            <div class="llm-ui-bubble__header"><div class="llm-ui-header-preview">${escapeHTML(preview)}</div></div>
            <div class="llm-ui-bubble__content">
                <div class="llm-ui-mount-point" id="user-mount-${group.id}"></div>
                ${this.renderCallArguments(parameters)}
                <div class="llm-ui-edit-actions" style="display:none;">
                    <button class="llm-btn llm-btn--primary" data-action="confirm-edit">${t('branch.editAndRun')}</button>
                    <button class="llm-btn" data-action="cancel-edit">${t('action.cancel')}</button>
                </div>
            </div>
            <div class="llm-ui-message-footer"><span class="llm-ui-time">${this.formatTime(group.timestamp)}</span>
                ${this.renderActions(true, branch, isCollapsed, !!group.target && group.callInput?.source.kind === 'arguments')}</div>
        </div>`;
    }

    static renderCallArguments(parameters?: Record<string, import('@itookit/llm-flow/contracts').JsonValue>): string {
        return parameters ? `<details class="llm-ui-node__input" data-call-arguments><summary>${escapeHTML(t('callable.input.arguments'))}</summary><pre>${escapeHTML(JSON.stringify(parameters, null, 2))}</pre></details>` : '';
    }

    static renderAgentHeader(node: ExecutionNode, preview: string, _icon: string, _isCollapsed = false): string {
        const agentId = node.data.metaInfo?.agentId;
        const name = node.messageRole && !node.data.metaInfo?.nativeRole ? renderFlowIdentity(node)
            : `<span class="llm-ui-node__name">${escapeHTML(node.name)}</span>`;
        return `<div class="llm-ui-node__header">
            ${agentId && agentId !== 'default' ? `<button type="button" class="llm-icon-btn llm-ui-node__icon--clickable"
                data-action="edit-agent" data-agent-id="${escapeHTML(agentId)}" aria-label="${t('action.edit')}">${TOOLBOX_ICONS.agents}</button>` : ''}
            ${name}<span class="llm-ui-header-preview">${escapeHTML(preview)}</span>
            <span class="llm-ui-node__status llm-ui-node__status--${node.status}">${this.statusLabel(node.status)}</span>
        </div>`;
    }

    static renderAgentFooter(node: ExecutionNode, collapsed = false): string {
        const meta = node.data.metaInfo;
        const branch = this.renderBranchNav(meta?.siblingIndex ?? 0, meta?.siblingCount ?? 1, meta?.branchName);
        return `<div class="llm-ui-message-footer"><span class="llm-ui-time">${this.formatTime(node.startTime)}</span>
            ${node.messageRole ? this.renderReadActions(collapsed) : this.renderActions(false, branch, collapsed)}</div>`;
    }

    static renderTool(node: ExecutionNode, _icon: string): string {
        const result = node.data.error ?? node.data.output;
        const hasResult = result !== undefined && result !== '' || node.status === 'success';
        const resultText = result === undefined ? '' : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return `<details class="llm-ui-tool-details" ${node.status === 'failed' ? 'open' : ''}>
            <summary class="llm-ui-node__header">
                <span class="llm-ui-node__icon">${TOOLBOX_ICONS.tools}</span>
                <span class="llm-ui-node__name">${escapeHTML(node.name)}</span>
                <span class="llm-ui-node__status llm-ui-node__status--${node.status}">${this.statusLabel(node.status)}</span>
                <span class="llm-ui-tool-details__hint">${t('chatMessage.toolDetails')}</span>${CHAT_ICONS.chevron}
            </summary>
            <div class="llm-ui-node__body">
                ${node.data.input ? `<div class="llm-ui-node__input"><pre>${escapeHTML(typeof node.data.input === 'string' ? node.data.input : JSON.stringify(node.data.input, null, 2))}</pre></div>` : ''}
                <div class="llm-ui-node__result" style="display:${hasResult ? 'block' : 'none'}">${escapeHTML(resultText)}</div>
            </div>
        </details>
        <div class="llm-ui-node__progress" role="status" hidden></div>
        <div class="llm-ui-node__children"></div>`;
    }

    static renderThinking(thought: string, hasThought: boolean, _status?: string): string {
        const collapsedClass = hasThought ? ' llm-ui-thought--collapsed' : '';
        return `
        <div class="llm-ui-thought${collapsedClass}" style="display: ${hasThought ? 'block' : 'none'}">
            <button type="button" class="llm-ui-thought__label" aria-expanded="${!collapsedClass}">${CHAT_ICONS.thinking}${t('chatMessage.thinking')}${CHAT_ICONS.chevron}</button>
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
