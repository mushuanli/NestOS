import {isCommandInput} from '@itookit/llm-ui';
import { OcrSettingsForm, Modal, Toast } from '@itookit/ui-common';
// @file: llm-ui/components/input/ChatInputView.ts

import type { IChatInputPresenter, IChatInputConfig } from '../../domain/ports/IChatInputPresenter';
import type { ChatInputInteraction, InteractionReply } from '../../domain/ports/IChatInputPresenter';
import type {
    ExecutorOption, ConnectionOption,
    ChatOverrides, SkillInfo, FileSuggestion,
} from '../../domain/types';
import { t, randomUUID, ENTITY_ICONS, CHAT_ICONS } from '@itookit/common';
import { type JsonValue } from '@itookit/llm-flow/contracts';
import { type ModelTier } from '@itookit/driver-llm/contracts';
import { ChatInputTemplates } from '../templates/ChatInputTemplates';
import type { InputPlugin, InputPluginContext } from './plugins/InputPlugin';
import { MentionPlugin } from './plugins/MentionPlugin';
import { TokenMeterPlugin } from './plugins/TokenMeterPlugin';
import { PopupPanel } from './plugins/PopupPanel';
import type { PopupItem } from './plugins/PopupPanel';
import { AttachmentManager } from './AttachmentManager';
import {ImageResizeSettings} from './ImageResizeSettings';
import {resolveResize, type ImageResizePolicy} from '@itookit/image-parser';
import { ToolOutputPanel } from './ToolOutputPanel';
import { HelpPanel } from './HelpPanel';
import { SkillPanel } from './SkillPanel';
import {NativeModelControl} from './NativeModelControl';
import { ConnectionTierController } from './ConnectionTierController';
import { ConnectionReadiness, type ConnectionLoadState } from './ConnectionReadiness';
import { isDirectCommandInput } from '../../commands/direct-command';
import { agentUnavailableReason, type AgentFlowDraftInput, type AgentFlowSubmission } from '../../flows/agent-flow';
import { ExecutionModeControl } from './ExecutionModeControl';
import { InteractionPanel } from './InteractionPanel';
import { delegate } from '../../utils/domEvents';

export interface ChatInputOptions {
    instructionQueue?: boolean;
    flushDraft?: () => Promise<void>;
    persistImageFiles?: (files: File[], resize: ImageResizePolicy) => Promise<void>;
    nativeModels?(executorId: string): Promise<import('@itookit/ui-common').ConversationModelCatalog>;
    /** Host-owned menu slot for immutable conversation mode information. */
    executionModeInfo?: HTMLElement;
    executorUsage?: import('@itookit/ui-common').EditorOptions['executorUsage'];
    attachments?: boolean;
    attachmentAccept?: string;
    attachmentHint?: string;
    executorLocked?: boolean;
    maxAgentExchanges?: number;
    onSend: (text: string, files: File[], executorId: string, overrides?: ChatOverrides) => Promise<void | false>;
    prepareAgentFlow?(agent: ExecutorOption, signal: AbortSignal, draft: AgentFlowDraftInput): Promise<AgentFlowSubmission | null>;
    onStop: () => void;
    onExecutorChange?: (executorId: string) => void;
    onConfigureExecutor?: () => void;
    onSwitchExecutionTarget?: (input: {text: string; files: File[]}) => Promise<void>;
    onDraftChange?: (config: IChatInputConfig, files: File[]) => void;
    onConfigChange?: (config: IChatInputConfig) => void;
    initialAgents?: ExecutorOption[];
    initialConfig?: Partial<IChatInputConfig>;
    /** 获取所有可用连接列表，供 Connection 覆盖下拉使用。 */
    onRequestConnections?: () => Promise<ConnectionOption[]>;

    // ── Kernel callbacks ────────────────────────────────────────────────────

    /**
     * 获取可用 Skill 列表（含 loaded 状态）。
     *
     * 仅在 kernel 模式可用时由 Shell 注入。
     * ChatInput 在设置面板打开时调用此函数刷新列表。
     */
    onConfigureCapabilities?: () => void;
    onRequestSkills?: () => Promise<SkillInfo[]>;

    /**
     * 加载 Skill 到当前 kernel 会话。
     *
     * 调用后 kernel 的 IToolService 会注册该 Skill 的工具，
     * system prompt 会追加 Skill 的使用指令。
     *
     * @returns 新加载的工具 ID 列表
     */
    onLoadSkill?: (skillId: string) => Promise<string[]>;

    /**
     * 卸载 Skill。
     */
    onUnloadSkill?: (skillId: string) => Promise<void>;

    /**
     * 获取当前可用 Skill 列表（含 loaded 状态）。
     *
     * 供 SlashCommandPlugin 动态生成 Skill 快捷命令，每次弹出面板时调用。
     */
    getSkills?: () => SkillInfo[];

    // ── @mention 文件引用 ─────────────────────────────────────────────────────

    /**
     * 用户键入 `@` 后，根据 query 返回文件建议列表。
     *
     * 由 Shell 注入：调用 sessionEngine.searchFiles(query) 或
     * 遍历当前模块 VFS 节点。未提供时 `@` 不触发文件选择器。
     *
     * 返回的 `path` 字段将以 Markdown 链接形式插入输入框，
     * 发送时由 AttachmentProcessor 自动解析并附加文件内容。
     */
    onRequestFiles?: (query: string, options?: { includeIgnored?: boolean; signal?: AbortSignal }) => Promise<FileSuggestion[]>;

    /** Host-owned image recognition, shared configuration and live connection label. */
    ocr?: import('@itookit/ui-common').OcrControls;

    /**
     * 预留（本期不接线）：语音转文字。
     * 实现后将复用 OcrReviewPanel 的审阅流程把转写文本插入输入框。
     */
    onTranscribeAudio?: (audio: Blob) => Promise<string>;

    /**
     * 导航到设置页（如点击连接 badge 跳转到具体连接的编辑页）。
     * resourceId: 'connections' | 'providers'
     * anchor:  连接时 'conn:<id>'，Provider 时 '<providerId>'
     */
    onNavigateSettings?: (target: { resourceId: string; anchor?: string }) => void;
}

/**
 * ChatInput — 实现 IChatInputPresenter
 *
 * Shell 只通过 IChatInputPresenter 交互。
 * 内部 DOM 操作完全封装。
 */
export class ChatInput implements IChatInputPresenter {
    private flowPreparation?: AbortController;
    private agentNotice?: HTMLElement;
    private connectionLoadRevision = 0;
    private connectionsDisposed = false;
    private connectionLoadState: ConnectionLoadState = 'loading';
    private connectionReadiness!: ConnectionReadiness;
    private checkingConnection = false;
    private readonly resizeInput = () => this.adjustTextareaHeight();
    private textarea!: HTMLTextAreaElement;
    private sendBtn!: HTMLButtonElement;
    private stopBtn!: HTMLButtonElement;
    private attachBtn!: HTMLButtonElement;
    private settingsBtn!: HTMLButtonElement;
    private webSearchQuickBtn!: HTMLButtonElement;
    private historySlider!: HTMLInputElement;
    private historyValue: HTMLSpanElement | null = null; // removed from new template
    private streamToggle!: HTMLInputElement;
    private settingsPanel!: HTMLElement;
    private ocrSettings?: OcrSettingsForm;
    private flowIdInput!: HTMLInputElement;
    private branchModeSelect!: HTMLSelectElement;
    private retentionModeSelect!: HTMLSelectElement;
    private fileInput!: HTMLInputElement;
    private attachmentContainer!: HTMLElement;
    private inputWrapper!: HTMLElement;

    // ── Agent Picker (custom combobox, popup via PopupPanel) ─────────────────
    private agents: ExecutorOption[] = [];
    private readonly nativeModels: NativeModelControl;
    hideNativeModelPicker(): void {this.nativeModels.hide(); for (const plugin of this.plugins) plugin.onBlur?.();}
    private textRevision = 0;
    private observedText = '';
    getDraftRevision(): number {
        if (this.observedText !== this.textarea.value) {this.observedText = this.textarea.value; ++this.textRevision;}
        return this.textRevision;
    }
    getNativeModelSelection() {return this.nativeModels.selection();}
    setNativeModelsAvailable(enabled: boolean): void {
        const agent = this.agents.find(row => row.id === this.config.agentId);
        if (agent) agent.supportsModels = enabled;
        this.nativeModels.setAvailable(enabled);
        if (enabled) this.container.querySelector<HTMLElement>('.llm-input__execution-source')!.hidden = true;
    }
    private agentPickerBtn!: HTMLButtonElement;
    private agentNameEl!: HTMLSpanElement;
    private agentMetaEl!: HTMLSpanElement;
    private agentIconEl!: HTMLSpanElement;
    private agentPopup: PopupPanel | null = null;

    // ── Prompt Picker (preset prompts dropdown, popup via PopupPanel) ────────
    private promptPickerWrapper!: HTMLElement;
    private promptPickerBtn!: HTMLButtonElement;
    private promptPopup: PopupPanel | null = null;

    private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
    private loading = false;
    private availability: {canSend: boolean; canInterrupt: boolean; canCommand?: boolean; canQueryCommand?: (text: string) => boolean} = {canSend: true, canInterrupt: true};
    private files: File[] = [];
    private restoringRecovery = false;
    private settingsExpanded = false;
    private currentAgentId: string = 'default';
    private switchingTarget = false;

    private skillPanel?: SkillPanel;
    private skillModal?: Modal;
    private reasoningIdentity?: string;
    private reasoningPreferences = new Map<string, { effort?: string; thinking?: boolean }>();
    private connectionTier!: ConnectionTierController;
    private executionMode!: ExecutionModeControl;

    // ── Help panel ───────────────────────────────────────────────────────────
    private helpPanel!: HelpPanel;

    // ── More menu ─────────────────────────────────────────────────────────────
    private moreBtn!: HTMLButtonElement;

    // ── Tool output panel ─────────────────────────────────────────────────────
    private toolOutput: ToolOutputPanel;
    private interactionPanel: InteractionPanel;

    // ── Session profile ───────────────────────────────────────────────────────
    private systemPromptAppendInput!: HTMLTextAreaElement;

    // ── Plugin system ────────────────────────────────────────────────────────
    private plugins: InputPlugin[] = [];
    private pluginCtx: InputPluginContext | null = null;
    private tokenMeterPlugin: TokenMeterPlugin | null = null;

    // ── Attachment manager ────────────────────────────────────────────────────
    private attachmentMgr!: AttachmentManager;
    private imageSettings?: ImageResizeSettings;

    private config: IChatInputConfig = {
        text: '',
        agentId: 'default',
        settings: {
            executionMode: 'chat',
            connectionId: undefined,
            modelTier: 'auto',
            historyLength: -1,
            streamMode: true,
            branchMode: 'continue',
            retentionMode: 'persistent',
        },
    };

    /** 上次已通知的 settings JSON — 内容不变则跳过保存 */
    private lastNotifiedSettings: string | null = null;

    constructor(private container: HTMLElement, private options: ChatInputOptions) {
        if (options.initialConfig) {
            this.config = this.mergeConfig(this.config, options.initialConfig);
        }
        this.currentAgentId = this.config.agentId;

        this.render();
        this.imageSettings = new ImageResizeSettings(this.settingsPanel.querySelector<HTMLElement>('.llm-input__settings-body')!,
            () => ({override: this.config.settings.imageResize, agent: this.agents.find(agent => agent.id === this.config.agentId)?.imageProcessing?.resize}),
            resize => {this.config.settings.imageResize = resize; this.notifyConfigChange();});

        // 面板必须在 render()（写入模板 + bindElements）之后构造，DOM 才存在。
        this.nativeModels = new NativeModelControl(container, () => this.options.nativeModels!(this.config.agentId), error => Toast.error(String(error)), selection => {
            this.config.settings.nativeModelSelection = selection ? {executorId: this.config.agentId, ...selection} : undefined;
            this.notifyConfigChange();
        });
        this.toolOutput = new ToolOutputPanel(container, () => this.textarea?.focus());
        this.interactionPanel = new InteractionPanel(container);
        this.helpPanel = new HelpPanel(container, {
            hasFiles: () => !!this.options.onRequestFiles,
            onCloseSettings: () => this.toggleSettings(false),
        });
        this.connectionTier = new ConnectionTierController(container, {
            onReasoning: (caps, identity, selected) => this.syncModelReasoning(caps, identity, selected),
            onRefreshConnections: () => this.refreshConnections(),
            onNavigateSettings: (target) => this.options.onNavigateSettings?.(target),
            onChange: () => {
                this.config.settings.connectionId = this.connectionTier.getConnectionId();
                this.config.settings.modelTier = this.connectionTier.getModelTier();
                this.updateActiveBadges();
                this.refreshConnectionStatus();
                this.notifyConfigChange();
            },
        });

        this.connectionReadiness = new ConnectionReadiness(container, {
            navigate: target => this.options.onNavigateSettings?.(target),
            choose: () => this.openConnectionPicker(), retry: () => { void this.refreshConnections(); },
        });

        if (options.ocr) {
            const section = container.querySelector<HTMLElement>('[data-ocr-preferences]')!; section.hidden = false;
            this.ocrSettings = new OcrSettingsForm(section.querySelector<HTMLElement>('[data-ocr-fields]')!, options.ocr);
        }
        this.bindEvents();
        this.executionMode = new ExecutionModeControl(container, mode => {
            this.config.settings.executionMode = mode;
            this.notifyConfigChange();
        }, options.maxAgentExchanges, options.executionModeInfo);
        this.initExecutors();
        this.syncUIFromConfig();
        if (options.attachments === false) this.attachBtn.hidden = true;
        if (options.attachmentAccept) this.fileInput.accept = options.attachmentAccept;
        if (options.attachmentHint) this.attachBtn.title = options.attachmentHint;
        this.applyAvailability();
        this.loadConnections();
        window.addEventListener('resize', this.resizeInput);
        window.visualViewport?.addEventListener('resize', this.resizeInput);
        this.adjustTextareaHeight();

        // TokenMeterPlugin — always registered, shows token stats after each response
        const tokenMeter = new TokenMeterPlugin();
        this.tokenMeterPlugin = tokenMeter;
        this.registerPlugin(tokenMeter);

        // Register MentionPlugin if file-request callback is available
        if (options.onRequestFiles) {
            this.registerPlugin(new MentionPlugin({ onRequestFiles: options.onRequestFiles }));
        }

    }

    /**
     * 注册插件（init 后、bindEvents 后调用）
     */
    registerPlugin(plugin: InputPlugin): void {

        this.plugins.push(plugin);
        this.plugins.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

        // Track known plugins for typed access
        if (plugin.id === 'token-meter') {
            this.tokenMeterPlugin = plugin as TokenMeterPlugin;
        }

        if (this.pluginCtx) {
            plugin.activate(this.pluginCtx);
        }
    }

    private initPluginSystem(): void {
        this.pluginCtx = {
            textarea: this.textarea,
            container: this.container,
            getText: () => this.textarea.value,
            setText: (text) => {
                this.textarea.value = text;
                this.config.text = text;
                this.getDraftRevision();
                this.adjustTextareaHeight();
            },
            insertAtCursor: (text) => {
                const pos = this.textarea.selectionStart;
                const before = this.textarea.value.slice(0, pos);
                const after = this.textarea.value.slice(pos);
                this.pluginCtx!.setText(before + text + after);
                this.textarea.selectionStart = this.textarea.selectionEnd = pos + text.length;
            },
            replaceRange: (start, end, text) => {
                const val = this.textarea.value;
                this.pluginCtx!.setText(val.slice(0, start) + text + val.slice(end));
                this.textarea.selectionStart = this.textarea.selectionEnd = start + text.length;
            },
            getCursorPosition: () => this.textarea.selectionStart,
            setCursorPosition: (pos) => {
                this.textarea.selectionStart = this.textarea.selectionEnd = pos;
            },
            triggerSend: () => this.triggerSend(),
            focus: () => this.textarea.focus(),
            getAgentId: () => this.config.agentId,
        };

        for (const plugin of this.plugins) {
            plugin.activate(this.pluginCtx);
        }
    }

    // ================================================================
    // IChatInputPresenter 实现
    // ================================================================

    setLoading(loading: boolean): void {
        this.loading = loading;
        const queue = this.canQueue();
        const locked = loading && !queue;
        this.syncExecutionMode();
        this.sendBtn.style.display = locked ? 'none' : 'flex';
        this.sendBtn.title = t(loading && queue ? 'session.instructions.add' : 'chatInput.send');
        this.sendBtn.setAttribute('aria-label', this.sendBtn.title);
        this.stopBtn.style.display = loading ? 'flex' : 'none';
        this.textarea.disabled = false;
        this.agentPickerBtn.disabled = locked;
        this.connectionTier.setLoading(locked);
        this.attachBtn.disabled = locked;
        this.settingsBtn.disabled = locked;
        if (this.moreBtn) this.moreBtn.disabled = locked;

        if (loading) { this.toggleSettings(false); this.closeToolbarMenus(); }
        this.applyAvailability();
    }

    setAvailability(value: {canSend: boolean; canInterrupt: boolean; canCommand?: boolean; canQueryCommand?: (text: string) => boolean}): void {
        this.availability = value; this.applyAvailability();
    }

    private applyAvailability(): void {
        const command = isDirectCommandInput(this.textarea.value) || this.textarea.value.trimStart().startsWith('/');
        this.sendBtn.style.display = this.loading && !this.canQueue() && !this.canQuery() && !this.independentQueryAvailable() ? 'none' : 'flex';
        this.sendBtn.disabled = !this.inputAvailable() || this.submitting > 0 && !this.independentQueryAvailable() || this.checkingConnection || !!this.attachmentMgr?.images.busy || (!!this.connectionReadiness?.blocked && !command)
            || (!!agentUnavailableReason(this.selectedExecutor()) && !command);
        this.stopBtn.disabled = !this.availability.canInterrupt;
        this.agentPickerBtn.disabled = (this.loading && !this.canQueue()) || !!this.options.executorLocked;
    }

    private canQueue(): boolean {
        return !!this.options.instructionQueue && !this.config.settings.flowId;
    }

    private requiresConnection(): boolean {
        return !!this.options.onRequestConnections && !this.config.agentId.startsWith('remote:') && !this.config.settings.flowId && !this.agentFlow();
    }

    private selectedExecutor(): ExecutorOption | undefined { return this.agents.find(agent => agent.id === this.config.agentId); }
    private agentFlow(): boolean { return this.selectedExecutor()?.execution?.kind === 'flow'; }
    cancelPendingSend(): void { this.flowPreparation?.abort(); }

    private refreshConnectionStatus(): void {
        this.connectionReadiness?.update(this.requiresConnection(), this.connectionLoadState, this.connectionTier.getIssue(), this.sendBtn);
        this.applyAvailability();
    }

    setConfig(config: Partial<IChatInputConfig>): void {
        if (config.agentId && config.agentId !== this.config.agentId) this.flowPreparation?.abort();
        this.config = this.mergeConfig(this.config, config);
        this.syncUIFromConfig();
        this.imageSettings?.refresh(); this.attachmentMgr?.images.refresh();

        if (config.agentId && config.agentId !== this.currentAgentId) {
            this.currentAgentId = config.agentId;
            this.updateAgentTrigger();
        }
    }

    getConfig(): IChatInputConfig {
        this.syncConfigFromUI();
        return {
            text: this.config.text,
            agentId: this.config.agentId,
            settings: { ...this.config.settings },
        };
    }

    restoreInput(text: string, agentId?: string): void {
        if (text) {
            this.config.text = text;
            this.textarea.value = text;
            this.getDraftRevision();
            this.adjustTextareaHeight();
        }
        if (agentId) {
            this.config.agentId = agentId;
            this.currentAgentId = agentId;
            this.updateAgentTrigger();
        }
        this.textarea.focus();
        this.textarea.selectionStart = this.textarea.selectionEnd = this.textarea.value.length;
    }

    focus(): void {
        this.textarea?.focus();
    }

    refreshAgents(agents: ExecutorOption[], validateAgentId: (id: string) => string): boolean {
        const currentAgentId = this.config.agentId;
        this.updateExecutors(agents);

        const validatedId = validateAgentId(currentAgentId);
        const changed = validatedId !== currentAgentId;

        if (changed) {
            this.config.agentId = validatedId;
            this.currentAgentId = validatedId;
            this.config.settings.modelTier = 'auto';
            this.connectionTier.setModelTier('auto');
            this.updateActiveBadges();
        }

        this.updateAgentTrigger();
        return changed;
    }

    /** Draft target changes preserve input, attachments and independent model settings. */
    setExecutorChoices(agents: ExecutorOption[], selectedId: string): void {
        this.agentPopup?.hide(); this.updateExecutors(agents); this.selectAgent(selectedId);
    }

    appendDraft(input: {text: string; files: File[]}): void {
        const text = [this.getConfig().text, input.text].filter(Boolean).join('\n\n');
        this.restoreDraft(text, input.files, this.config.agentId);
    }

    updateTokenStats(stats: import('../../domain/types').TokenStats | null): void {
        this.tokenMeterPlugin?.update(stats);
    }

    /**
     * Inline tool output panel — appears above the textarea, inside the ChatInput.
     * Replaces any previous output so the panel shows only the latest command.
     * Dismissed by the × button or when the user sends an agent message.
     */
    showToolOutput(cmd: string, output: string, success: boolean): void {
        this.toolOutput.show(cmd, output, success);
    }

    clearToolOutput(): void {
        this.toolOutput.clear();
    }

    showInteraction(request: ChatInputInteraction, respond: (reply: InteractionReply) => Promise<void>): void {
        this.interactionPanel.show(request, respond);
    }

    clearInteraction(interactionId?: string): void { this.interactionPanel.clear(interactionId); }

    /** Rebind a prepared conversation without replacing text, files, focus or DOM. */
    checkpoint(): () => void {
        const options = this.options, plugins = [...this.plugins];
        return () => {
            for (const plugin of this.plugins) if (!plugins.includes(plugin)) plugin.deactivate?.();
            this.plugins = plugins; this.adopt(options);
        };
    }
    adopt(options: ChatInputOptions): void {
        const hadFiles = !!this.options.onRequestFiles;
        this.options = options;
        if (options.onRequestFiles && !hadFiles) this.registerPlugin(new MentionPlugin({onRequestFiles: options.onRequestFiles}));
        this.executionMode.configure(options.executionModeInfo, options.maxAgentExchanges);
        if (options.initialAgents) {
            this.agentPopup?.hide(); this.updateExecutors(options.initialAgents);
            this.config.agentId = options.initialAgents.some(agent => agent.id === this.config.agentId)
                ? this.config.agentId : options.initialConfig?.agentId ?? options.initialAgents[0]?.id ?? 'default';
            this.currentAgentId = this.config.agentId;
        }
        this.attachBtn.hidden = options.attachments === false;
        this.fileInput.accept = options.attachmentAccept ?? '';
        if (options.attachmentHint) this.attachBtn.title = options.attachmentHint;
        this.syncUIFromConfig(); this.applyAvailability(); void this.refreshConnections();
    }

    destroy(): void {
        this.flowPreparation?.abort();
        this.nativeModels.destroy();
        for (const plugin of this.plugins.splice(0)) {
            try {plugin.deactivate();} catch (error) {console.error('Input plugin cleanup failed', error);}
        }
        window.removeEventListener('resize', this.resizeInput);
        window.visualViewport?.removeEventListener('resize', this.resizeInput);
        delete this.container.dataset.editorComposing;
        this.connectionsDisposed = true;
        this.connectionLoadRevision++;
        this.ocrSettings?.destroy();
        this.skillModal?.hide(); this.skillPanel = undefined;
        this.interactionPanel.clear();
        if (this.outsideClickHandler) {
            document.removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }
        this.agentPopup?.destroy();
        this.agentPopup = null;
        this.connectionTier.destroy();
        this.connectionReadiness.destroy();
        this.executionMode.destroy();
        this.promptPopup?.destroy();
        this.promptPopup = null;
        this.attachmentMgr?.destroy();
        this.helpPanel.destroy();
        this.container.innerHTML = '';
        this.files = [];
    }

    // ================================================================
    // 内部实现（与原始代码一致，省略重复部分）
    // ================================================================

    private mergeConfig(base: IChatInputConfig, partial: Partial<IChatInputConfig>): IChatInputConfig {
        return {
            text: partial.text ?? base.text,
            agentId: partial.agentId ?? base.agentId,
            settings: { ...base.settings, ...(partial.settings || {}) },
        };
    }

    private render(): void {
        this.container.innerHTML = ChatInputTemplates.renderMain();
        this.bindElements();
        this.updateHistoryDisplay();

        this.attachmentMgr = new AttachmentManager({
            container: this.container,
            fileInput: this.fileInput,
            attachmentContainer: this.attachmentContainer,
            textarea: this.textarea,
            inputWrapper: this.inputWrapper,
            attachBtn: this.attachBtn,
            ocr: this.options.ocr,
            onRequestFiles: (query: string) => this.options.onRequestFiles?.(query) ?? Promise.resolve([]),
            getLoading: () => this.loading,
            canAttach: () => this.canAttach(),
            getFiles: () => this.files,
            setFiles: (f) => { this.files = f; if (!this.restoringRecovery) this.options.onDraftChange?.(this.getConfig(), [...f]); },
            notifyConfigChange: () => this.notifyConfigChange(),
            getImageResize: () => resolveResize(this.config.settings.imageResize, this.agents.find(agent => agent.id === this.config.agentId)?.imageProcessing?.resize),
            setImageResize: resize => {this.config.settings.imageResize = resize; this.notifyConfigChange();},
            onImageStateChange: () => {this.applyAvailability(); this.attachmentMgr?.renderAttachments();},
            flushFiles: () => this.options.flushDraft?.() ?? Promise.resolve(),
            persistFiles: this.options.persistImageFiles,
        });
    }

    private bindElements(): void {
        const q = <T extends HTMLElement>(sel: string): T =>
            this.container.querySelector(sel) as T;

        this.textarea = q('.llm-input__textarea');
        this.sendBtn = q('.llm-input__btn--send');
        this.stopBtn = q('.llm-input__btn--stop');
        this.attachBtn = q('.llm-input__btn--attach');
        this.settingsBtn = q('.llm-input__btn--settings');
        this.webSearchQuickBtn = q('.llm-input__btn--websearch');
        this.moreBtn = q('.llm-input__btn--more');

        // Agent Picker combobox elements
        this.agentPickerBtn = q('.llm-input__agent-trigger');
        this.agentIconEl = q('.llm-input__agent-icon');
        this.agentNameEl = q('.llm-input__agent-name');
        this.agentMetaEl = q('.llm-input__agent-meta');

        // Prompt picker elements (in toolbar)
        this.promptPickerWrapper = q('.llm-input__prompt-picker-wrapper');
        this.promptPickerBtn = q('.llm-input__prompt-picker');

        this.historySlider = q('.llm-input__history-slider');
        this.historyValue = this.container.querySelector('.llm-input__history-value');
        this.streamToggle = q('.llm-input__stream-toggle');
        this.settingsPanel = q('.llm-input__settings-panel');
        this.flowIdInput = q('.llm-input__flow-id');
        this.branchModeSelect = q('.llm-input__branch-mode');
        this.retentionModeSelect = q('.llm-input__retention-mode');
        this.fileInput = q('.llm-input__file-input');
        this.attachmentContainer = q('.llm-input__attachments');
        this.inputWrapper = q('.llm-input__field-wrapper');

        // Session profile
        this.systemPromptAppendInput = this.container.querySelector('.llm-input__system-prompt-append') as HTMLTextAreaElement;
    }

    private bindEvents(): void {
        this.bindToolbarMenus();
        this.container.querySelector('.llm-input__btn--switch-target')?.addEventListener('click', () => { void this.switchExecutionTarget(); });
        for (const selector of ['.llm-input__btn--configure-agent', '.llm-input__flow-configure']) {
            this.container.querySelector(selector)?.addEventListener('click', () => {
                if (this.loading) return;
                this.closeToolbarMenus(); this.options.onConfigureExecutor?.();
            });
        }
        this.webSearchQuickBtn?.addEventListener('click', () => {
            const next = !(this.config.settings.webSearchEnabled ?? true);
            this.config.settings.webSearchEnabled = next;
            this.syncWebSearchUI(next);
            this.notifyConfigChange();
        });
        this.flowIdInput?.addEventListener('input', () => {
            this.config.settings.flowId = this.flowIdInput.value.trim() || undefined;
            this.syncExecutionMode();
            this.notifyConfigChange();
        });
        this.branchModeSelect?.addEventListener('change', () => {
            this.config.settings.branchMode =
                this.branchModeSelect.value === 'fork' ? 'fork' : 'continue';
            this.notifyConfigChange();
        });
        this.retentionModeSelect?.addEventListener('change', () => {
            this.config.settings.retentionMode =
                this.retentionModeSelect.value === 'temporary'
                    ? 'temporary'
                    : 'persistent';
            this.notifyConfigChange();
        });
        this.textarea.addEventListener('input', () => {
            this.getDraftRevision();
            this.adjustTextareaHeight();
            this.config.text = this.textarea.value;
            this.applyAvailability();
            this.notifyConfigChange();
            // Close help when user starts typing
            if (this.helpPanel.isVisible && this.textarea.value.length > 0) this.hideHelp();

            const cursorPos = this.textarea.selectionStart;
            for (const plugin of this.plugins) {
                plugin.onInput?.(this.textarea.value, cursorPos);
            }
        });
        this.textarea.addEventListener('focus', () => { this.container.dataset.editorComposing = 'true'; });
        this.textarea.addEventListener('blur', () => {
            delete this.container.dataset.editorComposing;
            for (const plugin of this.plugins) plugin.onBlur?.();
        });

        this.textarea.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            // Esc closes help panel before propagating to plugins
            if (e.key === 'Escape' && this.helpPanel.isVisible) {
                e.preventDefault();
                this.hideHelp();
                return;
            }

            for (const plugin of this.plugins) {
                if (plugin.onKeyDown?.(e)) {
                    return;
                }
            }

            const mobile = window.matchMedia?.('(max-width: 768px) and (pointer: coarse)').matches;
            if (e.key === 'Enter' && !e.shiftKey && (!mobile || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.triggerSend();
            }
        });

        this.textarea.addEventListener('paste', (e) => this.attachmentMgr.handlePaste(e));

        this.sendBtn.addEventListener('click', () => this.triggerSend());
        this.stopBtn.addEventListener('click', () => this.options.onStop());
        this.attachBtn.addEventListener('click', () => this.attachmentMgr.toggleAddMenu(
            (anchor, opts) => new PopupPanel(anchor, opts)
        ));
        this.settingsBtn.addEventListener('click', () => { this.closeToolbarMenus(); this.toggleSettings(); });
        this.moreBtn?.addEventListener('click', event => { event.stopPropagation(); this.closeToolbarMenus(); this.toggleHelp(); });

        this.container.querySelector('.llm-input__settings-close')
            ?.addEventListener('click', () => this.toggleSettings(false));

        this.fileInput.addEventListener('change', () => {
            if (this.options.attachments !== false && this.fileInput.files) {
                this.attachmentMgr.addFiles(Array.from(this.fileInput.files));
                this.fileInput.value = '';
            }
        });

        // Attachment chips use event delegation: one listener on the persistent
        // container, dispatched by selector. Re-rendering innerHTML never rebinds.
        delegate(this.attachmentContainer, 'click', '.llm-input__remove-btn', ({ event, index }) => {
            event.stopPropagation();
            if (Number.isNaN(index)) return;
            this.files.splice(index, 1);
            this.attachmentMgr.images.refresh(); this.attachmentMgr.renderAttachments(); this.notifyConfigChange();
        });
        delegate(this.attachmentContainer, 'click', '.llm-input__ocr-btn', ({ event, index }) => {
            event.stopPropagation();
            if (Number.isNaN(index)) return;
            this.attachmentMgr.ocrImage(this.files[index], index);
        });
        delegate(this.attachmentContainer, 'click', '.llm-input__ocr-all-btn:not([data-ocr-configure])', ({ event }) => {
            event.stopPropagation();
            this.attachmentMgr.ocrAllImages();
        });

        this.bindSettingsEvents();
        this.attachmentMgr.bindDragEvents();
        this.bindOutsideClickHandler();

        // 初始化插件系统（放在所有事件绑定之后）
        this.initPluginSystem();
    }

    private syncModelReasoning(caps: import('@itookit/driver-llm/contracts').ReasoningCapabilities | undefined, identity: string, selected: boolean): void {
        const select = this.container.querySelector<HTMLSelectElement>('.llm-input__reasoning-select');
        const toggle = this.container.querySelector<HTMLInputElement>('.llm-input__thinking-toggle');
        if (!select || !toggle) return;
        if (selected && this.reasoningIdentity && this.reasoningIdentity !== identity) {
            this.reasoningPreferences.set(this.reasoningIdentity, { effort: this.config.settings.reasoningEffort, thinking: this.config.settings.thinkingEnabled });
            const saved = this.reasoningPreferences.get(identity);
            this.config.settings.reasoningEffort = saved?.effort ?? 'auto'; this.config.settings.thinkingEnabled = saved?.thinking;
        }
        this.reasoningIdentity = identity;
        select.replaceChildren(new Option(t('thinking.effort.auto'), 'auto'), ...(caps?.efforts ?? []).map(option => new Option(option.label ?? option.id, option.id)));
        const effort = this.config.settings.reasoningEffort;
        select.value = effort && [...select.options].some(option => option.value === effort) ? effort : 'auto';
        toggle.disabled = !caps || caps.canDisable === false;
        const row = toggle.closest<HTMLElement>('.llm-input__setting-row')!; row.hidden = !caps; row.style.display = caps ? '' : 'none';
        toggle.checked = this.config.settings.thinkingEnabled ?? true;
        select.disabled = !caps?.efforts.length;
    }

    private bindSettingsEvents(): void {
        // Agent Picker combobox — popup handled by PopupPanel
        this.agentPickerBtn.addEventListener('click', () => this.toggleAgentPicker());

        // Prompt picker — popup handled by PopupPanel
        this.promptPickerBtn?.addEventListener('click', () => { this.closeToolbarMenus(); this.togglePromptPicker(); });

        this.historySlider.addEventListener('input', () => {
            this.config.settings.historyLength = parseInt(this.historySlider.value);
            this.updateHistoryDisplay();
            this.updatePresetButtons();
            this.updateActiveBadges();
        });

        this.historySlider.addEventListener('change', () => {
            this.notifyConfigChange();
        });

        this.streamToggle.addEventListener('change', () => {
            // Block Mode checked → streaming disabled
            this.config.settings.streamMode = !this.streamToggle.checked;
            this.updateStreamToggleLabel();
            this.updateActiveBadges();
            this.notifyConfigChange();
        });

        const thinkingToggle = this.container.querySelector('.llm-input__thinking-toggle') as HTMLInputElement | null;
        const reasoningRow = this.container.querySelector('.llm-input__reasoning-wrapper') as HTMLElement | null;
        const reasoningSelect = this.container.querySelector('.llm-input__reasoning-select') as HTMLSelectElement | null;

        const syncThinkingUI = () => {
            const on = thinkingToggle?.checked ?? true;
            if (reasoningRow) reasoningRow.style.display = on ? '' : 'none';
        };

        thinkingToggle?.addEventListener('change', () => {
            syncThinkingUI();
            this.config.settings.thinkingEnabled = thinkingToggle?.checked;
            if (!thinkingToggle?.checked) { this.config.settings.reasoningEffort = 'auto'; if (reasoningSelect) reasoningSelect.value = 'auto'; }
            this.notifyConfigChange();
        });

        reasoningSelect?.addEventListener('change', () => {
            const val = reasoningSelect.value;
            this.config.settings.reasoningEffort = val;
            this.notifyConfigChange();
        });

        const webSearchToggle = this.container.querySelector('.llm-input__websearch-toggle') as HTMLInputElement | null;
        webSearchToggle?.addEventListener('change', () => {
            this.config.settings.webSearchEnabled = webSearchToggle?.checked;
            this.syncWebSearchUI(webSearchToggle?.checked ?? true);
            this.notifyConfigChange();
        });

        this.container.querySelectorAll('.llm-input__preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const value = parseInt((e.currentTarget as HTMLElement).dataset.history || '-1');
                this.historySlider.value = value.toString();
                this.config.settings.historyLength = value;
                this.updateHistoryDisplay();
                this.updatePresetButtons();
                this.updateActiveBadges();
                this.notifyConfigChange();
            });
        });

        this.container.querySelectorAll('.llm-input__badge-clear').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const clearType = (e.currentTarget as HTMLElement).dataset.clear;
                this.clearSetting(clearType as 'history' | 'stream');
            });
        });

        // Session profile — system prompt append
        this.systemPromptAppendInput?.addEventListener('input', () => {
            this.config.settings.systemPromptAppend = this.systemPromptAppendInput.value.trim() || undefined;
            this.notifyConfigChange();
        });
    }

    private bindOutsideClickHandler(): void {
        this.outsideClickHandler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            for (const menu of this.container.querySelectorAll<HTMLDetailsElement>('.llm-input__toolbar details[open]')) {
                if (!menu.contains(target)) menu.open = false;
            }
            if (this.settingsExpanded) {
                if (!this.settingsPanel.contains(target) && !this.settingsBtn.contains(target)) {
                    this.toggleSettings(false);
                }
            }
        };
        document.addEventListener('click', this.outsideClickHandler);
    }

    // ================================================================
    // 发送
    // ================================================================

    restoreDraft(text: string, files: File[], agentId: string): void {
        this.restoreInput(text, agentId); this.attachmentMgr.addFiles(files);
    }
    getDraftFiles(): File[] { return [...this.files]; }

    captureRecovery(): unknown {
        if (!this.attachmentMgr.canRecover() || this.submitting || this.checkingConnection || this.container.querySelector('.llm-input__interaction'))
            throw Object.assign(new Error(t('httpApp.recoveryBusy')), {code: 'RECOVERY_BUSY'});
        return {config: structuredClone(this.getConfig()), files: [...this.files],
            start: this.textarea.selectionStart, end: this.textarea.selectionEnd};
    }
    restoreRecovery(snapshot: unknown): void {
        const state = snapshot as {config: IChatInputConfig; files: File[]; start: number; end: number};
        // Keep server-owned execution constraints from the freshly opened conversation.
        const {executionMode, executionModeLocked, flowId, flowRevision} = this.getConfig().settings;
        this.restoringRecovery = true;
        try {
            this.files = [];
            this.setConfig({...state.config, settings: {...state.config.settings, executionMode, executionModeLocked, flowId, flowRevision}});
            this.restoreDraft(state.config.text, state.files, state.config.agentId);
            this.textarea.setSelectionRange(state.start, state.end);
        } finally {this.restoringRecovery = false;}
    }

    private async triggerSend(): Promise<void> {
        if (!this.inputAvailable() || this.checkingConnection || this.submitting > 0 && !this.independentQueryAvailable()) return;
        const text = this.textarea.value.trim();
        const unavailable = agentUnavailableReason(this.selectedExecutor());
        if (unavailable && !isDirectCommandInput(text) && !text.startsWith('/')) { Toast.error(unavailable); return; }
        if (!text && this.files.length === 0) return;
        if (this.loading && !this.canQueue() && !this.canQuery() && !this.independentQueryAvailable() && !/^\/(flow|cancel|approve|resume)(?:\s|$)/.test(text)) return;

        if (this.config.agentId.startsWith('remote:')) { await this.submitDraft(text); return; }

        // ✨ before 钩子
        for (const plugin of this.plugins) {
            if (plugin.onBeforeSend?.(text) === false) return;
        }

        if (this.requiresConnection() && !isDirectCommandInput(text) && !await this.checkConnectionBeforeSend(text)) return;

        await this.submitDraft(text);
    }

    private async submitDraft(text: string): Promise<void> {
        if (this.attachmentMgr.images.busy) return;
        const submitted = this.textarea.value, executor = this.config.agentId, files = [...this.files];
        const revision = this.getDraftRevision();
        const remote = executor.startsWith('remote:');
        const overrides = remote ? undefined : this.buildOverrides();
        ++this.submitting; this.applyAvailability();
        try {
            if (!await this.prepareFlowSubmission(text, files, executor, submitted, revision, overrides)) return;
            if (await this.options.onSend(text, files, executor, overrides) === false) return;
            if (!overrides?.flowId && (remote || !isDirectCommandInput(text))) this.recordExecutor(executor);
            if (this.connectionsDisposed) return;
            this.clearSubmittedInput(files, this.getDraftRevision() === revision && this.textarea.value === submitted);
            if (!remote) {
                this.notifyConfigChange(); this.clearToolOutput();
                for (const plugin of this.plugins) plugin.onAfterSend?.(text, executor);
            }
        } catch (error) { if (this.agentFlow()) Toast.error(error instanceof Error ? error.message : t('agent.execution.unavailable')); }
        finally { --this.submitting; if (!this.connectionsDisposed) this.applyAvailability(); }
    }

    private async prepareFlowSubmission(text: string, files: File[], executor: string, submitted: string, revision: number, overrides?: ChatOverrides): Promise<boolean> {
        if (!this.agentFlow() || isDirectCommandInput(text)) return true;
        if (!this.options.prepareAgentFlow) throw new Error(t('agent.execution.unavailable'));
        const preparation = this.flowPreparation = new AbortController();
        const values = await this.options.prepareAgentFlow(this.selectedExecutor()!, preparation.signal, {text, files});
        if (!values || preparation.signal.aborted || this.connectionsDisposed || executor !== this.config.agentId
            || revision !== this.getDraftRevision() || this.textarea.value !== submitted) return false;
        Object.assign(overrides!, values);
        delete overrides!.flowId; delete overrides!.flowRevision;
        return true;
    }

    private recordExecutor(id: string): void {
        try { this.options.executorUsage?.record(id); }
        catch (error) { console.error('[ChatInput] Failed to record executor usage', error); }
    }

    private async checkConnectionBeforeSend(text: string): Promise<boolean> {
        const selection = JSON.stringify([this.config.agentId, this.config.settings]);
        this.checkingConnection = true; this.applyAvailability();
        try {
            const revision = this.connectionLoadRevision + 1;
            await this.loadConnections();
            return !this.connectionsDisposed && !this.connectionReadiness.blocked && (!this.loading || this.canQueue())
                && revision === this.connectionLoadRevision
                && this.availability.canSend && this.textarea.value.trim() === text
                && selection === JSON.stringify([this.config.agentId, this.config.settings]);
        } finally { this.checkingConnection = false; this.applyAvailability(); }
    }

    openConnectionPicker(): void { this.connectionTier.openConnPicker(); }

    private submitting = 0;
    acceptSubmittedDraft(text: string, files: File[], revision?: number): void {
        this.clearSubmittedInput(files, (revision === undefined || this.getDraftRevision() === revision) && this.textarea.value.trim() === text.trim());
    }
    private clearSubmittedInput(files: File[], clearText: boolean): void {
        if (clearText) { this.textarea.value = ''; this.config.text = ''; this.getDraftRevision(); }
        this.files = this.files.filter(file => !files.includes(file));
        this.attachmentMgr.images.refresh(); this.attachmentMgr.renderAttachments(); this.adjustTextareaHeight();
    }

    private buildOverrides(): ChatOverrides {
        const overrides: ChatOverrides = { executionMode: this.config.settings.executionMode ?? 'chat' };
        if (this.config.settings.connectionId) overrides.connectionId = this.config.settings.connectionId;
        // 'auto' means no override — only pass an explicit tier
        const tier = this.config.settings.modelTier;
        if (tier && tier !== 'auto') overrides.modelTier = tier as ModelTier;
        if (this.config.settings.historyLength !== -1) overrides.historyLength = this.config.settings.historyLength;
        if (this.config.settings.temperature !== undefined) overrides.temperature = this.config.settings.temperature;
        if (!this.config.settings.streamMode) overrides.streamMode = false;

        // Reasoning effort override
        const effort = this.config.settings.reasoningEffort;
        if (effort && effort !== 'auto') {
            overrides.reasoningEffort = effort;
        }
        // Thinking toggle (undefined=auto, true=force on, false=force off)
        if (this.config.settings.thinkingEnabled !== undefined) {
            overrides.thinkingEnabled = this.config.settings.thinkingEnabled;
        }
        // Web search toggle (undefined=auto → provider 自动决策，true=强制开，false=强制关)
        if (this.config.settings.webSearchEnabled !== undefined) {
            overrides.webSearchEnabled = this.config.settings.webSearchEnabled;
        }
        // Session profile — system prompt append
        if (this.config.settings.systemPromptAppend) {
            overrides.systemPromptAppend = this.config.settings.systemPromptAppend;
        }
        if (this.config.settings.flowId) overrides.flowId = this.config.settings.flowId;
        if (this.config.settings.flowRevision !== undefined) {
            overrides.flowRevision = this.config.settings.flowRevision;
        }
        if (this.config.settings.flowParameters) {
            overrides.flowParameters = this.config.settings.flowParameters;
        }
        if (this.config.settings.branchMode === 'fork') overrides.branchMode = 'fork';
        if (this.config.settings.retentionMode === 'temporary') overrides.retentionMode = 'temporary';

        return overrides;
    }

    // ================================================================
    // 连接加载
    // ================================================================

    async refreshConnections(): Promise<void> {
        await this.loadConnections();
    }

    selectFlow(flowId: string, revision: number, parameters?: Record<string, JsonValue>): void {
        this.config.settings.flowId = flowId;
        this.config.settings.flowRevision = revision;
        this.config.settings.flowParameters = parameters;
        if (this.flowIdInput) this.flowIdInput.value = flowId;
        this.syncExecutionMode();
        this.notifyConfigChange();
        this.focus();
    }

    private async loadConnections(): Promise<void> {
        if (!this.options.onRequestConnections) return;
        const revision = ++this.connectionLoadRevision;
        if (this.connectionLoadState === 'failed') this.connectionLoadState = 'loading';
        this.refreshConnectionStatus();
        try {
            const connections = await this.options.onRequestConnections();
            if (!this.connectionsDisposed && revision === this.connectionLoadRevision) {
                this.connectionLoadState = 'ready'; this.connectionTier.setConnections(connections);
                this.refreshConnectionStatus();
            }
        } catch (e) {
            if (this.connectionsDisposed || revision !== this.connectionLoadRevision) return;
            this.connectionLoadState = 'failed'; this.refreshConnectionStatus();
            console.error('[ChatInput] Failed to load connections:', e);
        }
    }

    // ================================================================
    // UI 同步
    // ================================================================

    private canAttach(): boolean {
        return this.options.attachments !== false && (!this.config.agentId.startsWith('remote:') || this.options.attachments === true
            || !!this.agents.find(agent => agent.id === this.config.agentId)?.attachmentKinds?.length);
    }
    private syncRemoteControls(): void {
        this.imageSettings?.refresh(); this.attachmentMgr?.images.refresh();
        const remote = this.config.agentId.startsWith('remote:');
        this.connectionTier?.setAgentDefaultConnectionId(remote ? undefined : this.selectedExecutor()?.modelDefaults?.chat);
        const flow = !remote && (!!this.config.settings.flowId || this.agentFlow());
        this.container.classList.toggle('llm-input--remote', remote);
        for (const selector of ['.llm-input__model-trigger', '.llm-input__btn--websearch', '.llm-input__active-settings']) {
            for (const element of this.container.querySelectorAll<HTMLElement>(selector)) element.hidden = remote || flow;
        }
        this.container.querySelector<HTMLElement>('.llm-input__agent-picker')!.hidden = !!this.config.settings.flowId;
        const supportsModels = remote && !!this.options.nativeModels && !!this.agents.find(agent => agent.id === this.config.agentId)?.supportsModels;
        const selected = this.config.settings.nativeModelSelection;
        this.nativeModels?.setBinding(this.config.agentId, supportsModels, selected?.executorId === this.config.agentId ? selected : undefined);
        this.container.querySelector<HTMLElement>('.llm-input__execution-source')!.hidden = !remote || supportsModels;
        const flowButton = this.container.querySelector<HTMLButtonElement>('.llm-input__flow-configure')!;
        flowButton.hidden = !this.config.settings.flowId; flowButton.disabled = this.loading || !this.options.onConfigureExecutor;
        const configure = this.container.querySelector<HTMLButtonElement>('.llm-input__btn--configure-agent')!;
        configure.hidden = remote || !!this.config.settings.flowId || !this.options.onConfigureExecutor; configure.disabled = this.loading;
        this.container.querySelector<HTMLElement>('.llm-input__btn--switch-target')!.hidden = !this.options.onSwitchExecutionTarget;
        this.attachBtn.hidden = !this.canAttach();
        this.settingsBtn.hidden = flow;
        for (const element of this.settingsPanel.querySelectorAll<HTMLElement>('[data-local-settings]')) element.hidden = remote;
        if (flow) this.toggleSettings(false);
        if (remote || flow) this.connectionTier?.hidePopups();
        if (this.connectionTier) this.refreshConnectionStatus();
    }
    private async switchExecutionTarget(): Promise<void> {
        if (!this.options.onSwitchExecutionTarget || this.switchingTarget) return;
        this.switchingTarget = true; this.closeToolbarMenus();
        const button = this.container.querySelector<HTMLButtonElement>('.llm-input__btn--switch-target')!;
        button.disabled = true;
        try { await this.options.onSwitchExecutionTarget({text: this.getConfig().text, files: [...this.files]}); }
        catch (error) { Toast.error(error instanceof Error ? error.message : String(error)); }
        finally { this.switchingTarget = false; button.disabled = false; }
    }
    private syncExecutionMode(): void {
        this.syncRemoteControls();
        this.executionMode?.update({ mode: this.config.settings.executionMode, flow: Boolean(this.config.settings.flowId) || this.agentFlow(),
            loading: this.loading, locked: this.config.settings.executionModeLocked, remote: this.config.agentId.startsWith('remote:') });
    }

    private syncUIFromConfig(): void {
        if (this.textarea) {
            if (this.textarea.value !== this.config.text) {this.textarea.value = this.config.text; this.getDraftRevision();}
            this.adjustTextareaHeight();
        }
        this.syncExecutionMode();
        if (this.agentPickerBtn) this.updateAgentTrigger();
        this.connectionTier.setSelection(this.config.settings.connectionId, this.config.settings.modelTier ?? 'auto');
        if (this.flowIdInput) this.flowIdInput.value = this.config.settings.flowId ?? '';
        if (this.branchModeSelect) this.branchModeSelect.value = this.config.settings.branchMode ?? 'continue';
        if (this.retentionModeSelect) this.retentionModeSelect.value = this.config.settings.retentionMode ?? 'persistent';
        if (this.historySlider) {
            this.historySlider.value = (this.config.settings.historyLength ?? -1).toString();
            this.updateHistoryDisplay();
            this.updatePresetButtons();
        }
        if (this.streamToggle) {
            // Block Mode toggle is inverted: checked = block mode = streaming disabled
            this.streamToggle.checked = !(this.config.settings.streamMode ?? true);
            this.updateStreamToggleLabel();
        }
        // Sync thinking toggle and reasoning effort from persisted settings.
        const thinkingToggle = this.container.querySelector('.llm-input__thinking-toggle') as HTMLInputElement | null;
        const reasoningRow = this.container.querySelector('.llm-input__reasoning-wrapper') as HTMLElement | null;
        const reasoningSelect = this.container.querySelector('.llm-input__reasoning-select') as HTMLSelectElement | null;
        if (thinkingToggle) {
            thinkingToggle.checked = this.config.settings.thinkingEnabled ?? true;
            if (reasoningRow) reasoningRow.style.display = thinkingToggle.checked ? '' : 'none';
        }
        if (reasoningSelect && this.config.settings.reasoningEffort) {
            reasoningSelect.value = this.config.settings.reasoningEffort;
        }
        const webSearchToggle = this.container.querySelector('.llm-input__websearch-toggle') as HTMLInputElement | null;
        if (webSearchToggle) {
            webSearchToggle.checked = this.config.settings.webSearchEnabled ?? true;
        }
        this.syncWebSearchUI(this.config.settings.webSearchEnabled ?? true);
        if (this.systemPromptAppendInput) {
            this.systemPromptAppendInput.value = this.config.settings.systemPromptAppend ?? '';
        }
        this.updateActiveBadges();
        this.refreshConnectionStatus();
    }

    private syncConfigFromUI(): void {
        this.config.text = this.textarea?.value || '';
        this.config.agentId = this.currentAgentId;
        this.config.settings.connectionId = this.connectionTier.getConnectionId();
        // modelTier is kept in-memory; pills don't have a native value to read
        this.config.settings.historyLength = parseInt(this.historySlider?.value || '-1');
        this.config.settings.streamMode = !(this.streamToggle?.checked ?? false);
        this.config.settings.systemPromptAppend = this.systemPromptAppendInput?.value.trim() || undefined;
    }

    /** 同步联网搜索状态到工具栏快速开关（高亮）与设置面板 toggle。 */
    private syncWebSearchUI(active: boolean): void {
        if (this.webSearchQuickBtn) {
            this.webSearchQuickBtn.dataset.active = String(active);
            this.webSearchQuickBtn.setAttribute('aria-pressed', String(active));
        }
        const panelToggle = this.container.querySelector('.llm-input__websearch-toggle') as HTMLInputElement | null;
        if (panelToggle) panelToggle.checked = active;
    }

    private adjustTextareaHeight(): void {
        this.textarea.style.height = 'auto';
        const style = getComputedStyle(this.textarea), lineHeight = parseFloat(style.lineHeight) || 24;
        const minHeight = parseFloat(style.minHeight) || lineHeight * 2 + 8;
        const maxHeight = parseFloat(style.maxHeight) || 200;
        const newHeight = Math.max(minHeight, Math.min(this.textarea.scrollHeight, maxHeight));
        this.textarea.style.height = `${newHeight}px`;
    }

    // ================================================================
    // 设置面板
    // ================================================================

    private toggleSettings(show?: boolean): void {
        this.settingsExpanded = show ?? !this.settingsExpanded;
        this.settingsPanel.style.display = this.settingsExpanded ? 'block' : 'none';
        this.settingsBtn.classList.toggle('active', this.settingsExpanded);

        if (this.settingsExpanded) {
            void this.ocrSettings?.refresh();
            this.settingsPanel.classList.add('llm-input__settings-panel--entering');
            requestAnimationFrame(() => {
                this.settingsPanel.classList.remove('llm-input__settings-panel--entering');
            });

        }
    }

    private clearSetting(type: 'history' | 'stream'): void {
        switch (type) {
            case 'history':
                this.historySlider.value = '-1';
                this.config.settings.historyLength = -1;
                this.updateHistoryDisplay();
                this.updatePresetButtons();
                break;
            case 'stream':
                this.streamToggle.checked = false; // uncheck = streaming (not block mode)
                this.config.settings.streamMode = true;
                this.updateStreamToggleLabel();
                break;
        }
        this.updateActiveBadges();
        this.notifyConfigChange();
    }

    private updateHistoryDisplay(): void {
        if (!this.historyValue) return; // element removed in new template; presets show state
        const value = this.config.settings.historyLength;
        if (value === -1) this.historyValue.textContent = 'Unlimited';
        else if (value === 0) this.historyValue.textContent = 'None';
        else this.historyValue.textContent = `${value} messages`;
    }

    private updatePresetButtons(): void {
        const value = this.config.settings.historyLength;
        this.container.querySelectorAll('.llm-input__preset-btn').forEach(btn => {
            const btnValue = parseInt((btn as HTMLElement).dataset.history || '-1');
            btn.classList.toggle('active', btnValue === value);
        });
    }

    private updateStreamToggleLabel(): void {
        const label = this.container.querySelector('.llm-input__toggle-label');
        if (label) label.textContent = this.config.settings.streamMode ? 'Enabled' : 'Disabled';
    }

    private closeToolbarMenus(): void {
        for (const menu of this.container.querySelectorAll<HTMLDetailsElement>('.llm-input__toolbar details[open]')) menu.open = false;
    }

    private bindToolbarMenus(): void {
        const toolbar = this.container.querySelector('.llm-input__toolbar')!;
        toolbar.addEventListener('keydown', event => {
            const key = event as KeyboardEvent;
            const menu = (key.target as Element).closest<HTMLDetailsElement>('details[open]');
            if (key.key !== 'Escape' || !menu) return;
            key.preventDefault();
            menu.open = false;
            menu.querySelector('summary')?.focus();
        });
        for (const menu of toolbar.querySelectorAll<HTMLDetailsElement>('details')) {
            menu.addEventListener('toggle', () => {
                if (!menu.open) return;
                for (const other of toolbar.querySelectorAll<HTMLDetailsElement>('details[open]')) {
                    if (other !== menu) other.open = false;
                }
                this.connectionTier.hidePopups();
                this.agentPopup?.hide();
                this.promptPopup?.hide();
            });
        }
    }

    // ── Help panel ────────────────────────────────────────────────────────────

    /**
     * 显示内嵌帮助面板。
     *
     * 帮助内容根据当前配置动态生成：
     * - 基础分区：键盘快捷键、slash 命令列表
     * - @mention 分区：当 onRequestFiles 回调已注入时显示
     */
    showHelp(): void {
        this.helpPanel.show();
    }

    private hideHelp(): void {
        this.helpPanel.hide();
    }

    private toggleHelp(): void {
        this.helpPanel.toggle();
    }

    // ── Skill management ─────────────────────────────────────────────────────

    /**
     * 刷新 Skill 列表（由 Shell 注入 skills 数据或内部主动拉取）。
     *
     * Shell 在 kernel 可用时调用此方法传入最新 skill 列表；
     * 也可在用户点击 Refresh 按钮时由内部调用 onRequestSkills 回调。
     */
    refreshSkills(skills: SkillInfo[]): void {
        this.skillPanel?.refresh(skills);
    }

    /** The explicit /skills command opens a separate manager. */
    showSkillSettings(): void {
        if (this.skillModal) return;
        this.toggleSettings(false);
        const id = 'skills-' + randomUUID();
        const modal = new Modal(t('chatSettings.skills'), `<div id="${id}">${ChatInputTemplates.renderSkillsSetting()}</div>`, {
            onCancel: () => { if (this.skillModal === modal) { this.skillModal = undefined; this.skillPanel = undefined; } },
        });
        this.skillModal = modal; modal.show();
        this.skillPanel = new SkillPanel(document.getElementById(id)!, {
            onConfigureCapabilities: this.options.onConfigureCapabilities ? () => { modal.hide(); this.options.onConfigureCapabilities?.(); } : undefined,
            onRequestSkills: this.options.onRequestSkills,
            onLoadSkill: this.options.onLoadSkill, onUnloadSkill: this.options.onUnloadSkill,
        });
        void this.skillPanel.reload();
    }

    private updateActiveBadges(): void {
        const activeContainer = this.container.querySelector('.llm-input__active-settings') as HTMLElement;
        const streamBadge = this.container.querySelector<HTMLElement>('.llm-input__active-badge[data-type="stream"]');
        const historyBadge = this.container.querySelector<HTMLElement>('.llm-input__active-badge[data-type="history"]');
        if (!activeContainer) return;
        let hasActive = false;

        if (!this.config.settings.streamMode) {
            if (streamBadge) streamBadge.style.display = 'inline-flex';
            hasActive = true;
        } else if (streamBadge) { streamBadge.style.display = 'none'; }

        if (this.config.settings.historyLength !== -1) {
            const text = historyBadge?.querySelector('.llm-input__badge-text');
            if (text) {
                text.textContent = this.config.settings.historyLength === 0
                    ? t('chatSettings.fresh') : t('chatInput.historyCount', { count: this.config.settings.historyLength ?? -1 });
            }
            if (historyBadge) historyBadge.style.display = 'inline-flex';
            hasActive = true;
        } else if (historyBadge) { historyBadge.style.display = 'none'; }

        activeContainer.style.display = hasActive ? 'flex' : 'none';
        this.settingsBtn.classList.toggle('has-overrides', hasActive);
    }

    private notifyConfigChange(): void {
        if (this.restoringRecovery) return;
        this.imageSettings?.refresh(); this.attachmentMgr?.images.refresh();
        const config = this.getConfig();
        this.options.onDraftChange?.(config, [...this.files]);
        const settingsJson = JSON.stringify({ agentId: config.agentId, settings: config.settings });
        if (settingsJson === this.lastNotifiedSettings) return;
        this.lastNotifiedSettings = settingsJson;
        this.options.onConfigChange?.(config);
    }

    // ================================================================
    // 执行器/模型 UI
    // ================================================================

    private initExecutors(): void {
        const agents = this.options.initialAgents?.length
            ? this.options.initialAgents
            : [{ id: 'default', name: 'Assistant', category: 'System' }];
        this.updateExecutors(agents);
    }

    private updateExecutors(executors: ExecutorOption[]): void {
        this.agents = executors;
        this.updateAgentTrigger();
    }

    // ── Agent Picker methods ──────────────────────────────────────────────────

    private getOrCreateAgentPopup(): PopupPanel {
        if (!this.agentPopup) {
            this.agentPopup = new PopupPanel(this.agentPickerBtn, {
                showSearch: true,
                searchPlaceholder: t('chatInput.searchAssistants'),
                emptyText: t('chatInput.noAssistants'),
                animated: true,
            });
        }
        return this.agentPopup;
    }

    private openAgentPicker(): void {
        this.connectionTier.hidePopups();
        const popup = this.getOrCreateAgentPopup();
        popup.show(this.buildAgentItems(), {
            onSelect: (item) => this.selectAgent(item.id),
        });
    }

    private toggleAgentPicker(): void {
        const popup = this.getOrCreateAgentPopup();
        if (popup.isVisible) popup.hide();
        else this.openAgentPicker();
    }

    /** Convert agents list to PopupItem[] for the picker. */
    private buildAgentItems(): PopupItem[] {
        const categories = [...new Set(this.agents.map(agent => agent.category))];
        const ordered = [...this.agents].sort((a, b) => categories.indexOf(a.category) - categories.indexOf(b.category)
            || (this.options.executorUsage?.lastUsed(b.id) ?? 0) - (this.options.executorUsage?.lastUsed(a.id) ?? 0));
        return ordered.map(a => {
            return {
                id: a.id,
                label: a.name,
                icon: a.icon ?? ENTITY_ICONS.agent,
                description: agentUnavailableReason(a) ?? a.description,
                disabled: a.availability?.status === 'disabled',
                group: a.category,
                searchText: a.category,
            };
        });
    }

    /** Select an agent from the picker. */
    private selectAgent(id: string): void {
        if (agentUnavailableReason(this.agents.find(agent => agent.id === id))) return;
        this.flowPreparation?.abort();
        this.config.agentId = id;
        this.currentAgentId = id;
        this.updateAgentTrigger();
        this.options.onExecutorChange?.(id);
        this.notifyConfigChange();
    }

    /** Update trigger button text/icon/meta from current agentId. */
    private updateAgentTrigger(): void {
        const agent = this.agents.find(a => a.id === this.config.agentId);
        if (!this.agentNameEl) return;
        if (agent) {
            this.agentIconEl.textContent = agent.icon ?? ENTITY_ICONS.agent;
            this.agentNameEl.textContent = agent.name;
            const meta = agent.category ?? '';
            this.agentMetaEl.textContent = meta;
            this.agentMetaEl.style.display = meta ? '' : 'none';
        } else {
            this.agentIconEl.textContent = ENTITY_ICONS.agent;
            this.agentNameEl.textContent = t('flow.history.assistant');
            this.agentMetaEl.textContent = '';
            this.agentMetaEl.style.display = 'none';
        }
        this.updatePromptPickerVisibility(); this.syncExecutionMode(); this.updateAgentNotice();
    }

    private updateAgentNotice(): void {
        if (!this.agentNotice) {
            this.agentNotice = document.createElement('p'); this.agentNotice.dataset.agentUnavailable = '';
            this.agentNotice.className = 'llm-input__connection-notice'; this.agentNotice.setAttribute('role', 'status');
            this.container.querySelector('.llm-input__connection-notice')?.after(this.agentNotice);
        }
        const reason = agentUnavailableReason(this.selectedExecutor());
        this.agentNotice.textContent = reason ?? ''; this.agentNotice.hidden = !reason;
        if (reason) this.flowPreparation?.abort();
        this.applyAvailability();
    }

    // ── Prompt Picker methods ─────────────────────────────────────────────────

    /** Current agent's preset prompts (empty when none configured). */
    private getCurrentPrompts(): import('@itookit/llm-tasks/contracts').PromptPreset[] {
        const agent = this.agents.find(a => a.id === this.config.agentId);
        return agent?.defaultPrompts ?? [];
    }

    /** Show/hide the prompt picker pill based on whether the agent has presets. */
    private updatePromptPickerVisibility(): void {
        if (!this.promptPickerWrapper) return;
        const hasPrompts = this.getCurrentPrompts().length > 0;
        this.promptPickerWrapper.style.display = hasPrompts ? '' : 'none';
        if (!hasPrompts) this.promptPopup?.hide();
    }

    private getOrCreatePromptPopup(): PopupPanel {
        if (!this.promptPopup) {
            this.promptPopup = new PopupPanel(this.container.querySelector('.llm-input__options > summary')!, {
                maxVisible: 12,
                showSearch: true,
                searchPlaceholder: 'Search prompts...',
                emptyText: 'No preset prompts',
                animated: true,
            });
        }
        return this.promptPopup;
    }

    private openPromptPicker(): void {
        this.agentPopup?.hide();
        this.connectionTier.hidePopups();
        const popup = this.getOrCreatePromptPopup();
        popup.show(this.buildPromptItems(), {
            onSelect: (item) => this.selectPrompt(parseInt(item.id, 10)),
        });
    }

    private togglePromptPicker(): void {
        const popup = this.getOrCreatePromptPopup();
        if (popup.isVisible) popup.hide();
        else this.openPromptPicker();
    }

    /** Convert preset prompts to PopupItem[] (id = index). */
    private buildPromptItems(): PopupItem[] {
        return this.getCurrentPrompts().map((p, i) => ({
            id: String(i),
            label: p.name || `Prompt ${i + 1}`,
            icon: CHAT_ICONS.edit,
            description: p.prompt.replace(/\s+/g, ' ').slice(0, 60),
            searchText: `${p.name} ${p.prompt}`,
        }));
    }

    /** Insert the selected preset prompt into the textarea at the cursor. */
    private selectPrompt(index: number): void {
        const prompt = this.getCurrentPrompts()[index]?.prompt;
        if (!prompt) return;
        this.pluginCtx?.insertAtCursor(prompt);
        this.config.text = this.textarea.value;
        this.notifyConfigChange();
        this.textarea.focus();
    }


private inputAvailable(): boolean {
        return this.availability.canSend || this.canQuery() || this.independentQueryAvailable();
    }
private independentQueryAvailable(): boolean {return !!this.availability.canQueryCommand?.(this.textarea.value);}
private canQuery(): boolean {return !!this.availability.canCommand && isCommandInput(this.textarea.value);}
}
