import type { SessionViewPort } from '@itookit/llm-session/contracts';
// @file: llm-ui/shell/StateManager.ts

import type { UIState, CollapseStateMap } from '../domain/types';
import type { IChatInputPresenter, IChatInputConfig, ChatInputSettings } from '../domain/ports/IChatInputPresenter';
import { fromConversationState, type StateService } from '../services/StateService';
import type { ConversationManifest } from '@itookit/llm-session/contracts';
import { createDebouncedSave, DebouncedFn } from '../utils/debounce';
import { ErrorHandler } from '../utils/errorHandler';
import {draftSettings} from '../domain/submission-draft';
import {canonicalJson} from '../utils/canonical-json';
import {draftFailure} from '../services/DraftPersistence';
import {DraftFilesCodec} from '../services/DraftFilesCodec';

interface PendingInput {config: IChatInputConfig; files?: File[]; branch: string; verify?: boolean; replaceId?: string; resolution?: number}
interface InputRestoreOptions {
    initialInputState?: {text?: string; agentId?: string}; savedState?: UIState | null; sessionSettings?: ChatInputSettings;
}
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
    private savedSettings?: string;
    private readonly pendingInputs = new Map<string, PendingInput>();
    private restoredFiles?: UIState['input_files'];
    private restoringInput = false;
    private resolutionGeneration = 0;
    cancelDraftResolution(): void {++this.resolutionGeneration;}

    constructor(
        private stateService: StateService,
        private sessionManager: Pick<SessionViewPort, 'isGenerating'>,
        private sessionId: string,
        private readonly validateAgentFn: (id: string) => string,
        initialBranch = 'main',
        private readonly fileDrafts?: DraftFilesCodec,
        private readonly draftChanged: () => void = () => {},
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
            () => this.flushStagedInput().catch(error => this.errorHandler.handle(error, 'Save input draft', 'warn')),
            1000,
        );
    }

    setChatInputGetter(getter: () => IChatInputPresenter | undefined): void {
        this.chatInputGetter = getter;
    }
    getDraftBranch(): string {return this.branch;}


    switchDraftBranch(branch: string): Promise<void> {
        const generation = ++this.draftGeneration; this.cancelDraftResolution();
        this.chatInputGetter?.()?.setLoading(true);
        const operation = this.draftTail.then(async () => {
            if (branch === this.branch) return;
            const input = this.chatInputGetter?.();
            await this.saveUIState(input?.getConfig());
            const state = await this.stateService.loadUIState(this.sessionId, branch);
            const files = await this.decodeFiles(state);
            this.restoringInput = true;
            try {
                this.branch = branch; this.collapseStatesCache = state?.collapse_states ?? {};
                input?.setDraftScope?.(branch);
                input?.restoreInput(state?.input_text ?? '', state?.input_agent_id);
                input?.setConfig({text: state?.input_text ?? '', target: state?.input_target, input: state?.input_arguments});
                input?.restoreDraftFiles?.(files, state?.input_token);
                this.draftChanged();
            } finally {this.restoringInput = false;}
        });
        this.draftTail = operation.catch(() => {});
        return operation.finally(() => { if (generation === this.draftGeneration) this.chatInputGetter?.()?.setLoading(this.sessionManager.isGenerating()); });
    }

    async waitForDrafts(): Promise<void> {await this.draftTail; await this.flushStagedInput(); await this.saveTail;}
    hasPendingInput(): boolean {return this.pendingInputs.size > 0;}

    getCollapseStates(): CollapseStateMap { return this.collapseStatesCache; }

    setCollapseStates(states: CollapseStateMap): void {
        this.collapseStatesCache = states;
    }

    scheduleUIStateSave(states: CollapseStateMap): void {
        this.collapseStatesCache = states;
        this.debouncedUIStateSave();
    }

    scheduleInputStateSave(): void {
        const input = this.chatInputGetter?.();
        if (input) this.stageInput(input.getConfig(), input.getDraftFiles?.());
    }
    stageInput(config: IChatInputConfig, files?: readonly File[]): void {
        if (this.restoringInput) return;
        const snapshot = this.captureInput(config, files);
        this.pendingInputs.set(snapshot.branch, snapshot); this.draftChanged(); this.debouncedInputStateSave();
    }
    private async flushStagedInput(): Promise<void> {
        this.debouncedInputStateSave.cancel();
        await Promise.all([...this.pendingInputs.values()].map(snapshot => this.persistInput(snapshot, false)));
    }

    /**
     * 改动：接受 IChatInputConfig 而非 ChatInput 实例
     */
    async saveUIState(
        inputConfig?: IChatInputConfig,
        isBeingDeleted: boolean = false
    ): Promise<void> {
        if (isBeingDeleted || !this.sessionId) return;

        if (inputConfig) {
            const snapshot = this.captureInput(inputConfig, this.chatInputGetter?.()?.getDraftFiles?.());
            this.pendingInputs.set(snapshot.branch, snapshot); return this.persistInput(snapshot, false);
        }
        const payload = this.inputState();
        const branch = this.branch;
        await this.enqueueSave(() => this.stateService.saveUIState(this.sessionId, payload, branch));
    }

    /** Capture identity, branch and settings before any asynchronous work. */
    saveInputConfiguration(config: IChatInputConfig, files?: readonly File[], verify = false): Promise<void> {
        if (this.restoringInput) return Promise.resolve();
        this.debouncedInputStateSave.cancel();
        const snapshot = {...this.captureInput(config, files ?? this.chatInputGetter?.()?.getDraftFiles?.()), verify};
        this.pendingInputs.set(snapshot.branch, snapshot); return this.persistInput(snapshot, true);
    }
    private captureInput(config: IChatInputConfig, files?: readonly File[]): PendingInput {
        return {config: structuredClone(config), files: files && [...files], branch: this.branch};
    }
    private persistInput(snapshot: PendingInput, saveSettings: boolean): Promise<void> {
        const {config, files, branch} = snapshot, payload = this.inputState(config), settings = structuredClone(config.settings ?? {});
        const prepared = this.prepareFiles(files);
        return this.enqueueSave(async () => {
            if (prepared) payload.input_files = await prepared;
            if (snapshot.resolution !== undefined && (snapshot.resolution !== this.resolutionGeneration || branch !== this.branch))
                throw draftFailure('DRAFT_RESOLUTION_CHANGED');
            const fingerprint = JSON.stringify({payload, settings, branch});
            if (snapshot.verify || snapshot.replaceId || fingerprint !== this.savedConfiguration) {
                if (snapshot.replaceId) await this.stateService.saveUIState(this.sessionId, payload, branch, snapshot.replaceId);
                else await this.stateService.saveUIState(this.sessionId, payload, branch);
                this.savedConfiguration = fingerprint;
            }
            const settingsKey = canonicalJson(draftSettings(settings));
            if (saveSettings && settingsKey !== this.savedSettings) {
                await this.stateService.saveSessionSettings(this.sessionId, settings); this.savedSettings = settingsKey;
            }
            if (this.pendingInputs.get(branch) === snapshot) {this.pendingInputs.delete(branch); this.draftChanged();}
        });
    }
    private prepareFiles(files?: readonly File[]): Promise<NonNullable<UIState['input_files']>> | undefined {
        if (files === undefined) return;
        const pending = (this.fileDrafts ?? new DraftFilesCodec()).encode(files);
        void pending.catch(() => {}); return pending;
    }
    private decodeFiles(state?: UIState | null): Promise<File[]> {
        if (!state?.input_files?.length) return Promise.resolve([]);
        return (this.fileDrafts ?? new DraftFilesCodec()).decode(state.input_files);
    }

    /** Loaded preferences are already saved; unchanged disposal must not overwrite newer writes. */
    rememberRestoredConfiguration(config: IChatInputConfig): void {
        const payload = this.inputState(config);
        if (this.fileDrafts) payload.input_files = this.restoredFiles ?? [];
        this.savedConfiguration = JSON.stringify({payload, settings: config.settings, branch: this.branch});
        this.savedSettings = canonicalJson(draftSettings(config.settings ?? {}));
    }

    private inputState(config?: IChatInputConfig): UIState {
        return structuredClone({ collapse_states: this.collapseStatesCache, input_text: config?.text,
            input_token: config?.draftToken,
            input_agent_id: config?.agentId, input_target: config?.target, input_arguments: config?.input, history_visibility: 'visible'});
    }

    async resolveDraftConflict(action: 'load' | 'replace'): Promise<void> {
        const branch = this.branch, conflict = this.stateService.getDraftConflict(this.sessionId, branch), input = this.chatInputGetter?.();
        if (!conflict || !input) return;
        const config = input.getConfig(), files = input.getDraftFiles?.(), token = config.draftToken, resolution = ++this.resolutionGeneration;
        this.debouncedInputStateSave.cancel(); await this.saveTail;
        if (resolution !== this.resolutionGeneration || this.branch !== branch || input.getConfig().draftToken !== token) throw draftFailure('DRAFT_RESOLUTION_CHANGED');
        if (action === 'replace') {
            const snapshot = {...this.captureInput(config, files), replaceId: conflict.id, resolution};
            this.pendingInputs.set(branch, snapshot);
            try {await this.persistInput(snapshot, true);}
            catch (error) {
                if (this.pendingInputs.get(branch) === snapshot) this.pendingInputs.set(branch, {config, files, branch});
                throw error;
            }
            return;
        }
        await this.loadConflictingDraft(input, config, branch, token, resolution);
    }
    private async loadConflictingDraft(input: IChatInputPresenter, config: IChatInputConfig, branch: string,
        token: string | undefined, resolution: number): Promise<void> {
        const candidate = await this.stateService.readDraftCandidate(this.sessionId, branch), restored = await this.decodeFiles(candidate.state);
        if (resolution !== this.resolutionGeneration || this.branch !== branch || input.getConfig().draftToken !== token) throw draftFailure('DRAFT_RESOLUTION_CHANGED');
        this.restoringInput = true;
        try {
            this.applyInputState(input, {savedState: candidate.state ?? {collapse_states: {}, input_text: ''}, sessionSettings: config.settings});
            input.restoreDraftFiles?.(restored, candidate.state?.input_token);
        } finally {this.restoringInput = false;}
        this.pendingInputs.delete(branch); this.restoredFiles = candidate.state?.input_files;
        this.stateService.observeDraft(this.sessionId, branch, candidate.raw);
        this.rememberRestoredConfiguration(input.getConfig()); this.draftChanged();
    }

    private enqueueSave(save: () => Promise<void>): Promise<void> {
        const operation = this.saveTail.then(save);
        this.saveTail = operation.catch(() => {});
        return operation;
    }

    async loadUIState(initial?: ConversationManifest, branch = initial?.currentBranch ?? this.branch): Promise<UIState | null> {
        const result = initial ? (initial.uiState ? fromConversationState(initial.uiState, branch) : null)
            : await this.stateService.loadUIState(this.sessionId, branch);
        if (initial) this.stateService.observeDraft?.(this.sessionId, branch, initial.uiState);
        this.branch = branch;
        this.restoredFiles = result?.input_files;
        this.collapseStatesCache = result?.collapse_states ?? {};
        return result;
    }

    /**
     * 恢复输入状态 — 面向 IChatInputPresenter 接口
     * 
     */
    async restoreInputState(
        chatInput: IChatInputPresenter,
        options: InputRestoreOptions,
    ): Promise<void> {
        const files = !options.initialInputState && options.savedState?.input_files?.length ? await this.decodeFiles(options.savedState) : [];
        this.restoringInput = true;
        try {
            this.applyInputState(chatInput, options);
            chatInput.restoreDraftFiles?.(files, options.initialInputState ? undefined : options.savedState?.input_token);
        } finally {this.restoringInput = false;}
    }

    private applyInputState(chatInput: IChatInputPresenter, options: InputRestoreOptions): void {
        chatInput.setDraftScope?.(this.branch);
        const validate = (id: string) => this.validateAgentFn(id);
        // Navigation text overrides must not carry another Session's execution policy.
        chatInput.setConfig({ settings: { flowId: undefined, flowRevision: undefined, flowParameters: undefined,
            ...options.sessionSettings, executionModeLocked: options.sessionSettings?.executionModeLocked ?? false, executionMode: options.sessionSettings?.executionMode ?? 'chat' } });

        // 优先级 1：外部指定的初始状态
        if (options.initialInputState) {
            chatInput.setConfig({
                text: options.initialInputState.text || '',
                agentId: validate(options.initialInputState.agentId || 'default'),
                target: undefined,
                input: undefined,
            });
            return;
        }

        // 优先级 3：恢复已保存的状态（非新会话）
        if (options.savedState) {
            chatInput.setConfig({
                text: options.savedState.input_text || '',
                agentId: validate(options.savedState.input_agent_id || 'default'),
                target: options.savedState.input_target,
                input: options.savedState.input_arguments,
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
        this.cancelDraftResolution();
        this.debouncedUIStateSave.cancel();
        this.debouncedInputStateSave.cancel();
    }
}
