import {flowInputAssets} from '../flows/input-assets';
import {prepareAgentFlow, prepareCallTarget} from '../flows/agent-flow';
import {createOperationLedger, type OperationLedger} from '@itookit/llm-ui';
import {DraftFilesCodec} from '../services/DraftFilesCodec';
import { updateCollapseAction } from '../components/history/HistoryToolbar';
import { disposeEditorResources } from './editor-disposal';
import { rememberTaskAttachment, restoreTaskAttachment } from './task-attachment-lifecycle';
import type { EditorTaskControlPlane } from '@itookit/durable-kernel/contracts';
import type { SessionViewPort } from '@itookit/llm-session/contracts';
import { acquireConnectionOptions } from './connection-options-cache';
import { rerunSession } from './rerun-session';
import { t } from '@itookit/common';
import { bindWorkspaceInput, type WorkspaceHandoff } from './drafts/workspace-handoff';
import { mountConversationSource } from './conversation-source';
import { openSessionFlowOutputs } from '../flows/session-output';
import { InvocationPanel } from '../flows/InvocationPanel';
import { InstructionQueuePanel } from '../components/InstructionQueuePanel';
import {WorkspaceSubmissionRecovery} from './WorkspaceSubmissionRecovery';
import { sessionMaterialHeader, mountSessionInputActions } from './session-material';
import { promptChildConversation } from '../flows/create-child';
import { invokeFlowText } from '../flows/invoke-flow';
import {rerunSessionFlow} from '../flows/rerun-flow';
import { promptFlowParameters } from '../components/FlowParameterForm';
// @file: llm-ui/shell/LLMWorkspaceEditor.ts

import { IEditor, EditorOptions, EditorHostContext, EditorEvent, EditorEventMap, EditorEventCallback, CollapseExpandResult, Toast } from '@itookit/ui-common';
import { EventBus } from '@itookit/vfs-core';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { EventEnvelope, InteractionRequest, JsonValue } from '@itookit/durable-kernel/contracts';

import { ISessionRepository, IAgentConfigService, type ConversationManifest, type SessionSnapshot, SessionCommand } from '@itookit/llm-session/contracts';

// Domain — 只依赖接口和类型
import type { IHistoryPresenter } from '../domain/ports/IHistoryPresenter';
import type { IChatInputConfig, IChatInputPresenter } from '../domain/ports/IChatInputPresenter';
import type { IStatusPresenter } from '../domain/ports/IStatusPresenter';
import type { IBranchPresenter } from '../domain/ports/IBranchPresenter';
import type { IEditorEventBus } from '../domain/events';
import type { IBranchStore } from '../domain/ports/IBranchStore';
import type { IPrivilegedCommandService } from '../domain/ports/IPrivilegedCommandService';

// Services
import { SessionService, StateService, AssetService, BranchStore, BranchService, NavDataBuilder, FileSearchService } from '../services';

// Commands
import type { CommandContext } from '../commands/CommandContext';
import { CommandRegistry } from '../commands/CommandRegistry';
import {
    SendMessageCommand, SwitchBranchByOffsetCommand,
    RegenerateCommand, DeleteMessageCommand, EditAndRetryCommand,
    SiblingSwitchCommand, CopyAllCommand, PrintCommand,
} from '../commands';
import { Command } from '../commands/Command';
import type { SkillInfo, UIState } from '../domain/types';

// Shell 内部
import { EditorEventBus } from './EditorEventBus';
import { SessionEventHandler } from './SessionEventHandler';
import { StateManager } from './StateManager';
import { EventBinder } from './EventBinder';
import { WorkspaceDirectoryMenu } from './WorkspaceDirectoryMenu';
import { NavigationHelper } from './NavigationHelper';
import { RunAttachmentController } from './RunAttachmentController';
import { readDirectCommandOutcome } from '../commands/direct-command';
import { inputInteraction } from './input-interaction';
import {
    buildExecutorOptions, validateAgentId,
} from './AgentProvider';
import { promptInterruptedRun } from './InterruptedRunPrompt';
import { bindSkillRefresh } from './skill-refresh';
import { measureSessionLoad, type SessionLoadMetrics } from './load-metrics';
import { buildSlashCallbacks } from './SlashCommandRouter';

// Infrastructure
import { TimerManager, DOMCache } from '../components/common';
import { ErrorHandler } from '../utils/errorHandler';

// Components — 仅在 init 中用于构造，之后通过接口引用
import { HistoryView } from '../components/HistoryView';

import { ChatInput } from '../components/input/ChatInputView';
import { BranchIndicatorView } from '../components/indicators/BranchIndicatorView';
import { StatusIndicatorView } from '../components/indicators/StatusIndicatorView';
import { LayoutTemplates } from '../components/templates/LayoutTemplates';

import { HistoryPlugin } from '../components/input/plugins/HistoryPlugin';
import { SlashCommandPlugin } from '../components/input/plugins/SlashCommandPlugin';
import { AssetManagerUI } from '@itookit/mdx-adapter';

interface InitialSessionData {
    session: Awaited<ReturnType<SessionService['loadSession']>>;
    settings: Awaited<ReturnType<SessionService['getSessionSettings']>> | undefined;
    savedUIState: UIState | null;
}


export interface LLMEditorOptions extends EditorOptions<import('@itookit/llm-flow/contracts').SessionSubmission, import('../services/SessionService').SessionLoadResult> {
    handoff?: WorkspaceHandoff;
    readTaskAttachment?: import('@itookit/durable-kernel/contracts').ReadTaskAttachment;
    configuration?: import('@itookit/kernel-adapters/contracts').ChatConfigurationView;
    sessionId: string;
    sessionRepository: ISessionRepository;
    sessionManager: SessionViewPort;
    defaultHarnessToolIds?: readonly string[];
    agentService: IAgentConfigService;
    initialInputState?: { text?: string; agentId?: string };
    /** Host-owned OCR capability and configuration. */
    ocr?: import('@itookit/ui-common').OcrControls;
    /**
     * Conversation command bus returned by initializeConversationSystem().
     * 所有高层操作通过 commands.execute('session.*') / 'vcs.*' 调用。
     */
    commandBus?: ICommandBus;
    /** Host task control and restoration port. */
    kernel?: EditorTaskControlPlane;
    /** Application service for durable privileged slash commands. */
    privilegedCommands?: IPrivilegedCommandService;
    sessionSkills?: import('@itookit/tools/contracts').SessionSkillControls;
    onLoadMetrics?: (metrics: SessionLoadMetrics) => void;
}

/**
 * LLM 工作区编辑器 — Shell / Composition Root
 *
 * 职责边界：
 * ┌──────────────────────────────────┐
 * │  组装依赖图                       │
 * │  路由事件到 Command/View          │
 * │  IEditor 接口实现                 │
 * │  生命周期管理                     │
 * ├──────────────────────────────────┤
 * │  ❌ 直接操作 DOM                  │
 * │  ❌ 业务逻辑计算                  │
 * │  ❌ 知道 View 的内部实现          │
 * └──────────────────────────────────┘
 */
export class LLMWorkspaceEditor implements IEditor {
    private container!: HTMLElement;

    // === 面向接口的引用 ===
    private historyView!: IHistoryPresenter;
    private chatInput!: IChatInputPresenter;
    private branchIndicator!: IBranchPresenter;
    private statusIndicator!: IStatusPresenter;

    // === 委托的子模块 ===
    private navigation!: NavigationHelper;
    private directoryMenu?: WorkspaceDirectoryMenu;

    // === Services ===
    private sessionManager: SessionViewPort;
    private commandBus!: ICommandBus;
    private sessionService!: SessionService;
    private stateService!: StateService;
    private assetService!: AssetService;
    private stateManager!: StateManager;
    private errorHandler!: ErrorHandler;
    private branchStore!: IBranchStore;
    private branchService!: BranchService;
    private navDataBuilder!: NavDataBuilder;
    private assetManager?: AssetManagerUI;
    private fileSearchService!: FileSearchService;
    private runAttachment?: RunAttachmentController;
    private viewActive = true;
    private activationRevision = 0;
    private rerunAbort?: AbortController;
    private rerunPending = false;
    private flowOutputAbort?: AbortController;
    private invocationPanel?: InvocationPanel;
    private instructionQueuePanel?: InstructionQueuePanel;
    private invocationAbort = new AbortController();
    private invocationPending?: Promise<boolean>;
    private inputDialogKey?: string;
    private inputDialogAbort?: AbortController;
    private attachmentClosed = false;
    private destroyPromise?: Promise<void>;

    // === 事件系统 ===
    private bus!: IEditorEventBus;
    private commandRegistry!: CommandRegistry;
    private eventBinder!: EventBinder;
    private refreshPending = false;
    private sessionEventHandler!: SessionEventHandler;

    // === 命令实例 ===
    private sendCommand!: SendMessageCommand;
    private operations?: OperationLedger;
    private submissionRecovery?: WorkspaceSubmissionRecovery;
    private switchBranchByOffsetCommand!: SwitchBranchByOffsetCommand;
    private nodeCommands = new Map<string, Command<any, any>>();

    // === 插件 ===
    private historyPlugin: HistoryPlugin | null = null;
    private slashPlugin: SlashCommandPlugin | null = null;

    // === 基础设施 ===
    private timers = new TimerManager();
    private domCache!: DOMCache;

    // === 状态 ===
    private editorEvents = new EventBus<EditorEventMap>();
    private globalEventUnsub: (() => void) | null = null;
    private sessionEventUnsub: (() => void) | null = null;
    private agentServiceUnsub: (() => void) | null = null;
    private skillRefreshBinding: ReturnType<typeof bindSkillRefresh> | null = null;
    /** Latest Session Skill list; the slash popup needs it synchronously for `/sk-<id>`. */
    private skillSnapshot: SkillInfo[] = [];
    private connectionOptions?: ReturnType<typeof acquireConnectionOptions>;
    private refreshAgentsTimer: ReturnType<typeof setTimeout> | null = null;
    private titleInput!: HTMLInputElement;
    private inputReceiver?: HTMLElement;
    private currentTitle: string = 'New Chat';
    private currentSessionId: string | null = null;
    private isBeingDeleted = false;
    private initPromise: Promise<void> | null = null;
    private initResolve: (() => void) | null = null;

    private initComplete = false;

    private options: LLMEditorOptions;

    private get engine(): ISessionRepository {
        return this.options.sessionRepository;
    }

    private get hostContext(): EditorHostContext | undefined {
        return this.options.hostContext;
    }

    private get agentService(): IAgentConfigService {
        return this.options.agentService;
    }

    constructor(_container: HTMLElement, options: LLMEditorOptions) {
        this.options = options;
        if (!options.sessionManager) throw new Error('Chat editor requires an injected session view');
        this.sessionManager = options.sessionManager;
        if (options.title) this.currentTitle = options.title;
    }

    // ================================================================
    // 初始化 — 组装依赖图
    // ================================================================

    async init(container: HTMLElement, _initialContent?: string): Promise<void> {
        const measurement = measureSessionLoad(this.options.sessionId, this.options.onLoadMetrics);
        this.container = container;
        this.container.classList.add('llm-ui-workspace');
        this.initComplete = false;
        this.initPromise = new Promise(resolve => { this.initResolve = resolve; });
        try {
            this.connectionOptions = acquireConnectionOptions(this.agentService, this.options.configuration);
            this.initLayout();
            this.initInfrastructure();
            this.initServices();
            measurement.mark('layout');

            // Bind the existing Session before rendering its settings.
            const session = await this.sessionService.loadSession(
                this.options.sessionId!, this.currentTitle, this.options.target?.kind === 'session' ? this.options.target.branch : undefined, this.options.initialData
            );
            this.options.initialData = undefined;
            measurement.mark('bindSession');

            this.currentSessionId = session.sessionId;
            const initial = await this.initComponents(session);
            measurement.mark('componentsAndSettings');
            this.branchStore.setBranches(Object.entries(session.manifest.branches).map(([name, headNodeId]) => ({
                name, headNodeId: headNodeId ?? '', isCurrent: name === session.manifest.currentBranch,
            })));
            this.initCommands();
            this.initEventHandler();
            this.bindEvents();
            const observed = this.sessionManager.getSnapshot?.();
            session.snapshot = observed?.sessionId === session.sessionId ? observed
                : await this.commandBus.execute(SessionCommand.GetSnapshot);
            await this.loadSession({ session, ...initial });
            measurement.mark('restoreAndRender');

            this.statusIndicator.cacheElements();
            measurement.mark('branches');

            this.initComplete = true;
            await this.recoverAcceptedDraft();
            this.chatInput.setAvailability?.({canSend: !this.options.readOnly, canInterrupt: !this.options.readOnly});
            this.submissionRecovery?.observe(this.sessionManager.getSnapshot?.().instructionQueue);
            this.options.handoff = undefined;
            this.emit('ready', undefined);
            this.initResolve?.();
            measurement.finish();
        } catch (error: unknown) {
            const code = typeof error === 'object' && error !== null && 'code' in error
                ? error.code
                : undefined;
            const message = error instanceof Error ? error.message : '';
            if (code === 'ABORTED' || message.includes('Bind cancelled')) {
                this.initResolve?.();
                return;
            }
            throw error;
        }
    }

    private initLayout(): void {
        this.options.handoff?.prepare();
        if (!this.options.handoff) this.container.innerHTML = LayoutTemplates.renderWorkspace(this.currentTitle);
        this.titleInput = this.container.querySelectorAll('#llm-title-input')[0] as HTMLInputElement;
        this.titleInput.readOnly = false;
        mountConversationSource(this.container, 'mindos');
        this.container.addEventListener('click', this.onWelcomePrompt);
    }

    private readonly onWelcomePrompt = (event: MouseEvent): void => {
        const button = (event.target as Element).closest<HTMLButtonElement>('.llm-ui-welcome__prompt');
        if (!button || !this.container.contains(button) || !this.chatInput) return;
        const current = this.chatInput.getConfig().text.trim();
        this.chatInput.restoreInput([current, button.dataset.prompt].filter(Boolean).join('\n'));
    };

    private initInfrastructure(): void {
        this.domCache = new DOMCache(this.container);
        this.bus = new EditorEventBus();
        this.errorHandler = new ErrorHandler({
            module: 'LLMWorkspaceEditor',
            defaultSeverity: 'toast',
            onRenderError: (err) => this.historyView?.renderError(err),
            onResetLoading: () => this.chatInput?.setLoading(this.sessionManager.isGenerating()),
        });
        // CommandBus comes from initializeConversationSystem, with a no-op fallback.
        this.commandBus = this.options.commandBus ?? {
            register: () => ({ dispose: () => {} }),
            execute: async (name) => { throw new Error(`CommandBus not provided; cannot execute: ${name}`); },
            list: () => [],
        };
    }

    private initServices(): void {
        this.sessionService = new SessionService(this.engine, this.commandBus);
        this.stateService = new StateService(this.engine);
        this.assetService = new AssetService(this.options.assets);
        this.stateManager = new StateManager(
            this.stateService, this.sessionManager, this.options.sessionId!,
            (id) => validateAgentId(this.agentService, id),
            this.options.target?.kind === 'session' ? this.options.target.branch : undefined,
            new DraftFilesCodec(this.assetService.draftFiles()),
            () => this.emit('change', undefined),
        );
        this.branchStore = new BranchStore(this.commandBus, this.errorHandler);
        this.branchService = new BranchService(this.commandBus, this.branchStore);
        this.navDataBuilder = new NavDataBuilder(this.commandBus);
        this.fileSearchService = new FileSearchService(this.options.files?.fs);
    }

    private async initComponents(session: InitialSessionData['session']): Promise<Omit<InitialSessionData, 'session'>> {
        const initialSettings = session.settings;
        const [initialAgents, savedUIState] = await Promise.all([
            buildExecutorOptions(this.agentService, this.options.remoteAgents, this.options.configuration?.getConfigurationSnapshot()),
            this.stateManager.loadUIState(session.manifest),
        ]);
        this.operations = createOperationLedger({initial: savedUIState?.operations,
            save: records => this.stateService.saveOperations(session.sessionId, records)});
        // Retire draft renderers before the new history owns children of the shared mount.
        this.options.handoff?.release();
        const historyEl = this.domCache.byId('llm-ui-history')!;
        const inputEl = this.domCache.byId('llm-ui-input')!;
        const historyView = new HistoryView(historyEl, {
            header: sessionMaterialHeader(session.manifest),
            onContentChange: (id: string, content: string, type: 'user' | 'node') =>
                this.handleContentChange(id, content, type),
            onNodeAction: (action: string, nodeId: string) =>
                this.handleNodeAction(action, nodeId),
            onCommitEdit: (id: string, content: string) =>
                this.handleCommitEdit(id, content),
            bus: this.bus,
            fs: this.options.files?.fs,
            assets: this.options.assets,
            initialCollapseStates: this.stateManager.getCollapseStates(),
            onScroll: () => this.navigation.updateActiveSessionHighlight(),
            onNavigateSettings: () => {
                this.hostContext?.navigate?.({ target: 'settings', resourceId: 'connections' });
            },

        });
        this.historyView = historyView;
        const calls = document.createElement('div'); inputEl.before(calls);
        this.invocationPanel = new InvocationPanel(this.commandBus, this.options.sessionId, calls,
            text => this.chatInput.restoreInput([this.chatInput.getConfig().text, text].filter(Boolean).join('\n\n')), {
                mountCard: (card, call) => historyView.mountInvocation(card, call.head ?? null),
                openChild: id => this.openInvocationChild(id),
            });
        const queue = document.createElement('section'); inputEl.before(queue);
        this.instructionQueuePanel = new InstructionQueuePanel(queue, this.commandBus, this.options.sessionId);
        this.instructionQueuePanel.setReadOnly(!!this.options.readOnly);
        this.instructionQueuePanel.update(session.snapshot.instructionQueue);

        // Create NavigationHelper now that historyView is available
        this.navigation = new NavigationHelper({
            workspace: this.container,
            domCache: this.domCache,
            commands: this.commandBus,
            historyView: this.historyView,
            bus: this.bus,
            branchStore: this.branchStore,
            navDataBuilder: this.navDataBuilder,
            timers: this.timers,
        });

        // BranchIndicator → IBranchPresenter
        this.branchIndicator = new BranchIndicatorView(
            this.domCache, this.bus as EditorEventBus, this.branchStore
        );

        // StatusIndicator → IStatusPresenter
        this.statusIndicator = new StatusIndicatorView(
            this.domCache, () => this.sessionManager.isGenerating(),
            (loading) => this.chatInput?.setLoading(loading)
        );

        const savedAgentId = savedUIState?.input_agent_id || 'default';
        const validAgentId = validateAgentId(this.agentService, savedAgentId);

        const inputOptions: import('../components/input/ChatInputView').ChatInputOptions = {
            instructionQueue: true,
            executionModeInfo: this.container.querySelector<HTMLElement>('.llm-workspace-titlebar__mode-info')!,
            executorUsage: this.options.executorUsage,
            nativeModels: this.options.remoteAgents?.models,
            onSwitchExecutionTarget: this.options.onStartConversationDraft ? async input => {
                await this.flushPendingSave(); await this.options.onStartConversationDraft!(input);
            } : undefined,
            onConfigureExecutor: this.hostContext?.navigate ? () => {
                const config = this.chatInput.getConfig();
                const flowId = config.target?.kind === 'flow' ? config.target.id : config.settings.flowId;
                void this.hostContext?.navigate?.(flowId
                    ? {target: 'flows', resourceId: flowId}
                    : {target: 'agents', resourceId: this.agentService.getAgentResourceId?.(config.agentId)});
            } : undefined,
            maxAgentExchanges: this.sessionManager.getDirectAgentPolicy?.().maxExchanges,
            ...(this.options.sessionSkills ? {
                onRequestSkills: async () => this.decorateSkillCapabilities(await this.options.sessionSkills!.list(this.options.sessionId)),
                onConfigureCapabilities: () => {
                    const config = this.chatInput.getConfig(), flowId = config.target?.kind === 'flow' ? config.target.id : config.settings.flowId;
                    if (flowId) { void this.hostContext?.navigate?.({ target: 'flows', resourceId: flowId }); return; }
                    const id = this.chatInput.getConfig().agentId || 'default';
                    void this.hostContext?.navigate?.({ target: 'agents', resourceId: this.agentService.getAgentResourceId?.(id) });
                },
                onLoadSkill: (id: string) => this.options.sessionSkills!.load(this.options.sessionId, id),
                onUnloadSkill: (id: string) => this.options.sessionSkills!.unload(this.options.sessionId, id),
            } : {}),
            onSend: (text, files, agentId, overrides, target) =>
                this.routeMessage({text, files, agentId, overrides, target})
                    // Direct commands reject on purpose (no fallback to chat): report the reason the
                    // command could not start instead of leaving an unhandled rejection.
                    .catch(error => { this.errorHandler.handle(error, 'Send message'); if (agentId.startsWith('remote:')) throw error; return false as const; }),
            onStop: () => this.commandBus.execute(SessionCommand.Abort).catch(error => this.errorHandler.handle(error, 'Stop execution')),
            initialAgents,
            initialConfig: {
                text: savedUIState?.input_text || '',
                agentId: validAgentId,
                target: savedUIState?.input_target,
                input: savedUIState?.input_arguments,
                settings: initialSettings,
            },
            onConfigChange: (config) => this.handleConfigChange(config),
            onDraftChange: (config, files) => {if (this.initComplete) this.stateManager.stageInput(config, files);},
            flushDraft: () => this.flushPendingSave(),
            onExecutorChange: () => { this.skillRefreshBinding?.refresh(); },
            onRequestConnections: () => this.connectionOptions!.read(),
            prepareAgentFlow: (agent, signal, draft) => prepareAgentFlow(this.commandBus, agent, signal, draft),
            requestCallTargets: () => this.commandBus.execute(SessionCommand.ListTargets),
            prepareCallTarget: (target, signal, draft) => prepareCallTarget(this.commandBus, target, signal, draft),

            // ── @mention file reference ───────────────────────────────────────
            onRequestFiles: async (query, options) => this.fileSearchService.search(query, options),

            // ── OCR (image → text) — only when a one-shot LLM service is injected ─
            ocr: this.options.ocr,

            // ── Settings navigation ──────────────────────────────────────────
            onNavigateSettings: ({ resourceId, anchor }) => {
                this.hostContext?.navigate?.({
                    target: 'settings',
                    resourceId,
                    ...(anchor ? { state: { anchor } } : {}),
                });
            },
        };
        this.chatInput = this.options.handoff ? bindWorkspaceInput(inputOptions, this.options.handoff) : new ChatInput(inputEl, inputOptions);
        this.chatInput.setAvailability?.({canSend: false, canInterrupt: false});

        this.inputReceiver = mountSessionInputActions(inputEl, session.manifest, async () => {
            try { await this.startFlowInvocation(''); }
            catch (error) { this.errorHandler.handle(error, 'Invoke flow'); }
        });
        this.registerInputPlugins();

        // 运行中索引更新：Skill 目录变化后重新拉取并刷新输入区（无轮询）
        if (this.options.sessionSkills) {
            this.skillRefreshBinding = bindSkillRefresh(
                this.options.sessionSkills,
                this.options.sessionId,
                (skills) => {
                    this.skillSnapshot = skills;
                    this.chatInput?.refreshSkills(this.decorateSkillCapabilities(skills));
                },
            );
        }

        this.stateManager.setChatInputGetter(() => this.chatInput);
        return { settings: initialSettings, savedUIState };
    }

    private initCommands(): void {
        const ctx = this.buildCommandContext();

        this.commandRegistry = new CommandRegistry(ctx, this.bus);
        this.commandRegistry.initialize();

        this.sendCommand = new SendMessageCommand(ctx);
        this.submissionRecovery = new WorkspaceSubmissionRecovery(this.domCache.byId('llm-ui-input')!, this.operations!, this.options.sessionId,
            id => this.reconcileSubmission(id),
            error => this.errorHandler.handle(error, 'Reconcile submission'));
        this.switchBranchByOffsetCommand = new SwitchBranchByOffsetCommand(ctx);

        this.nodeCommands = new Map<string, Command<any, any>>([
            ['regenerate', new RegenerateCommand(ctx)],
            ['delete', new DeleteMessageCommand(ctx)],
            ['edit-and-retry', new EditAndRetryCommand(ctx)],
        ]);

        this.bus.on('state:collapseChanged', ({ states }) => {
            this.stateManager.scheduleUIStateSave(states);
            this.updateCollapseButtonIcon();
        });
        this.bus.on('state:inputChanged', () =>
            this.stateManager.scheduleInputStateSave()
        );
    }

    private initEventHandler(): void {
        this.initRunAttachment();
        this.sessionEventHandler = new SessionEventHandler({
            commands: this.commandBus,
            historyView: this.historyView,
            bus: this.bus,
            branchIndicator: this.branchIndicator,
            statusIndicator: this.statusIndicator,
            chatInput: this.chatInput,
            branchStore: this.branchStore,
            getCurrentSessionId: () => this.currentSessionId,
            onExecutionTask: taskId => {
                if (!this.viewActive) return;
                void this.runAttachment?.attach(taskId).catch(error =>
                    Toast.error(error instanceof Error ? error.message : 'Unable to attach execution task'),
                );
            },
            onContentChanged: () => this.emit('change', undefined),
            onNavRefresh: () => this.navigation.pushNavData(),
        });
    }

    private initRunAttachment(): void {
        if (!this.options.kernel) return;
        this.runAttachment = new RunAttachmentController(this.options.kernel, {
            onEvent: event => this.handleRunEvent(event),
            onWaiting: condition => this.handleRunWaiting(condition),
            onDetached: () => {
                this.inputDialogAbort?.abort();
                this.chatInput.clearInteraction();
            },
            onError: error => Toast.error(error.message),
        });
        void this.restorePrivilegedTaskAttachment().catch(error => {
            const message = error instanceof Error ? error.message : 'Unable to restore attached task';
            Toast.error(message);
        });
    }

    private handleRunEvent(event: EventEnvelope): void {
        if (event.type === 'task.interaction.resolved') {
            const payload = event.payload as { interactionId?: string };
            if (payload.interactionId) this.chatInput.clearInteraction(payload.interactionId);
            void this.restorePrivilegedTaskAttachment().catch(error => Toast.error(String(error)));
        }
        if (['task.succeeded', 'task.failed', 'task.cancelled'].includes(event.type)) {
            this.chatInput.clearInteraction();
            this.inputDialogAbort?.abort();
            void this.showDirectCommandOutput();
        }
        if (event.type === 'task.succeeded') this.statusIndicator.update('completed');
        else if (event.type === 'task.failed' || event.type === 'task.cancelled') {
            this.statusIndicator.update(event.type === 'task.failed' ? 'failed' : 'idle');
        } else if (event.type === 'task.ready' || event.type === 'task.retry.scheduled') this.statusIndicator.update('queued');
        else if (event.type === 'task.started' || event.type === 'task.running') this.statusIndicator.update('running');
    }

    /**
     * Explicit shell input (`!` / `/exec`) has no conversation turn of its own: its stdout,
     * stderr and exit code belong in the inline output panel, and a failure must not stay
     * invisible. Other privileged tasks (`/plan`, flows) never enter this panel.
     */
    private async showDirectCommandOutput(): Promise<void> {
        try {
            const task = await this.runAttachment?.current();
            const outcome = task && readDirectCommandOutcome(task);
            if (!outcome) return;
            const fallback = outcome.status === 'cancelled' ? t('chatInput.command.cancelled') : t('chatInput.command.failed');
            this.chatInput.showToolOutput(outcome.command, outcome.output || fallback, outcome.success);
        } catch (error) {
            Toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    private handleRunWaiting(request: InteractionRequest<JsonValue>): void {
        if (this.showFlowInput(request)) return;
        const attachment = this.runAttachment, sessionId = this.currentSessionId;
        if (!attachment) return;
        const revision = attachment.revision;
        this.chatInput.showInteraction(inputInteraction(request, revision), async reply => {
            if (this.currentSessionId !== sessionId || this.runAttachment !== attachment || this.attachmentClosed) {
                throw new Error('Task attachment changed');
            }
            if (typeof reply === 'string') await attachment.respondInput(request.id, reply, revision);
            else await attachment.respondApproval(request.id, reply.approved, reply.note ?? '', revision);
        });
    }

    private showFlowInput(request: InteractionRequest<JsonValue>): boolean {
        const payload = request.payload;
        if (request.kind !== 'input' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
        const fields = payload.fields;
        const attachment = this.runAttachment;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !attachment) return false;
        this.chatInput.clearInteraction();
        const revision = attachment.revision, key = `${revision}:${request.id}`;
        if (this.inputDialogKey === key) return true;
        const values = payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values) ? payload.values : {};
        const parameters = Object.entries(fields).map(([name, field]) => ({
            ...(field as unknown as import('@itookit/llm-flow/contracts').FlowInputField), name,
            required: (field as unknown as import('@itookit/llm-flow/contracts').FlowInputField).required !== false,
            ...(Object.hasOwn(values, name) ? { default: values[name] } : {}),
        }));
        this.inputDialogAbort?.abort();
        this.inputDialogAbort = new AbortController();
        this.inputDialogKey = key;
        void promptFlowParameters(parameters, request.prompt, result => attachment.respondInput(request.id, result, revision), this.inputDialogAbort.signal, undefined, flowInputAssets(this.commandBus))
            .finally(() => { if (this.inputDialogKey === key) this.inputDialogKey = undefined; });
        return true;
    }

    private buildCommandContext(): CommandContext {
        return {
            getSessions: () => this.sessionManager.getSessions(),
            commands: this.commandBus,
            session: this.sessionManager,
            sessionService: this.sessionService,
            stateService: this.stateService,
            assetService: this.assetService,
            branchService: this.branchService,
            historyView: this.historyView,
            chatInput: this.chatInput,
            bus: this.bus,
            errorHandler: this.errorHandler,
            getSessionId: () => this.options.sessionId,
            getBranch: () => this.stateManager.getDraftBranch(),
            isGenerating: () => this.sessionManager.isGenerating(),
            executeDirectCommand: this.options.privilegedCommands ? command => this.startExec(command) : undefined,
            resolveSubmission: this.options.resolveSubmission,
            operations: this.operations,
            observeInstructions: listener => {
                const stop = this.sessionManager.onEvent(event => {
                    if (event.type === 'instructions:changed') listener(event.payload);
                });
                const queue = this.sessionManager.getSnapshot?.().instructionQueue;
                if (queue) listener(queue);
                return stop;
            },
            reconcileSubmission: request => this.commandBus.execute(SessionCommand.InspectSubmissionReceipt, request),
        };
    }

    // ================================================================
    // 事件绑定 — 纯路由，不含业务逻辑
    // ================================================================

    private bindEvents(): void {
        this.directoryMenu = new WorkspaceDirectoryMenu(this.container, this.hostContext?.directoryCommands,
            () => this.sessionManager.isGenerating());
        this.container.querySelector('#llm-btn-session-rerun')?.addEventListener('click', () => {
            void this.rerunSession().catch(error => Toast.error(String(error)));
        });
        this.container.querySelector('#llm-btn-flow-output')?.addEventListener('click', () => {
            if (!this.currentSessionId) return;
            this.rerunAbort?.abort();
            this.flowOutputAbort?.abort();
            this.flowOutputAbort = new AbortController();
            openSessionFlowOutputs(this.commandBus, this.currentSessionId, this.flowOutputAbort.signal);
        });
        this.eventBinder = new EventBinder(this.container, {
            mountCompactNavigation: this.options.mountCompactNavigation,
            mountMoreMenu: this.options.mountMoreMenu,
            mountConversationNavigation: this.options.mountConversationNavigation,
            onToggleSidebar: () => this.hostContext?.toggleSidebar(),
            onTitleChange: (title) => this.handleTitleChange(title),
            onOpenAssetManager: () => this.handleOpenAssetManager(),
            onToggleNavigator: () => this.navigation.toggleNavigator(this.container),
            onPrevUnfolded: () => this.navigation.navigateUnfolded('prev'),
            onNextUnfolded: () => this.navigation.navigateUnfolded('next'),
            onFoldCurrent: () => this.historyView.foldCurrentUnfolded(),
            onCollapseAll: () => this.handleToggleAllFold(),
            onCopy: () => this.handleCopy(),
            onPrint: () => this.handlePrint(),
            onRefresh: () => { void this.handleRefresh(); },
        });
        this.domCache.byId('llm-btn-sidebar')!.hidden = !this.hostContext?.toggleSidebar;

        this.eventBinder.bindTitleBarEvents();
        this.eventBinder.bindNavigationEvents();
        this.eventBinder.bindGlobalShortcuts({
            onToggleNavigator: () => this.navigation.toggleNavigator(this.container),
            onNavigatePrev: () => this.navigation.navigateToUserChat('prev'),
            onNavigateNext: () => this.navigation.navigateToUserChat('next'),
            onCreateBranch: () => {
                const id = this.navigation.findCurrentVisibleSession();
                if (id) this.bus.emit('branch:create', { sourceNodeId: id });
            },
            onSwitchBranchPrev: () => this.switchBranchByOffsetCommand.run({
                offset: -1, cachedBranches: this.branchStore.current,
            }),
            onSwitchBranchNext: () => this.switchBranchByOffsetCommand.run({
                offset: 1, cachedBranches: this.branchStore.current,
            }),
        });

        this.globalEventUnsub = this.sessionManager.onGlobalEvent(
            (event) => this.sessionEventHandler.handleGlobalEvent(event)
        );

        this.agentServiceUnsub = this.connectionOptions!.subscribe(() => {
            if (!this.viewActive) return;
            void this.chatInput.refreshConnections();
            if (this.refreshAgentsTimer) clearTimeout(this.refreshAgentsTimer);
            this.refreshAgentsTimer = setTimeout(() => {
                this.refreshAgentsTimer = null;
                this.refreshAgents();
                this.skillRefreshBinding?.refresh();
            }, 300);
        });
    }

    // ================================================================
    // 路由处理 — 薄委托，每个方法 < 10 行
    // ================================================================

    private handleNodeAction(action: string, nodeId: string): void {
        if (action === 'edit-arguments') {
            void this.rerunArguments(nodeId).catch(error => this.errorHandler.handle(error, 'Edit call arguments'));
            return;
        }
        if (action === 'prev-sibling' || action === 'next-sibling') {
            new SiblingSwitchCommand(this.buildCommandContext())
                .run({ nodeId, direction: action === 'prev-sibling' ? 'prev' : 'next' });
            return;
        }

        const cmd = this.nodeCommands.get(action);
        if (cmd) {
            cmd.run({ nodeId });
        } else {
            console.warn(`[Shell] Unknown node action: ${action}`);
        }
    }

    private async rerunArguments(nodeId: string): Promise<void> {
        const group = this.sessionManager.getSessions().find(item => item.id === nodeId);
        if (!group?.roundId || !group.callInput?.admitted) throw new Error(t('flow.rerun.unavailable'));
        this.rerunAbort?.abort(); const abort = this.rerunAbort = new AbortController();
        const context = await this.commandBus.execute<import('../flows/rerun-flow').FlowRerunContext>(SessionCommand.FlowRerunContext, {sourceRoundId: group.roundId});
        if (!this.viewActive || abort.signal.aborted || abort !== this.rerunAbort) return;
        await rerunSessionFlow(this.commandBus, abort.signal, context);
    }

    private handleContentChange(id: string, content: string, _type: 'user' | 'node'): void {
        this.commandBus.execute(SessionCommand.UpdateDraft, { messageId: id, newContent: content }).catch(() => {});
        this.emit('change', undefined);
    }

    private async handleCommitEdit(id: string, content: string): Promise<void> {
        await this.errorHandler.wrap(async () => {
            await this.commandBus.execute(SessionCommand.CommitEdit, { messageId: id, newContent: content, autoRerun: false });
            this.emit('change', undefined);
        }, 'Commit edit', 'warn');
    }

    private decorateSkillCapabilities(skills: SkillInfo[]): SkillInfo[] {
        if (this.chatInput?.getConfig().settings.flowId || this.chatInput?.getConfig().target?.kind === 'flow') return skills.map(skill => ({ ...skill, capabilitiesManagedByFlow: true }));
        const agentId = this.chatInput?.getConfig().agentId || 'default';
        const policy = this.agentService.findAgent(agentId)?.capabilityPolicy;
        const grants = new Set(policy?.toolIds ?? this.options.defaultHarnessToolIds ?? []);
        return skills.map(skill => ({ ...skill, authorizedToolCount: (skill.toolIds ?? []).filter(id => grants.has(id)).length }));
    }

    private async handleConfigChange(config: IChatInputConfig): Promise<void> {
        this.skillRefreshBinding?.refresh();
        if (!this.initComplete || !this.currentSessionId || this.isBeingDeleted) return;
        await this.errorHandler.wrap(
            () => this.stateManager.saveInputConfiguration(config),
            'Save input configuration', 'toast'
        );
    }

    private async handleTitleChange(title: string): Promise<void> {
        this.currentTitle = title;
        if (this.inputReceiver) this.inputReceiver.textContent = t('project.currentConversation', {name: title});
        this.emit('change', undefined);
        if (this.options.sessionId) {
            await this.errorHandler.wrap(
                () => this.sessionService.renameSession(this.options.sessionId!, title),
                'Rename session', 'warn'
            );
        }
    }

    private handleToggleAllFold(): void {
        const isNowCollapsed = this.historyView.toggleAllFold();
        this.bus.emit('state:collapseChanged', {
            states: (this.historyView as HistoryView).getCollapseStates(),
        });
        this.updateCollapseButtonIcon(isNowCollapsed);
    }

    private async handleRefresh(): Promise<void> {
        const sessionId = this.currentSessionId;
        if (!sessionId || this.refreshPending || this.attachmentClosed) return;
        this.refreshPending = true;
        const button = this.domCache.byId('llm-btn-refresh') as HTMLButtonElement | null;
        if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
        try {
            const snapshot = await this.commandBus.execute<SessionSnapshot>(SessionCommand.GetSnapshot);
            if (this.attachmentClosed || this.currentSessionId !== sessionId || snapshot.sessionId !== sessionId) return;
            this.historyView.renderFull(snapshot.sessions);
            this.statusIndicator.updateFromSnapshot(snapshot);
            await this.branchStore.refresh();
            if (!this.attachmentClosed && this.currentSessionId === sessionId) this.navigation.pushNavData();
        } catch (error) {
            if (!this.attachmentClosed) this.errorHandler.handle(error, 'Refresh conversation');
        } finally {
            this.refreshPending = false;
            if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        }
    }

    private async handleCopy(): Promise<void> {
        await new CopyAllCommand(this.buildCommandContext()).run();
        const btn = this.domCache.byId('llm-btn-copy');
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '<span style="color:#2da44e">✓</span>';
            this.timers.setTimeout(() => { btn.innerHTML = orig; }, 2000);
        }
    }

    private async handlePrint(): Promise<void> {
        if (!this.options.files?.fs) {
            Toast.error('File system is unavailable for printing');
            return;
        }
        await new PrintCommand(this.buildCommandContext()).run({
            title: this.currentTitle,
            engine: this.options.files?.fs,
            assets: this.options.assets,
        });
    }

    private async handleOpenAssetManager(): Promise<void> {
        await this.errorHandler.wrap(async () => {
            const ownerNodeId = this.options.sessionId;
            if (!this.options.files?.fs || !ownerNodeId) {
                throw new Error('Session file context is unavailable');
            }

            if (!this.options.assets) throw new Error('Session attachments unavailable');
            this.assetManager?.close();
            this.assetManager = new AssetManagerUI(this.options.assets, null, {});
            await this.assetManager.show('/');
        }, 'Open Asset Manager');
    }

    // ================================================================
    // 会话加载
    // ================================================================

    private async loadSession(initial?: InitialSessionData): Promise<void> {
        if (!this.options.sessionId) throw new Error('Session identity is required');
        if (!initial) await this.flushPendingSave();

        this.sessionEventUnsub?.();
        this.sessionEventUnsub = null;

        if (!initial) void this.refreshAgents().catch(error => this.errorHandler.handle(error, 'Refresh agents'));

        this.rerunAbort?.abort();
        this.flowOutputAbort?.abort();
        const { sessionId, snapshot, title, manifest, settings } = initial?.session ?? await this.sessionService.loadSession(
            this.options.sessionId!, this.currentTitle
        );

        if (snapshot.sessions.length > 0) {
            this.historyView.renderFull(snapshot.sessions);
        } else {
            this.historyView.renderWelcome();
        }
        this.navigation.updatePrompts(snapshot.sessions);
        this.instructionQueuePanel?.update(snapshot.instructionQueue);

        // Assign before prompting because the callback reads the active session.
        if (this.currentSessionId && this.currentSessionId !== sessionId) await this.runAttachment?.detach();
        this.currentSessionId = sessionId;
        this.currentTitle = title;
        if (this.inputReceiver) this.inputReceiver.textContent = t('project.currentConversation', {name: title});

        // Check if this session was interrupted (VFS meta.status === 'running')
        promptInterruptedRun(snapshot, (interruptedAssistantId) => {
            this.commandBus.execute(SessionCommand.Regenerate, { assistantId: interruptedAssistantId,
                options: { overrides: { executionMode: this.chatInput.getConfig().settings.executionMode ?? 'chat' } },
            }).catch(() => {
                Toast.info('重新执行失败，请手动重试');
            });
        });

        this.chatInput?.updateTokenStats?.(null);
        this.titleInput.value = title;

        const savedUIState = initial ? initial.savedUIState : await this.stateManager.loadUIState(manifest);

        const emptySession = snapshot.sessions.length === 0;
        const effectiveInitialInputState = this.options.initialInputState;

        const sessionSettings = initial ? initial.settings : settings;

        if (!this.options.handoff) await this.stateManager.restoreInputState(this.chatInput, {
            initialInputState: effectiveInitialInputState,
            savedState: savedUIState,
            sessionSettings,
        });
        else if (sessionSettings && (sessionSettings.executionModeLocked || sessionSettings.flowId)) {
            this.chatInput.setConfig({settings: {executionMode: sessionSettings.executionMode,
                executionModeLocked: sessionSettings.executionModeLocked, flowId: sessionSettings.flowId,
                flowRevision: sessionSettings.flowRevision, flowParameters: sessionSettings.flowParameters}});
        }
        if (!effectiveInitialInputState) this.stateManager.rememberRestoredConfiguration(this.chatInput.getConfig());

        // 恢复 workflow 实例来源（manifest.flow）→ 恢复参数；新实例则立即运行一次。
        let autoRunFlow: NonNullable<ConversationManifest['flow']> | undefined;
        try {
            const flow = manifest?.flow;
            if (flow && !this.chatInput.getConfig().target) {
                this.chatInput?.selectFlow(flow.flowId, flow.revision, flow.parameters);
                if (emptySession) autoRunFlow = flow;
            }
        } catch { /* manifest 不可读时忽略 */ }

        this.bindSessionEvents();

        this.statusIndicator.updateFromSnapshot(snapshot);

        // Preserve the initial execution behavior for empty Flow sessions.
        if (autoRunFlow) {
            void this.sendCommand.run({
                text: `${title}\n\n${JSON.stringify(autoRunFlow.parameters ?? {}, null, 2)}`,
                files: [],
                agentId: 'default',
                overrides: {
                    flowId: autoRunFlow.flowId,
                    flowRevision: autoRunFlow.revision,
                    flowParameters: autoRunFlow.parameters,
                    ...(autoRunFlow.connectionId ? { connectionId: autoRunFlow.connectionId } : {}),
                },
            });
        }
    }

    private bindSessionEvents(): void {
        this.sessionEventUnsub?.();
        this.sessionEventUnsub = this.sessionManager.onEvent(
            (event) => {
                if (event.type === 'instructions:changed') {
                    this.instructionQueuePanel?.update(event.payload);
                    if (this.initComplete) this.submissionRecovery?.observe(event.payload);
                }
                if (event.type === 'branch:switched') void this.stateManager.switchDraftBranch(event.payload.branchName).catch(error => console.error('Branch draft switch failed', error));
                this.sessionEventHandler.handleSessionEvent(event);
            }
        );
    }

    // ================================================================
    // Agent / Connection 辅助 → 委托到 AgentProvider
    // ================================================================

    private async routeMessage(message: import('../commands/SendMessageCommand').SendMessageParams): Promise<void | false> {
        if (message.target || !message.agentId?.startsWith('remote:')) return await this.sendCommand.run(message) ? undefined : false;
        if (message.files.length) throw new Error(t('harness.remoteAttachments'));
        if (!this.options.remoteAgents) throw new Error(t('toolbox.unavailable'));
        try { await this.options.remoteAgents.send(message.agentId, message.text, this.chatInput.getNativeModelSelection?.()); }
        catch (error) { this.chatInput?.restoreInput(message.text, message.agentId); throw error; }
    }
    private async refreshAgents(): Promise<void> {
        if (!this.chatInput) return;
        const agents = await buildExecutorOptions(this.agentService, this.options.remoteAgents, this.options.configuration?.getConfigurationSnapshot());
        const changed = this.chatInput.refreshAgents(
            agents,
            (id) => agents.some(a => a.id === id) ? id : 'default'
        );
        await this.chatInput.refreshConnections();
        await this.chatInput.refreshCallTargets?.();
        if (changed) {
            this.bus.emit('state:inputChanged', {});
        }
    }

    // ================================================================
    // UI 辅助
    // ================================================================

    private updateCollapseButtonIcon(isAllCollapsed?: boolean): void {
        const collapseBtn = this.domCache.byId('llm-btn-collapse');
        if (!collapseBtn) return;

        const showExpand = isAllCollapsed ?? !this.historyView.shouldShowCollapseIcon();
        updateCollapseAction(collapseBtn, showExpand);
    }

    // ================================================================
    // IEditor 接口实现
    // ================================================================

    public markAsDeleted(): void { this.isBeingDeleted = true; }

    async waitUntilReady(): Promise<void> {
        return this.initPromise ?? Promise.resolve();
    }

    getText(): string {
        // Synchronous snapshot — use cached session state; commandBus is async
        return JSON.stringify({
            sessionId: this.currentSessionId,
            title: this.currentTitle,
            messageCount: this.sessionManager.getSessions().length,
            status: this.sessionManager.getStatus(),
        }, null, 2);
    }

    setText(_text: string): void {
        this.loadSession()
            .then(() => this.emit('contentLoaded', undefined))
            .catch(e => {
                this.historyView.renderError(e);
                this.emit('error', e);
            });
    }

    async setTextAsync(_text: string): Promise<void> {
        await this.loadSession();
    }

    isDirty(): boolean {return this.stateManager?.hasPendingInput() ?? false;}
    captureRecovery(): unknown {
        if (this.historyView.hasPendingEdits?.()) throw Object.assign(new Error(t('httpApp.recoveryBusy')), {code: 'RECOVERY_BUSY'});
        return this.chatInput.captureRecovery();
    }
    restoreRecovery(state: unknown): void { this.chatInput.restoreRecovery(state); }
    suspendForRecovery(): void {
        this.stateManager.cleanup(); this.cancelPendingRender();
        this.flushPendingSave = async () => {};
    }
    setDirty(_dirty: boolean): void { }
    focus(): void { this.chatInput?.focus(); }
    cancelPendingRender(): void {
        this.invocationAbort.abort();
        this.chatInput?.cancelPendingSend?.();
        this.chatInput?.hideNativeModelPicker?.();
        ++this.activationRevision;
        this.viewActive = false; this.invocationPanel?.setVisible(false);
        this.submissionRecovery?.setActive(false);
        this.historyView?.setActive?.(false);
        if (this.refreshAgentsTimer) clearTimeout(this.refreshAgentsTimer);
        this.refreshAgentsTimer = null;
        void this.runAttachment?.detach().catch(error => console.error('[View] Task detach failed', error));
        this.sessionEventUnsub?.(); this.sessionEventUnsub = null;
        this.globalEventUnsub?.(); this.globalEventUnsub = null;
    }
    async activate(): Promise<void> {
        if (!this.initComplete || this.destroyPromise) return;
        const revision = ++this.activationRevision;
        const isCurrent = () => revision === this.activationRevision && this.viewActive && !this.destroyPromise;
        this.viewActive = true;
        if (this.invocationAbort.signal.aborted) this.invocationAbort = new AbortController();
        this.historyView?.setActive?.(true);
        const loaded = await this.sessionService.loadSession(this.options.sessionId, this.currentTitle, this.branchStore.currentBranch?.name);
        if (!isCurrent()) return;
        this.submissionRecovery?.setActive(true);
        this.submissionRecovery?.observe(loaded.snapshot.instructionQueue);
        this.bindSessionEvents();
        this.globalEventUnsub?.();
        this.globalEventUnsub = this.sessionManager.onGlobalEvent(event => this.sessionEventHandler.handleGlobalEvent(event));
        this.historyView.renderFull(loaded.snapshot.sessions);
        this.navigation.updatePrompts(loaded.snapshot.sessions);
        this.statusIndicator.updateFromSnapshot(loaded.snapshot);
        this.invocationPanel?.setVisible(true);
        await this.chatInput.refreshConnections();
        if (!isCurrent()) return;
        await this.restorePrivilegedTaskAttachment();
    }

    setTitle(title: string): void {
        this.currentTitle = title;
        if (this.inputReceiver) this.inputReceiver.textContent = t('project.currentConversation', {name: title});
        if (this.titleInput) this.titleInput.value = title;
    }

    setReadOnly(): void { }
    get commands() { return { createChildWithMaterial: () => this.createChildWithMaterial(), rerunSession: () => this.rerunSession(),
        sendMessage: (message: import('../commands/SendMessageCommand').SendMessageParams) => this.routeMessage(message),
    }; }

    private async rerunSession(): Promise<void> {
        if (!this.currentSessionId || this.rerunPending) return;
        if (this.sessionManager.isGenerating()) throw new Error(t('session.rerun.busy'));
        this.rerunPending = true;
        this.rerunAbort?.abort();
        this.rerunAbort = new AbortController();
        try {
            await rerunSession(this.commandBus, this.currentSessionId,
                this.chatInput.getConfig().settings.executionMode ?? 'chat', this.rerunAbort.signal,
                this.options.privilegedCommands ? command => this.startExec(command) : undefined);
        } finally { this.rerunPending = false; }
    }
    getMode() { return 'edit' as const; }
    async switchToMode(): Promise<void> { }
    async getHeadings() { return []; }
    async getSearchableText() { return this.commandBus.execute<string>(SessionCommand.Export).catch(() => ''); }
    async getSummary() { return null; }
    async navigateTo(target: {elementId: string}): Promise<void> {
        const element = this.historyView.revealSession(target.elementId);
        if (!element) throw new Error(t('project.search.navigateFailed'));
        element.scrollIntoView({block: 'start', behavior: 'smooth'});
    }
    async search() { return []; }
    gotoMatch(): void { }
    clearSearch(): void { }
    async pruneAssets(): Promise<number | null> { return null; }

    async collapseBlocks(): Promise<CollapseExpandResult> {
        return { affectedCount: 0, allCollapsed: true };
    }

    async expandBlocks(): Promise<CollapseExpandResult> {
        return { affectedCount: 0, allCollapsed: false };
    }

    async toggleBlocks(): Promise<CollapseExpandResult> {
        return this.collapseBlocks();
    }

    on<E extends EditorEvent>(
        event: E,
        callback: EditorEventCallback<E>,
    ): () => void {
        return this.editorEvents.on(event, payload => callback(payload));
    }

    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]): void {
        this.editorEvents.emit(event, payload);
    }

    // ================================================================
    // 插件注册
    // ================================================================

    private async startFlowInvocation(args: string): Promise<boolean> {
        if (this.invocationPending || !this.viewActive || this.invocationAbort.signal.aborted) return false;
        const operation = invokeFlowText(this.commandBus, this.options.sessionId, args, this.invocationAbort.signal, id => this.openInvocationChild(id));
        this.invocationPending = operation;
        try { return await operation; }
        finally { if (this.invocationPending === operation) this.invocationPending = undefined; void this.invocationPanel?.refresh(); }
    }

    private async createChildWithMaterial(): Promise<void> {
        const id = await promptChildConversation(this.commandBus, this.options.sessionId, this.invocationAbort.signal);
        if (id) await this.openInvocationChild(id);
    }

    private async openInvocationChild(id: string): Promise<void> {
        if (this.invocationAbort.signal.aborted) return;
        await this.hostContext?.navigate?.({target: 'chat', resourceId: id});
    }

    private registerInputPlugins(): void {
        const chatInput = this.chatInput as ChatInput;

        const promptHistory = this.sessionManager.promptHistory;
        if (promptHistory) {
            this.historyPlugin = new HistoryPlugin(promptHistory);
            chatInput.registerPlugin(this.historyPlugin);
        }

        this.slashPlugin = new SlashCommandPlugin(
            buildSlashCallbacks({
                commands: this.commandBus,
                onFlow: args => this.startFlowInvocation(args),
                chatInput: this.chatInput,
                saveConfiguration: () => this.handleConfigChange(this.chatInput.getConfig()),
                bus: this.bus,
                historyView: this.historyView,
                nodeCommands: this.nodeCommands,
                branchStore: this.branchStore,
                branchService: this.branchService,
                domCache: this.domCache,
                hostContext: this.hostContext,
                sendCommand: () => this.sendCommand,
                switchBranchByOffsetCommand: this.switchBranchByOffsetCommand,
                agentService: this.agentService,
                _sessionEngine: this.engine,
                handleCopy: () => this.handleCopy(),
                handlePrint: () => this.handlePrint(),
                toggleNavigator: () => this.navigation.toggleNavigator(this.container),
                findCurrentVisibleSession: () => this.navigation.findCurrentVisibleSession(),
                updateCollapseButtonIcon: (isAllCollapsed) => this.updateCollapseButtonIcon(isAllCollapsed),
                privilegedCommands: this.options.privilegedCommands ? {
                    plan: goal => this.startPlan(goal),
                    exec: command => this.startExec(command),
                    cancel: () => this.cancelAttachedTask(),
                    resume: () => this.resumeAttachedTask(),
                    approve: note => this.approveAttachedTask(note),
                } : undefined,
                ...(this.options.sessionSkills ? {
                    skills: {
                        snapshot: () => this.skillSnapshot,
                        load: (skillId: string) => this.options.sessionSkills!.load(this.options.sessionId, skillId),
                        describe: (skillId: string) => this.options.sessionSkills!.describe(this.options.sessionId, skillId),
                        openPanel: () => this.chatInput?.showSkillSettings(),
                        refresh: () => this.refreshSkillSnapshot(),
                    },
                } : {}),
            })
        );
        chatInput.registerPlugin(this.slashPlugin);
    }

    /**
     * Re-read the Session Skill list for the slash popup's synchronous snapshot.
     *
     * Fire-and-forget: the popup rebuilds its commands on every keystroke, so a mount that
     * happened after the editor opened is picked up without reopening the session. Failures
     * leave the previous snapshot in place.
     */
    private refreshSkillSnapshot(): void {
        this.skillRefreshBinding?.refresh();
    }

    // ── Q3: Mid-execution user injection ─────────────────────────────────────

    injectIntoRunningKernel(message: string): boolean {
        if (!this.runAttachment?.activeTaskId) return false;
        void this.runAttachment.signal({ type: 'inject', payload: { text: message } })
            .catch(error => Toast.error(error instanceof Error ? error.message : String(error)));
        return true;
    }

    private async startPlan(goal: string): Promise<void> {
        const sessionId = this.requireSessionId();
        const agentId = this.chatInput.getConfig().agentId;
        const taskId = await this.options.privilegedCommands!.plan({ sessionId, agentId, goal, connectionId: this.chatInput.getConfig().settings?.connectionId });
        await this.attachPrivilegedTask(taskId, 'Plan task created');
    }

    private async startExec(command: string): Promise<void> {
        const taskId = await this.options.privilegedCommands!.exec({
            sessionId: this.requireSessionId(), command,
        });
        await this.attachPrivilegedTask(taskId);
    }

    private async attachPrivilegedTask(taskId: string, message?: string): Promise<void> {
        if (!this.runAttachment) throw new Error('Kernel task attachment is unavailable');
        await rememberTaskAttachment(this.options.kernel!, this.requireSessionId(), this.runAttachment, taskId);
        if (message) Toast.info(message);
    }

    private async restorePrivilegedTaskAttachment(): Promise<void> {
        const attachment = this.runAttachment, kernel = this.options.kernel, sessionId = this.currentSessionId;
        if (!attachment || !kernel || !sessionId || this.attachmentClosed || !this.viewActive) return;
        const revision = attachment.revision;
        const isCurrent = () => !this.attachmentClosed && this.viewActive && this.runAttachment === attachment
            && this.currentSessionId === sessionId && attachment.revision === revision;
        await restoreTaskAttachment(kernel, sessionId, attachment, isCurrent,
            async () => await this.invocationPanel?.taskIds() ?? new Set<string>(), this.options.readTaskAttachment);
    }

    private async cancelAttachedTask(): Promise<void> {
        if (await this.invocationPanel?.hasActive()) throw new Error(t('flow.invoke.ambiguous'));
        if (!this.runAttachment) throw new Error('Kernel task attachment is unavailable');
        await this.runAttachment.cancel();
        Toast.info('Task cancelled');
    }

    private async resumeAttachedTask(): Promise<void> {
        if (await this.invocationPanel?.hasActive()) throw new Error(t('flow.invoke.ambiguous'));
        if (!this.runAttachment) throw new Error('Kernel task attachment is unavailable');
        await this.runAttachment.resume();
        Toast.info('Task resumed');
    }

    private async approveAttachedTask(note: string): Promise<void> {
        if (await this.invocationPanel?.hasActive()) throw new Error(t('flow.invoke.ambiguous'));
        if (!this.runAttachment) throw new Error('Kernel task attachment is unavailable');
        await this.runAttachment.approve(note);
        Toast.info('Task approved');
    }



    private requireSessionId(): string {
        if (!this.currentSessionId) throw new Error('Session is not ready');
        return this.currentSessionId;
    }

    // ================================================================
    // 文件搜索 / OCR → 委托到专用 Service
    // ================================================================


    // ================================================================
    // 销毁 — 逆序清理
    // ================================================================

    async flushPendingSave(): Promise<void> {
        if (!this.initComplete || this.isBeingDeleted) return;
        await this.stateManager.waitForDrafts();
        await this.stateManager.saveInputConfiguration(this.chatInput.getConfig());
    }

    destroy(): Promise<void> {
        if (this.destroyPromise) return this.destroyPromise;
        ++this.activationRevision; this.viewActive = false;
        this.submissionRecovery?.setActive(false);
        this.attachmentClosed = true;
        this.rerunAbort?.abort();
        this.flowOutputAbort?.abort();
        this.inputDialogAbort?.abort();
        this.invocationAbort.abort();
        const attachment = this.runAttachment;
        this.runAttachment = undefined;
        this.destroyPromise = Promise.resolve().then(() => disposeEditorResources(this.disposalSteps(attachment)));
        return this.destroyPromise;
    }

    private disposalSteps(attachment?: RunAttachmentController): (() => void | Promise<void>)[] {
        const preserve = !this.initComplete && !!this.options.handoff;
        return [
            () => this.flushPendingSave(), () => attachment?.detach(),
            () => this.container?.removeEventListener('click', this.onWelcomePrompt),
            () => this.assetManager?.close(), () => this.skillRefreshBinding?.dispose(),
            () => this.sessionEventUnsub?.(), () => this.stateManager?.cleanup(),
            () => this.stateManager?.waitForDrafts(),
            () => this.globalEventUnsub?.(), () => this.agentServiceUnsub?.(),
            () => this.connectionOptions?.dispose(), () => this.clearDisposalBindings(),
            () => this.eventBinder?.cleanup(), () => this.directoryMenu?.destroy(),
            () => this.commandRegistry?.destroy(), () => this.navigation?.destroy(),
            () => this.timers.destroy(), () => this.historyPlugin?.deactivate(),
            () => this.slashPlugin?.deactivate(), () => this.invocationPanel?.destroy(),
            () => this.instructionQueuePanel?.destroy(),
            () => this.submissionRecovery?.dispose(),
            () => this.branchIndicator?.destroy(), () => this.statusIndicator?.destroy(),
            () => this.historyView?.destroy(), () => {if (!preserve) this.chatInput?.destroy();},
            () => this.sessionService?.dispose(), () => this.branchStore?.destroy(),
            () => this.domCache?.destroy(), () => this.bus?.destroy(),
            async () => {
                if (this.sessionManager.id === this.options.sessionId)
                    await this.commandBus?.execute(SessionCommand.Unbind).catch(() => {});
            },
            () => { if (this.container && !preserve) this.container.innerHTML = ''; },
            () => this.editorEvents.clear(), () => this.nodeCommands.clear(),
        ];
    }

    private async reconcileSubmission(id: string): Promise<void> {
        const revision = this.activationRevision;
        const isCurrent = () => revision === this.activationRevision && this.viewActive && !this.destroyPromise;
        await this.sendCommand.reconcile(id, isCurrent);
        if (isCurrent()) await this.stateManager.saveInputConfiguration(this.chatInput.getConfig());
    }

    private async recoverAcceptedDraft(): Promise<void> {
        const token = this.chatInput.getConfig().draftToken;
        if (!token) return;
        const record = this.operations?.getSnapshot().find(item => item.conversationId === this.options.sessionId
            && item.kind === 'send' && item.status === 'accepted' && (item.input as {draft?: {token?: string}})?.draft?.token === token);
        if (record) await this.reconcileSubmission(record.context.operationId);
    }

    private clearDisposalBindings(): void {
        this.skillRefreshBinding = null;
        this.connectionOptions = undefined;
        this.sessionEventUnsub = null;
        this.globalEventUnsub = null;
        this.agentServiceUnsub = null;
        if (this.refreshAgentsTimer) clearTimeout(this.refreshAgentsTimer);
        this.refreshAgentsTimer = null;
    }
}
