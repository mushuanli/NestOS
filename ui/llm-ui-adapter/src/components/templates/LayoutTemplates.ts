// @file: llm-ui/components/templates/LayoutTemplates.ts
import { ACTION_ICONS, escapeHTML, t } from '@itookit/common';

export const LayoutTemplates = {

    renderWorkspace: (currentTitle: string) => `
        <div class="llm-workspace-titlebar">
            <div class="llm-workspace-titlebar__compact-navigation" hidden></div>
            <div class="llm-workspace-titlebar__left">
                <button type="button" class="llm-workspace-titlebar__btn" id="llm-btn-sidebar" title="${escapeHTML(t('chat.toolbar.sidebar'))}" aria-label="${escapeHTML(t('chat.toolbar.sidebar'))}">
                    ${ACTION_ICONS.sidebar}
                </button>
                
                <div class="llm-workspace-titlebar__sep"></div>
                
                <input type="text" class="llm-workspace-titlebar__input" id="llm-title-input" 
                       value="${escapeHTML(currentTitle)}" placeholder="Untitled Chat" />
                
                <!-- Branch indicator: 内容由 UIUpdater.updateBranchIndicator() 动态渲染 -->
                <div class="llm-branch-indicator-bar" id="llm-branch-indicator"></div>

                <div class="llm-workspace-status" id="llm-status-indicator">
                    <span class="llm-workspace-status__dot"></span>
                    <span class="llm-workspace-status__text">Ready</span>
                </div>
            </div>

            <div class="llm-workspace-titlebar__right">
                <div class="llm-workspace-titlebar__primary"></div>
                <details class="llm-workspace-titlebar__menu">
                    <summary aria-label="${escapeHTML(t('chat.toolbar.more'))}" title="${escapeHTML(t('chat.toolbar.more'))}">⋯</summary>
                    <div class="llm-workspace-titlebar__menu-actions">
                <button type="button" class="llm-workspace-titlebar__btn llm-prompt-nav-trigger" id="llm-btn-prompt-nav"
                        title="${escapeHTML(t('chat.promptNav.title'))}" aria-label="${escapeHTML(t('chat.promptNav.title'))}" aria-expanded="false">
                    ${ACTION_ICONS.promptList}
                </button>
                <button type="button" class="llm-workspace-titlebar__btn" id="llm-btn-collapse" title="${escapeHTML(t('chat.toolbar.collapseAll'))}" aria-label="${escapeHTML(t('chat.toolbar.collapseAll'))}">
                    ${LayoutTemplates.collapseIcon()}
                </button>
                <div class="llm-workspace-titlebar__mode-info"></div>
                <div class="llm-workspace-titlebar__host-actions"></div>
                <button class="llm-workspace-titlebar__btn llm-workspace-titlebar__btn--text" id="llm-btn-workspace" hidden aria-haspopup="menu" aria-expanded="false">${escapeHTML(t('workspace.menu'))}</button>
                <button class="llm-workspace-titlebar__btn llm-workspace-titlebar__btn--text" id="llm-btn-flow-output" title="${escapeHTML(t('flow.output.title'))}">${escapeHTML(t('flow.output.title'))}</button>
                <button type="button" class="llm-workspace-titlebar__btn" id="llm-btn-session-rerun" title="${escapeHTML(t('session.rerun.hint'))}" aria-label="${escapeHTML(t('session.rerun.title'))}">${ACTION_ICONS.rerun}</button>
                <button type="button" class="llm-workspace-titlebar__btn" id="llm-btn-refresh" title="${escapeHTML(t('action.refresh'))}" aria-label="${escapeHTML(t('action.refresh'))}">${ACTION_ICONS.refreshView}</button>
                <div class="llm-workspace-titlebar__bg-indicator" id="llm-bg-indicator" style="display:none;">
                    <span class="llm-bg-badge">2 running</span>
                </div>

                <button class="llm-workspace-titlebar__btn" id="llm-btn-prev-unfolded" title="${escapeHTML(t('chat.toolbar.previous'))}">
                   <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                       <polyline points="18 15 12 9 6 15"></polyline>
                   </svg>
                </button>
                
                <button class="llm-workspace-titlebar__btn" id="llm-btn-next-unfolded" title="${escapeHTML(t('chat.toolbar.next'))}">
                   <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                       <polyline points="6 9 12 15 18 9"></polyline>
                   </svg>
                </button>

                <div class="llm-workspace-titlebar__sep"></div>

                <button class="llm-workspace-titlebar__btn" id="llm-btn-fold-current" title="${escapeHTML(t('chat.toolbar.fold'))}">
                   <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                       <path d="M4 14h6m-6 4h6m8-10h-6m6-4h-6M4 6h6m-3-3v18"/>
                   </svg>
                </button>
                
                <div class="llm-workspace-titlebar__sep"></div>

                <button class="llm-workspace-titlebar__btn" id="llm-btn-assets" title="${escapeHTML(t('chat.toolbar.assets'))}">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                        <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
                    </svg>
                </button>

                <button class="llm-workspace-titlebar__btn" id="llm-btn-copy" title="${escapeHTML(t('chat.toolbar.copy'))}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                </button>

                <button class="llm-workspace-titlebar__btn" id="llm-btn-navigator" title="${escapeHTML(t('chat.toolbar.navigate'))}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                            <line x1="3" y1="12" x2="21" y2="12"></line>
                            <line x1="3" y1="6" x2="21" y2="6"></line>
                            <line x1="3" y1="18" x2="21" y2="18"></line>
                            <circle cx="9" cy="12" r="2" fill="currentColor"></circle>
                        </svg>
                </button>

                <button class="llm-workspace-titlebar__btn" id="llm-btn-print" title="${escapeHTML(t('chat.toolbar.print'))}">
                        <i class="fas fa-print"></i>
                </button>
                    </div>
                </details>
            </div>
        </div>

        <div class="llm-ui-workspace__workbench" id="llm-ui-workbench">
            <section class="llm-ui-workspace__history" id="llm-ui-history" aria-label="Chat history"></section>
        </div>
        <div class="llm-ui-workspace__input" id="llm-ui-input"></div>
    `,

    renderWelcome: () => `
        <div class="llm-ui-welcome">
            <span class="llm-ui-welcome__eyebrow">${escapeHTML(t('chat.welcome.eyebrow'))}</span>
            <h2>${escapeHTML(t('chat.welcome.title'))}</h2>
            <p>${escapeHTML(t('chat.welcome.description'))}</p>
            <div class="llm-ui-welcome__prompts">
                ${['promptSummary', 'promptPlan', 'promptIdeas'].map(key => {
                    const label = escapeHTML(t(`chat.welcome.${key}` as import('@itookit/common').LocaleKey));
                    return `<button type="button" class="llm-ui-welcome__prompt" data-prompt="${label}">${label}<span aria-hidden="true">↗</span></button>`;
                }).join('')}
            </div>
        </div>
    `,

    renderErrorBanner: (message: string) => `
        <div class="llm-ui-banner llm-ui-banner--error">
            Error: ${escapeHTML(message)}
        </div>
    `,

    collapseIcon: () => {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 14 10 14 10 20"></polyline>
            <polyline points="20 10 14 10 14 4"></polyline>
        </svg>`;
    },

    expandIcon: () => {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
        </svg>`;
    },

    chevronDown: () => IconTemplates.chevronDown,
    chevronUp:   () => IconTemplates.chevronUp,
};

import { IconTemplates } from './IconTemplates';
