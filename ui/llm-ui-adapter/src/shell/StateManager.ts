import type { SessionViewPort } from '@itookit/llm-session/contracts';
// @file: llm-ui/shell/StateManager.ts

import type { UIState, CollapseStateMap } from '../domain/types';
import type { IChatInputPresenter, IChatInputConfig, ChatInputSettings } from '../domain/ports/IChatInputPresenter';
import { fromConversationState, type StateService } from '../services/StateService';
import type { ConversationManifest } from '@itookit/llm-session/contracts';
import { createDebouncedSave, DebouncedFn } from '../utils/debounce';
import { ErrorHandler } from '../utils/errorHandler';
/**
 * 状态管理器
 *
 * 面向 IChatInputPresenter 接口，不依赖 ChatInput 实现
 * 支持新版 NavigationRequest.state 协议读取创建参数
 */
export class StateManager {
    private collapseStatesCache: CollapseStateMap = {};
    private debouncedUIStateSave: DebouncedFn;
    private debouncedInputStateSave: DebouncedFn;
    private chatInputGetter: (() => IChatInputPresenter | undefined) | null = null;
    private errorHandler: ErrorHandler;
    private branch = 'main';
    private draftTail: Promise<void> = Promise.resolve();
    private draftGeneration = 0;
    private saveTail: Promise<void> = Promise.resolve();
    private savedConfiguration?: string;

    constructor(
        private stateService: StateService,
        private sessionManager: Pick<SessionViewPort, 'isGenerating'>,
        private sessionId: string,
        private readonly validateAgentFn: (id: string) => string,
        initialBranch = 'main'
    ) {
        this.branch = initialBranch;
        this.errorHandler = new ErrorHandler({
            module: 'StateManager',
            defaultSeverity: 'silent',
        });

        const notGenerating = () => !this.sessionManager.isGenerating();

        this.debouncedUIStateSave = createDebouncedSave(
            () => this.saveUIState().catch(error => this.errorHandler.handle(error, 'Save UI state', 'warn')),
            2000,
            notGenerating
        );

        this.debouncedInputStateSave = createDebouncedSave(
            () => this.saveUIState(this.chatInputGetter?.()?.getConfig()).catch(error => this.errorHandler.handle(error, 'Save input draft', 'warn')),
            1000,
            notGenerating
        );
    }

    setChatInputGetter(getter: () => IChatInputPresenter | undefined): void {
        this.chatInputGetter = getter;
    }


    switchDraftBranch(branch: string): Promise<void> {
        const generation = ++this.draftGeneration;
        this.chatInputGetter?.()?.setLoading(true);
        const operation = this.draftTail.then(async () => {
            if (branch === this.branch) return;
            const input = this.chatInputGetter?.();
            await this.saveUIState(input?.getConfig());
            this.branch = branch;
            const state = await this.loadUIState();
            input?.restoreInput(state?.input_text ?? '', state?.input_agent_id);
        });
        this.draftTail = operation.catch(() => {});
        return operation.finally(() => { if (generation === this.draftGeneration) this.chatInputGetter?.()?.setLoading(this.sessionManager.isGenerating()); });
    }

    async waitForDrafts(): Promise<void> { await this.draftTail; await this.saveTail; }

    getCollapseStates(): CollapseStateMap { return this.collapseStatesCache; }

    setCollapseStates(states: CollapseStateMap): void {
        this.collapseStatesCache = states;
    }

    scheduleUIStateSave(states: CollapseStateMap): void {
        this.collapseStatesCache = states;
        this.debouncedUIStateSave();
    }

    scheduleInputStateSave(): void {
        this.debouncedInputStateSave();
    }

    /**
     * 改动：接受 IChatInputConfig 而非 ChatInput 实例
     */
    async saveUIState(
        inputConfig?: IChatInputConfig,
        isBeingDeleted: boolean = false
    ): Promise<void> {
        if (isBeingDeleted || !this.sessionId) return;

        const payload = this.inputState(inputConfig);
        const branch = this.branch;
        await this.enqueueSave(() => this.stateService.saveUIState(this.sessionId, payload, branch));
    }

    /** Capture identity, branch and settings before any asynchronous work. */
    saveInputConfiguration(config: IChatInputConfig): Promise<void> {
        this.debouncedInputStateSave.cancel();
        const payload = this.inputState(config);
        const settings = structuredClone(config.settings);
        const branch = this.branch;
        const fingerprint = JSON.stringify({ payload, settings, branch });
        return this.enqueueSave(async () => {
            if (fingerprint === this.savedConfiguration) return;
            await this.stateService.saveSessionSettings(this.sessionId, settings);
            await this.stateService.saveUIState(this.sessionId, payload, branch);
            this.savedConfiguration = fingerprint;
        });
    }

    /** Loaded preferences are already saved; unchanged disposal must not overwrite newer writes. */
    rememberRestoredConfiguration(config: IChatInputConfig): void {
        this.savedConfiguration = JSON.stringify({ payload: this.inputState(config), settings: config.settings, branch: this.branch });
    }

    private inputState(config?: IChatInputConfig): UIState {
        return structuredClone({ collapse_states: this.collapseStatesCache, input_text: config?.text,
            input_agent_id: config?.agentId, history_visibility: 'visible' });
    }

    private enqueueSave(save: () => Promise<void>): Promise<void> {
        const operation = this.saveTail.then(save);
        this.saveTail = operation.catch(() => {});
        return operation;
    }

    async loadUIState(initial?: ConversationManifest): Promise<UIState | null> {
        if (initial) this.branch = initial.currentBranch;
        const result = initial ? (initial.uiState ? fromConversationState(initial.uiState, this.branch) : null)
            : await this.errorHandler.wrapWithFallback(
            () => this.stateService.loadUIState(this.sessionId, this.branch),
            null, 'Load UI state', 'silent'
        );

        this.collapseStatesCache = result?.collapse_states ?? {};
        return result;
    }

    /**
     * 恢复输入状态 — 面向 IChatInputPresenter 接口
     * 
     */
    restoreInputState(
        chatInput: IChatInputPresenter,
        options: {
            initialInputState?: { text?: string; agentId?: string };
            savedState?: UIState | null;
            sessionSettings?: ChatInputSettings;
        }
    ): void {
        const validate = (id: string) => this.validateAgentFn(id);
        // Navigation text overrides must not carry another Session's execution policy.
        chatInput.setConfig({ settings: { flowId: undefined, flowRevision: undefined, flowParameters: undefined,
            ...options.sessionSettings, executionModeLocked: options.sessionSettings?.executionModeLocked ?? false, executionMode: options.sessionSettings?.executionMode ?? 'chat' } });

        // 优先级 1：外部指定的初始状态
        if (options.initialInputState) {
            chatInput.setConfig({
                text: options.initialInputState.text || '',
                agentId: validate(options.initialInputState.agentId || 'default'),
            });
            return;
        }

        // 优先级 3：恢复已保存的状态（非新会话）
        if (options.savedState) {
            chatInput.setConfig({
                text: options.savedState.input_text || '',
                agentId: validate(options.savedState.input_agent_id || 'default'),
                settings: options.sessionSettings,
            });
            return;
        }

        // 兜底：保持现有 agentId，仅应用 settings
        if (options.sessionSettings) {
            const current = chatInput.getConfig();
            chatInput.setConfig({
                text: current.text,
                agentId: current.agentId,
                settings: options.sessionSettings,
            });
        }
    }

    cleanup(): void {
        this.debouncedUIStateSave.cancel();
        this.debouncedInputStateSave.cancel();
    }
}
