// @file: llm-ui/components/templates/ChatInputTemplates.ts

import { escapeHTML, t, ENTITY_ICONS, ACTION_ICONS } from '@itookit/common';
import { ExecutorOption, ConnectionOption } from '../../domain/types';

export const ChatInputTemplates = {

    /**
     * 渲染完整的 ChatInput 组件
     */
    renderMain(): string {
        return `
            <div class="llm-input">
                ${this.renderHelpPanel()}
                ${this.renderSettingsPanel()}
                ${this.renderInputArea()}
                <input type="file" multiple style="display:none;" class="llm-input__file-input">
            </div>
        `;
    },

    /**
     * 渲染设置面板
     */
    renderSettingsPanel(): string {
        return `
            <div class="llm-input__settings-panel" style="display: none;">
                <div class="llm-input__settings-header">
                    <span class="llm-input__settings-title">${this.settingsIcon()} ${t('chatSettings.title')}</span>
                    <button type="button" class="llm-input__settings-close" title="${t('chatSettings.close')}" aria-label="${t('chatSettings.close')}">${this.closeIcon()}</button>
                </div>
                <div class="llm-input__settings-body">
                    <section class="llm-input__settings-group">
                        <h3>${t('chatSettings.conversation')}</h3>
                        ${this.renderConnectionRow()}${this.renderTierRow()}${this.renderContextSetting()}
                        <div class="llm-input__settings-toggles">${this.renderThinkingSetting()}${this.renderWebSearchSetting()}</div>
                    </section>
                    <section class="llm-input__settings-group llm-input__ocr-preferences" data-ocr-preferences hidden>
                        <h3>${ACTION_ICONS.ocr} ${t('ocr.section')}</h3><div data-ocr-fields></div>
                    </section>
                    <details class="llm-input__settings-advanced">
                        <summary>${t('chatSettings.advanced')}</summary>
                        <div class="llm-input__settings-group">${this.renderSessionProfileSection()}${this.renderAdvancedSection()}${this.renderFlowInvocationRow()}</div>
                    </details>
                </div>
            </div>`;
    },

    /**
     * 连接选择行（独立一行）
     */
    renderConnectionRow(): string {
        return `
            <div class="llm-input__setting-row">
                <label class="llm-input__setting-label">
                    ${t('chatSettings.connection')}
                </label>
                <select class="llm-input__connection-select" aria-label="${t('chatSettings.connection')}" title="${t('chatSettings.connectionHint')}">
                    <option value="">${t('connection.followDefaultShort')}</option>
                </select>
            </div>
        `;
    },

    renderFlowInvocationRow(): string {
        return `
            <div class="llm-input__setting-row llm-input__flow-row">
                <label class="llm-input__setting-label">${t('chatSettings.flow')}</label>
                <div class="llm-input__flow-controls">
                    <input class="llm-input__flow-id" type="text" placeholder="${t('chatSettings.flowHint')}" aria-label="${t('chatSettings.flow')}" />
                    <select class="llm-input__branch-mode" aria-label="Branch mode">
                        <option value="continue">${t('chatSettings.continue')}</option>
                        <option value="fork">${t('chatSettings.fork')}</option>
                    </select>
                    <select class="llm-input__retention-mode" aria-label="History retention">
                        <option value="persistent">${t('chatSettings.persistent')}</option>
                        <option value="temporary">${t('chatSettings.temporary')}</option>
                    </select>
                </div>
            </div>
        `;
    },

    /**
     * Model Tier 卡片行（独立一行）
     *
     * 每张卡片两行：tier 名称 + 模型显示名（可动态更新）。
     * tiers 参数来自 ConnectionOption.tiers，key 为 ModelTier，value 为模型显示名。
     */
    renderTierRow(tiers?: Partial<Record<string, string>>): string {
        const t_auto  = tiers?.optimal ?? '';
        const t_opt   = tiers?.optimal ?? '';
        const t_std   = tiers?.standard ?? '';
        const t_fast  = tiers?.fast ?? '';
        return `
            <div class="llm-input__setting-row">
                <label class="llm-input__setting-label">
                    ${t('chatSettings.tier')}
                </label>
                <div class="llm-input__tier-cards" role="group" aria-label="Model tier">
                    <button type="button" class="llm-input__tier-card active" data-tier="auto"
                            title="${t('chatSettings.autoTier')}">
                        <span class="llm-input__tier-card-name">${t('chatSettings.auto')}</span>
                        <span class="llm-input__tier-card-model" data-tier-model="auto">${escapeHTML(t_auto)}</span>
                    </button>
                    <button type="button" class="llm-input__tier-card" data-tier="optimal"
                            title="Best quality — complex reasoning">
                        <span class="llm-input__tier-card-name">${t('ocr.tier.optimal')}</span>
                        <span class="llm-input__tier-card-model" data-tier-model="optimal">${escapeHTML(t_opt)}</span>
                    </button>
                    <button type="button" class="llm-input__tier-card" data-tier="standard"
                            title="Balanced — most daily work">
                        <span class="llm-input__tier-card-name">${t('ocr.tier.standard')}</span>
                        <span class="llm-input__tier-card-model" data-tier-model="standard">${escapeHTML(t_std)}</span>
                    </button>
                    <button type="button" class="llm-input__tier-card" data-tier="fast"
                            title="Cheapest — simple tasks">
                        <span class="llm-input__tier-card-name">${t('ocr.tier.fast')}</span>
                        <span class="llm-input__tier-card-model" data-tier-model="fast">${escapeHTML(t_fast)}</span>
                    </button>
                </div>
            </div>
        `;
    },

    /**
     * Context 长度设置 — radio-pill 预设取代 slider + 独立预设行
     */
    renderContextSetting(): string {
        return `
            <div class="llm-input__setting-row">
                <label class="llm-input__setting-label">
                    ${t('chatSettings.history')}
                </label>
                <div class="llm-input__preset-buttons" role="group" aria-label="Context length">
                    <button class="llm-input__preset-btn" data-history="0"  title="No history — fresh start">${t('chatSettings.fresh')}</button>
                    <button class="llm-input__preset-btn" data-history="5"  title="Last 5 messages">${t('chatSettings.short')}</button>
                    <button class="llm-input__preset-btn" data-history="20" title="Last 20 messages">${t('chatSettings.long')}</button>
                    <button class="llm-input__preset-btn active" data-history="-1" title="Full history">${t('chatSettings.all')}</button>
                </div>
            </div>
            <input type="range" class="llm-input__history-slider" min="-1" max="50" value="-1"
                   style="display:none" aria-hidden="true">
        `;
    },

    /**
     * Thinking 模式 — toggle + 推理强度（同一行）
     */
    renderThinkingSetting(): string {        return `
            <div class="llm-input__setting-row llm-input__setting-row--inline">
                <label class="llm-input__toggle" title="${t('thinking.tooltip')}">
                    <input type="checkbox" class="llm-input__thinking-toggle" checked>
                    <span class="llm-input__toggle-slider"></span>
                </label>
                <span>${ENTITY_ICONS.llm} ${t('thinking.label')}</span>
                <span class="llm-input__setting-spacer"></span>
                <span class="llm-input__reasoning-wrapper">
                    <select class="llm-input__reasoning-select" title="${t('thinking.effort.label')}">
                        <option value="auto" selected>${t('thinking.effort.auto')}</option>
                        <option value="low">${t('thinking.effort.low')}</option>
                        <option value="medium">${t('thinking.effort.medium')}</option>
                        <option value="xhigh">${t('thinking.effort.xhigh')}</option>
                    </select>
                </span>
            </div>
        `;
    },

    /**
     * 联网搜索 — toggle。provider 支持内置 server-side search 则走底层，
     * 否则由客户端统一工具（WebSearchTool）实现。
     */
    renderWebSearchSetting(): string {
        return `
            <div class="llm-input__setting-row llm-input__setting-row--inline">
                <label class="llm-input__toggle" title="${t('webSearch.tooltip')}">
                    <input type="checkbox" class="llm-input__websearch-toggle" checked>
                    <span class="llm-input__toggle-slider"></span>
                </label>
                <span>${ACTION_ICONS.search} ${t('webSearch.label')}</span>
                <span class="llm-input__setting-spacer"></span>
            </div>
        `;
    },

    /**
     * Session Profile — 会话级 system prompt 追加
     */
    renderSessionProfileSection(): string {
        return `
            <div class="llm-input__setting-row" style="flex-direction:column; align-items:stretch; gap:4px;">
                <label class="llm-input__setting-label">
                    ${t('chatSettings.instructions')}
                </label>
                <textarea class="llm-input__system-prompt-append"
                    placeholder="${t('chatSettings.instructionsHint')}"
                    rows="3"
                ></textarea>
            </div>
        `;
    },

    /**
     * Skills manager content, opened explicitly through /skills.
     *
     * 每个 Skill 以 toggle 开关控制当前会话是否启用。
     */
    renderSkillsSetting(): string {
        return `
            <div class="llm-input__setting-divider">
                Skills
                <button class="llm-input__skills-refresh" title="Refresh">↺</button>
            </div>
            <div class="llm-input__skill-section">
                <div class="llm-input__skills-list">
                    <span class="llm-input__skills-empty">No skills available</span>
                </div>
            </div>
        `;
    },

    /**
     * 渲染单个 Skill 条目 — toggle switch 样式
     */
    renderSkillItem(skill: { id: string; name: string; description: string; loaded: boolean; enabled?: boolean; toolCount: number; authorizedToolCount?: number; capabilitiesManagedByFlow?: boolean; icon?: string;
        drift?: import('@itookit/tools/contracts').SkillVersionDrift; unversioned?: boolean }): string {
        const icon = skill.icon ? escapeHTML(skill.icon) : '⚡';
        const checked = skill.loaded ? 'checked' : '';
        const btnClass = skill.loaded ? 'llm-input__skill-btn--unload' : 'llm-input__skill-btn--load';
        const desc = skill.description ? `: <span class="llm-input__skill-desc">${escapeHTML(skill.description)}</span>` : '';

        return `
            <div class="llm-input__skill-item${skill.loaded ? ' llm-input__skill-item--loaded' : ''}"
                 data-skill-id="${escapeHTML(skill.id)}">
                <label class="llm-input__toggle llm-input__skill-toggle" title="${skill.loaded ? 'Disable skill' : 'Enable skill'}">
                    <input type="checkbox" class="llm-input__skill-btn ${btnClass}"
                           data-skill="${escapeHTML(skill.id)}" ${checked} ${!skill.loaded && skill.enabled === false ? 'disabled' : ''}>
                    <span class="llm-input__toggle-slider"></span>
                </label>
                <span class="llm-input__skill-icon">${icon}</span>
                <span class="llm-input__skill-name">${escapeHTML(skill.name)}</span>${desc}
                <span role="status">${t(skill.loaded ? 'skill.instructionsLoaded' : 'skill.instructionsUnloaded')}${skill.toolCount ? ` · ${skill.capabilitiesManagedByFlow ? t('skill.flowGrants') : t('skill.toolGrants', { granted: skill.authorizedToolCount ?? 0, total: skill.toolCount })}` : ''}</span>
                ${skill.drift || skill.unversioned ? `<span role="status">${escapeHTML(t(skill.drift?.policy === 'keep-old' ? 'skill.version.kept' : 'skill.version.changed'))}</span>
                    <button type="button" data-skill-reload="${escapeHTML(skill.id)}">${escapeHTML(t('skill.version.reload'))}</button>` : ''}
            </div>
        `;
    },

    /**
     * Block Mode — toggle 独立行（非流式，等待完整响应）
     */
    renderAdvancedSection(): string {
        return `
            <div class="llm-input__setting-row llm-input__setting-row--inline">
                <label class="llm-input__toggle" title="Wait for full response before displaying (disables streaming)">
                    <input type="checkbox" class="llm-input__stream-toggle">
                    <span class="llm-input__toggle-slider"></span>
                </label>
                <span>${t('chatSettings.block')}</span>
            </div>
        `;
    },

    /**
     * 渲染主输入区域
     *
     * Claude.ai 风格布局：
     * - 上方：field-wrapper（附件 + 活动 badge + textarea）
     * - 下方：toolbar（左侧功能组 + 右侧操作组）
     */
    renderInputArea(): string {
        return `
            <div class="llm-input__main">
                ${this.renderFieldWrapper()}
                ${this.renderToolbar()}
                <div class="llm-input__execution-hint" role="status"></div>
            </div>
        `;
    },

    /**
     * 底部工具栏
     *
     * 左侧：attach / agent picker / conn quick-switch / tier quick-switch / more
     * 右侧：settings / send / stop
     */
    renderToolbar(): string {
        return `
            <div class="llm-input__toolbar">
                <div class="llm-input__toolbar-left">
                    ${this.renderExecutionMode()}
                    <button class="llm-input__btn llm-input__btn--attach" title="${t('chatInput.add.menu')}">
                        ${this.addIcon()}
                    </button>
                    ${this.renderWebSearchQuick()}
                    ${this.renderAgentPicker()}
                    ${this.renderConnQuick()}
                    ${this.renderTierQuick()}
                    ${this.renderPromptPicker()}
                    <button class="llm-input__btn llm-input__btn--more" title="More options">
                        ${this.moreIcon()}
                    </button>
                </div>
                <div class="llm-input__toolbar-right">
                    <button class="llm-input__btn llm-input__btn--settings" title="${t('chatSettings.title')}" aria-label="${t('chatSettings.title')}">
                        ${this.sliderIcon()}
                    </button>
                    <button class="llm-input__btn llm-input__btn--send" title="Send (Enter)">
                        ${this.sendIcon()}
                    </button>
                    <button class="llm-input__btn llm-input__btn--stop" title="Stop Generation" style="display:none;">
                        ${this.stopIcon()}
                    </button>
                </div>
            </div>
        `;
    },

    /** Accessible mode selection for future sends. */
    renderExecutionMode(): string {
        return `<div class="llm-input__execution-mode" role="group" aria-label="${t('chatInput.executionMode.label')}">
            <button class="llm-input__execution-option" type="button" data-execution-mode="chat" aria-pressed="true">${t('chatInput.executionMode.chat')}</button>
            <button class="llm-input__execution-option" type="button" data-execution-mode="agent" aria-pressed="false">${t('chatInput.executionMode.agent')}</button>
        </div>`;
    },

    renderWebSearchQuick(): string {
        return `
            <button class="llm-input__btn llm-input__btn--websearch" type="button"
                    title="${t('webSearch.tooltip')}" data-active="true">
                ${ACTION_ICONS.search}
            </button>
        `;
    },

    /**
     * Agent 选择器 — 自定义 Combobox（替代原生 select）
     *
     * The Agent trigger displays its icon, name and category.
     * 下拉列表由 PopupPanel 管理（挂载在 body，position:fixed，规避 overflow:hidden）。
     */
    renderAgentPicker(): string {
        return `
            <div class="llm-input__agent-picker">
                <button class="llm-input__agent-trigger" type="button" title="Select Agent">
                    <span class="llm-input__agent-icon">🤖</span>
                    <span class="llm-input__agent-name">Assistant</span>
                    <span class="llm-input__agent-meta"></span>
                    <span class="llm-input__agent-chevron">▾</span>
                </button>
            </div>
        `;
    },


    /**
     * Connection 快速切换 pill（位于 toolbar 左侧）
     *
     * 默认显示 "Default"；有 override 时显示连接名并附带 × 清除按钮。
     * 下拉列表由 PopupPanel 管理（挂载在 body，position:fixed，规避 overflow:hidden）。
     */
    renderConnQuick(): string {
        return `
            <div class="llm-input__conn-quick-wrapper">
                <button class="llm-input__conn-quick" type="button" title="Override LLM connection">
                    <span class="llm-input__conn-quick-icon">🔌</span>
                    <span class="llm-input__conn-quick-label">Default</span>
                    <span class="llm-input__conn-quick-clear" style="display:none" title="Clear override">×</span>
                </button>
            </div>
        `;
    },

    /**
     * Tier 快速切换 pill（位于 toolbar 左侧，紧跟 conn-quick）
     *
     * 默认显示 "Auto"；有 override 时显示层级名并附带 × 清除按钮。
     * 下拉列表由 PopupPanel 管理，选项含对应模型显示名。
     */
    renderTierQuick(): string {
        return `
            <div class="llm-input__tier-quick-wrapper">
                <button class="llm-input__tier-quick" type="button" title="Override model tier">
                    <span class="llm-input__tier-quick-icon">⚡</span>
                    <span class="llm-input__tier-quick-label">${t('chatSettings.auto')}</span>
                    <span class="llm-input__tier-quick-clear" style="display:none" title="Clear tier">×</span>
                </button>
            </div>
        `;
    },

    /**
     * 预设 Prompt 快速选择 pill（位于 toolbar 左侧，有 prompts 时显示）
     *
     * 仅当当前 Agent 配置了 defaultPrompts 时显示（由 ChatInput 控制可见性）。
     * 下拉列表由 PopupPanel 管理，选中后将 prompt 填入输入框。
     */
    renderPromptPicker(): string {
        return `
            <div class="llm-input__prompt-picker-wrapper" style="display:none">
                <button class="llm-input__prompt-picker" type="button" title="插入预设 Prompt">
                    <span class="llm-input__prompt-picker-icon">💬</span>
                    <span class="llm-input__prompt-picker-label">Prompts</span>
                    <span class="llm-input__prompt-picker-chevron">▾</span>
                </button>
            </div>
        `;
    },

    /**
     * 输入字段包装器（含附件预览和活动设置指示器）
     */
    renderFieldWrapper(): string {
        return `
            <div class="llm-input__field-wrapper">
                <div class="llm-input__attachments" style="display:none"></div>
                ${this.renderActiveBadges()}
                <textarea
                    class="llm-input__textarea"
                    placeholder="${escapeHTML(t('chatInput.messagePlaceholder'))}"
                    rows="2"
                ></textarea>
            </div>
        `;
    },

    /**
     * 活动设置徽章区域
     */
    renderActiveBadges(): string {
        return `
            <div class="llm-input__active-settings" style="display:none">
                <span class="llm-input__active-badge" data-type="connection" style="display:none">
                    🔌 <span class="llm-input__badge-text"></span>
                    <button class="llm-input__badge-clear" data-clear="connection">×</button>
                </span>
                <span class="llm-input__active-badge" data-type="tier" style="display:none">
                    ⚡ <span class="llm-input__badge-text"></span>
                    <button class="llm-input__badge-clear" data-clear="tier">×</button>
                </span>
                <span class="llm-input__active-badge" data-type="stream" style="display:none">
                    ⏸️ <span class="llm-input__badge-text">Block Mode</span>
                    <button class="llm-input__badge-clear" data-clear="stream">×</button>
                </span>
                <span class="llm-input__active-badge" data-type="history" style="display:none">
                    📜 <span class="llm-input__badge-text"></span>
                    <button class="llm-input__badge-clear" data-clear="history">×</button>
                </span>
            </div>
        `;
    },

    /**
     * 帮助面板骨架（挂载在 .llm-input 根节点内）。
     *
     * 内容由 ChatInputView.renderHelpContent() 动态写入 .llm-input__help-body。
     */
    renderHelpPanel(): string {
        return `
            <div class="llm-input__help-panel" style="display:none;" role="dialog" aria-label="ChatInput help">
                <div class="llm-input__help-header">
                    <span class="llm-input__help-title">How to use</span>
                    <button class="llm-input__help-close" title="Close help (Esc)">×</button>
                </div>
                <div class="llm-input__help-body"></div>
            </div>
        `;
    },

    /**
     * 帮助面板内容（动态注入）。
     *
     * @param hasFiles    是否注入了 onRequestFiles（决定是否显示 @ 分区）
     */
    renderHelpContent(hasFiles: boolean): string {
        const fileSection = hasFiles ? `
            <section class="llm-input__help-section">
                <h3 class="llm-input__help-section-title">@ File References</h3>
                <table class="llm-input__help-table">
                    <tr><td><kbd>@filename</kbd></td><td>Type @ to open file picker</td></tr>
                    <tr><td>Select a file</td><td>Inserts <code>[file.md](./path)</code> → AI reads its content</td></tr>
                    <tr><td>Images</td><td>Inserts <code>![img.png](./path)</code> → sent as vision attachment</td></tr>
                </table>
            </section>` : '';

        return `
            <section class="llm-input__help-section">
                <h3 class="llm-input__help-section-title">⌨ Keyboard Shortcuts</h3>
                <table class="llm-input__help-table">
                    <tr><td><kbd>Enter</kbd></td><td>Send message</td></tr>
                    <tr><td><kbd>Shift+Enter</kbd></td><td>New line</td></tr>
                    <tr><td><kbd>↑</kbd> <span class="llm-input__help-dim">(empty input)</span></td><td>Browse prompt history</td></tr>
                    <tr><td><kbd>Ctrl+R</kbd></td><td>Search prompt history</td></tr>
                    <tr><td><kbd>Esc</kbd></td><td>Close active panel</td></tr>
                    <tr><td><kbd>Cmd+K</kbd></td><td>Toggle navigation panel</td></tr>
                    <tr><td><kbd>Cmd+↑↓</kbd></td><td>Navigate between messages</td></tr>
                </table>
            </section>

            <section class="llm-input__help-section">
                <h3 class="llm-input__help-section-title">/ Slash Commands</h3>
                <p class="llm-input__help-section-desc">Type <kbd>/</kbd> to open the command picker.</p>
                <table class="llm-input__help-table">
                    <tr><th colspan="2" class="llm-input__help-group">Chat</th></tr>
                    <tr><td><kbd>/add-dir</kbd> &lt;dir&gt; [r|w]</td><td>挂载目录，默认读写；r 只读，w 读写</td></tr>
                    <tr><td><kbd>/set-home</kbd> &lt;dir&gt;</td><td>设置默认目录，不自动挂载</td></tr>
                    <tr><td><kbd>/new</kbd> [title]</td><td>Start a new chat</td></tr>
                    <tr><td><kbd>/retry</kbd></td><td>Regenerate last response</td></tr>
                    <tr><td><kbd>/continue</kbd></td><td>Continue generation</td></tr>
                    <tr><td><kbd>/reedit</kbd></td><td>Re-edit last message</td></tr>
                    <tr><td><kbd>/delete</kbd></td><td>Delete last message pair</td></tr>
                    <tr><td><kbd>/clear</kbd></td><td>Clear conversation</td></tr>

                    <tr><th colspan="2" class="llm-input__help-group">Refine</th></tr>
                    <tr><td><kbd>/shorter</kbd> <kbd>/longer</kbd></td><td>Adjust response length</td></tr>
                    <tr><td><kbd>/simplify</kbd></td><td>Simplify last response</td></tr>
                    <tr><td><kbd>/summarize</kbd></td><td>Summarize last response</td></tr>

                    <tr><th colspan="2" class="llm-input__help-group">View</th></tr>
                    <tr><td><kbd>/fold</kbd> <kbd>/foldall</kbd></td><td>Fold current / all messages</td></tr>
                    <tr><td><kbd>/top</kbd> <kbd>/bottom</kbd></td><td>Scroll to top / bottom</td></tr>
                    <tr><td><kbd>/nav</kbd></td><td>Toggle navigation panel</td></tr>

                    <tr><th colspan="2" class="llm-input__help-group">Export</th></tr>
                    <tr><td><kbd>/copy</kbd></td><td>Copy all as Markdown</td></tr>
                    <tr><td><kbd>/export</kbd></td><td>Export conversation</td></tr>

                    <tr><th colspan="2" class="llm-input__help-group">Branch</th></tr>
                    <tr><td><kbd>/branch</kbd></td><td>Create branch</td></tr>
                    <tr><td><kbd>/switch</kbd> &lt;name&gt;</td><td>Switch branch</td></tr>
                    <tr><td><kbd>/branchprev</kbd> <kbd>/branchnext</kbd></td><td>Cycle branches</td></tr>
                    <tr><td><kbd>/branches</kbd></td><td>List all branches</td></tr>

                    <tr><th colspan="2" class="llm-input__help-group">Settings</th></tr>
                    <tr><td><kbd>/agent</kbd> &lt;id&gt;</td><td>Switch agent</td></tr>
                    <tr><td><kbd>/model</kbd> &lt;id&gt;</td><td>Override model</td></tr>
                    <tr><td><kbd>/history</kbd> &lt;n&gt;</td><td>Set context length (0 = none, -1 = all)</td></tr>
                    <tr><td><kbd>/fresh</kbd></td><td>Clear context (fresh start)</td></tr>
                </table>
            </section>

            ${fileSection}

            <p class="llm-input__help-footer">
                Tip: type <kbd>/</kbd> in the input to browse all commands interactively.
            </p>
        `;
    },

    // ================================================================
    // 动态内容渲染
    // ================================================================

    /**
     * 渲染附件列表
     *
     * @param files     附件文件列表
     * @param canOcr    是否注入了 OCR 能力(决定图片 chip 是否显示「提取文字」按钮)
     */
    renderAttachments(files: File[], canOcr = false): string {
        const imageCount = files.filter(f => f.type.startsWith('image/')).length;
        const chips = files.map((f, i) => {
            const isImage = f.type.startsWith('image/');
            const ocrBtn = (isImage && canOcr)
                ? `<button class="llm-input__ocr-btn" data-index="${i}" type="button" title="${t('chatInput.ocr.tooltip')}">${ACTION_ICONS.ocr}</button>`
                : '';
            return `
            <div class="llm-input__attachment-tag">
                <span class="llm-input__file-icon">${isImage ? '🖼️' : '📄'}</span>
                <span class="llm-input__filename">${escapeHTML(f.name)}</span>
                <span class="llm-input__filesize">(${ChatInputTemplates.formatSize(f.size)})</span>
                ${ocrBtn}
                <span class="llm-input__remove-btn" data-index="${i}" title="Remove">×</span>
            </div>
        `;
        }).join('');

        const batchBtn = (canOcr && imageCount >= 2)
            ? `<button class="llm-input__ocr-all-btn" type="button" title="${t('chatInput.ocr.all.tooltip')}">${ACTION_ICONS.ocr} ${t('chatInput.ocr.all')}</button>`
            : '';

        const settings = canOcr && imageCount > 0
            ? `<button class="llm-input__ocr-all-btn llm-input__ocr-settings" type="button" data-ocr-configure title="${t('ocr.configure')}">${t('ocr.configure')}</button>` : '';
        return chips + batchBtn + settings;
    },

    /**
     * 渲染连接选项（替代原 renderModelOptions）
     * 有 key 的连接在前，无 key 的归入「需配置 API Key」分组置灰。
     */
    renderConnectionOptions(connections: ConnectionOption[], selectedId?: string): string {
        const withKey    = connections.filter(c => c.hasApiKey);
        const withoutKey = connections.filter(c => !c.hasApiKey);

        const renderOption = (c: ConnectionOption) => {
            const label    = c.provider ? `${escapeHTML(c.name)} (${escapeHTML(c.provider)})` : escapeHTML(c.name);
            const selected = c.id === selectedId ? ' selected' : '';
            const tierHint = c.hasTiers ? ' ⚡' : '';
            return `<option value="${escapeHTML(c.id)}"${selected}>${label}${tierHint}</option>`;
        };

        let html = `<option value="">${t('connection.followDefaultShort')}</option>`;
        html += withKey.map(renderOption).join('');
        if (withoutKey.length > 0) {
            html += `<optgroup label="⚠️ 需配置 API Key">`;
            html += withoutKey.map(renderOption).join('');
            html += `</optgroup>`;
        }
        return html;
    },

    /**
     * 渲染 Agent 选择器选项
     */
    renderExecutorOptions(executors: ExecutorOption[]): string {
        const groups: Record<string, ExecutorOption[]> = {};
        const uncategorized: ExecutorOption[] = [];

        executors.forEach(e => {
            if (e.category) {
                if (!groups[e.category]) groups[e.category] = [];
                groups[e.category].push(e);
            } else {
                uncategorized.push(e);
            }
        });

        let html = '';

        if (uncategorized.length > 0) {
            html += uncategorized.map(e => this.renderExecutorOption(e)).join('');
        }

        Object.entries(groups).forEach(([category, items]) => {
            html += `<optgroup label="${escapeHTML(category)}">`;
            html += items.map(e => this.renderExecutorOption(e)).join('');
            html += `</optgroup>`;
        });

        return html;
    },

    /**
     * 渲染单个 Agent 选项
     */
    renderExecutorOption(e: ExecutorOption): string {
        const icon = e.icon ? `${e.icon} ` : '';
        return `<option value="${escapeHTML(e.id)}">${icon}${escapeHTML(e.name)}</option>`;
    },

    // ================================================================
    // 工具方法
    // ================================================================

    formatSize(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    },

    // ================================================================
    // SVG 图标
    // ================================================================

    settingsIcon(): string {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>`;
    },

    closeIcon(): string {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;
    },

    sliderIcon(): string {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="4" y1="21" x2="4" y2="14"></line>
            <line x1="4" y1="10" x2="4" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12" y2="3"></line>
            <line x1="20" y1="21" x2="20" y2="16"></line>
            <line x1="20" y1="12" x2="20" y2="3"></line>
            <line x1="1" y1="14" x2="7" y2="14"></line>
            <line x1="9" y1="8" x2="15" y2="8"></line>
            <line x1="17" y1="16" x2="23" y2="16"></line>
        </svg>`;
    },

    attachIcon(): string {
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
        </svg>`;
    },

    /** "+" add-source trigger icon (plus in circle). */
    addIcon(): string {
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="16"></line>
            <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>`;
    },

    sendIcon(): string {
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>`;
    },

    stopIcon(): string {
        return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        </svg>`;
    },

    helpIcon(): string {
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>`;
    },

    moreIcon(): string {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>
            <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>
            <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>
        </svg>`;
    },
};
