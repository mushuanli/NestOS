// @file: llm-ui/components/templates/ErrorTemplates.ts

import { escapeHTML, t } from '@itookit/common';

export class ErrorTemplates {
    /**
     * 渲染错误横幅
     */
    static renderErrorBanner(message: string): string {
        return `
            <div class="llm-ui-error-banner__content">
                <span class="llm-ui-error-banner__icon">⚠️</span>
                <span class="llm-ui-error-banner__message">${escapeHTML(message)}</span>
                <button class="llm-ui-error-banner__close" title="Dismiss">×</button>
            </div>
        `;
    }

    /**
     * 渲染新内容提示器
     */
    static renderNewContentIndicator(): string {
        return `
            <button class="llm-ui-new-content-btn">
                <span>⬇️ New response available</span>
            </button>
        `;
    }

    /**
     * 渲染错误气泡
     */
    static renderErrorBubble(message: string, showSettings: boolean, cancelled = false): string {
        let actionButtons = '';

        if (showSettings && !cancelled) {
            actionButtons += `
                <button class="llm-ui-error-btn" data-action="open-settings">${t('session.execution.configure')}</button>
            `;
        }

        actionButtons += `
            <button class="llm-ui-error-btn" data-action="retry-last">${t(cancelled ? 'session.execution.runAgain' : 'session.execution.retry')}</button>
        `;

        return `
            <div class="llm-ui-bubble llm-ui-bubble--error" data-outcome="${cancelled ? 'cancelled' : 'failed'}">
                <strong>${t(cancelled ? 'session.execution.cancelled' : 'session.execution.failed')}</strong>
                <div class="llm-ui-bubble--error__content">
                    ${escapeHTML(message)}
                </div>
                <div class="llm-ui-bubble--error__actions">
                    ${actionButtons}
                </div>
            </div>
        `;
    }

    /**
     * 渲染分支通知
     */
    static renderBranchNotification(message: string): string {
        return escapeHTML(message);
    }
}
