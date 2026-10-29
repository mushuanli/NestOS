import {chatAttachmentMenu} from './chat-attachment-menu';
import {mountChatInputMenu} from './chat-input-menu';
import {refreshDraftTarget, restoreDraftTarget} from '../independent/restore-draft-target';
import {mountExecutionDraftAction} from './chat-execution-draft';
import {workspaceInputPlugins} from './workspace-input-plugins';
import {SharedChatOcr} from './SharedChatOcr';
import {resolveResize} from '@itookit/image-parser';
import {SharedChatCommands} from './SharedChatCommands';
import {SharedChatTaskPanel} from './SharedChatTaskPanel';
import {chatSettings, chatSelectors, mountChatSettings} from './chat-settings';
import {measureSessionLoad} from './load-metrics';
import {SessionHistoryActions} from '../independent/session-history-actions';
import {CHAT_SLOT_CLASSES} from '@itookit/llm-ui';
import {SessionRunsPanel} from '../flows/SessionRunsPanel';
import {presentHostControl} from '../independent/button-presentation';
import {messageMarkdown} from '../independent/message-markdown';
import {ACTION_ICONS, CHAT_ICONS, createModuleLogger, escapeHTML, getLocale, randomUUID, t} from '@itookit/common';
import {BaseSettingsEditor, Toast, type EditorEvent, type EditorEventMap, type EditorEventCallback} from '@itookit/ui-common';
import type {ChatView, ChatSubmission, ComposerDraft} from '@itookit/llm-ui';
import {SessionCommand, type RootTargetCatalog, type SubmissionRequest} from '@itookit/llm-session/contracts';
import {createAssetProvider} from '@itookit/mdx-adapter';
import {createSessionChatBinding, createSessionChatView} from '../independent/session';
import {SessionChatStore} from '../independent/session-store';
import type {SessionChatView} from '../independent/session-view';
import type {ImageChatOptions} from '../independent/image-chat-view';
import {disposeEditorResources} from './editor-disposal';
import {prepareSessionChatRequest} from '../independent/session-submission';
import {SessionService, AssetService} from '../services';
import {InteractionDraftPersistence} from '../services/InteractionDraftPersistence';
import {buildConnectionOptions} from './AgentProvider';
import {openSessionFlowOutputs} from '../flows/session-output';
import type {LLMEditorOptions} from './session-editor-options';
import type {RetainedWorkspaceHandoff} from './drafts/workspace-handoff';
import {adoptSessionChatView, replaceSessionChatBinding} from '../independent/session-view';
import type {SessionSubmission} from '@itookit/llm-flow/contracts';

const log = createModuleLogger('session-chat-editor');
type Binding = ReturnType<typeof createSessionChatBinding>;
/** The product shell adapts host capabilities to one shared ChatView. */
export class IndependentSessionEditor extends BaseSettingsEditor<LLMEditorOptions['sessionRepository']> {
    private readonly sessions: SessionService;
    private view?: SessionChatView;
    private sessionRunsPanel?: SessionRunsPanel;
    private binding?: Binding;
    private store?: SessionChatStore;
    private historyActions?: SessionHistoryActions;
    private inputCommands?: SharedChatCommands;
    private ocr?: SharedChatOcr;
    private taskPanel?: SharedChatTaskPanel;
    private branch = 'main';
    private initialManifest?: import('@itookit/llm-session/contracts').ConversationManifest;
    private active = true;
    private offConfiguration?: () => void;
    private configurationGeneration = 0;
    private closed = false;
    private destroying?: Promise<void>;
    private suspended = false;
    private changing = false;
    private lifetime = new AbortController();
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    private connections: Awaited<ReturnType<typeof buildConnectionOptions>> = [];
    private settings: import('../domain/ports/IChatInputPresenter').ChatInputSettings = {};
    private ownsView: boolean;
    private readonly inputListeners = new Set<() => void>();
    private readonly submissions = new Map<string, SessionSubmission>();
    constructor(container: HTMLElement, private config: LLMEditorOptions, private handoff?: RetainedWorkspaceHandoff) {
        super(container, config.sessionRepository, config);
        this.ownsView = !handoff;
        this.sessions = new SessionService(this.service, config.commandBus!);
        const changed = () => {void this.refreshConfiguration().catch(error => this.fail(error));};
        this.offConfiguration = config.configuration?.subscribe(changed) ?? config.agentService.onChange(changed);
    }
    async init(container: HTMLElement): Promise<void> {this.container = container; await this.render();}
    async render(): Promise<void> {
        const measurement = measureSessionLoad(this.config.sessionId, this.config.onLoadMetrics);
        const loaded = await this.sessions.loadSession(this.config.sessionId, this.config.title ?? '', this.config.target?.kind === 'session' ? this.config.target.branch : undefined, this.config.initialData);
        measurement.mark('bindSession'); this.config.initialData = undefined; this.settings = loaded.settings; this.config.title = loaded.title;
        this.connections = await buildConnectionOptions(this.config.agentService, this.config.configuration?.getConfigurationSnapshot());
        await this.resolveSubmission();
        this.checkAlive();
        this.initialManifest = loaded.manifest;
        try {await this.mount(loaded.manifest.currentBranch, {uiState: loaded.manifest.uiState});}
        finally {this.initialManifest = undefined;}
        if (this.config.initialInputState?.text) this.view!.setText(this.config.initialInputState.text);
        measurement.mark('restoreAndRender'); measurement.finish(); this.emit('ready', undefined);
    }
    private async mount(branch: string, initial?: {uiState?: import('@itookit/llm-session/contracts').ConversationUIState}): Promise<void> {
        this.checkAlive();
        const previous = this.mountSnapshot();
        const store = await SessionChatStore.open(this.service, this.config.sessionId, branch, new AssetService(this.config.assets), initial);
        this.checkAlive();
        const lifetime = new AbortController(), binding = this.createBinding(store, lifetime.signal);
        try {
            await binding.refreshTargets(false); const draft = await this.initialDraft(store, binding); this.checkAlive();
            this.branch = branch; this.store = store; this.binding = binding; this.lifetime = lifetime;
            if (this.config.target?.kind === 'session') this.config.target = {...this.config.target, branch};
            const options = this.viewOptions(store, draft);
            if (this.handoff && !this.view) {
                await this.retainHandoffFiles(store, lifetime.signal);
                this.view = await adoptSessionChatView(this.handoff.view, binding, {...options, initialDraft: undefined});
                await this.view.flushDraft();
            } else if (this.view) await replaceSessionChatBinding(this.view, binding, options);
            else this.view = await createSessionChatView(this.container, binding, options);
            previous.lifetime.abort(); previous.binding?.dispose();
            if (!this.active) this.view.setActive(false);
        } catch (error) {await this.rollbackMount(error, previous, binding, lifetime); throw error;}
    }
    private mountSnapshot() {
        return {store: this.store, binding: this.binding, branch: this.branch, lifetime: this.lifetime,
            history: this.historyActions, commands: this.inputCommands, taskPanel: this.taskPanel, ocr: this.ocr};
    }
    private async rollbackMount(error: unknown, previous: ReturnType<IndependentSessionEditor['mountSnapshot']>, binding: Binding, lifetime: AbortController): Promise<void> {
        if (!(error as {bindingCommitted?: boolean})?.bindingCommitted) {
            const abandoned = {history: this.historyActions, commands: this.inputCommands, taskPanel: this.taskPanel, ocr: this.ocr};
            binding.dispose(); lifetime.abort();
            this.store = previous.store; this.binding = previous.binding; this.branch = previous.branch; this.lifetime = previous.lifetime; this.historyActions = previous.history; this.inputCommands = previous.commands; this.taskPanel = previous.taskPanel; this.ocr = previous.ocr;
            if (this.config.target?.kind === 'session') this.config.target = {...this.config.target, branch: previous.branch};
            try {await disposeEditorResources([() => abandoned.history?.destroy(), () => abandoned.commands?.destroy(), () => abandoned.taskPanel?.destroy(), () => abandoned.ocr?.destroy()]);}
            catch (cleanup) {throw new AggregateError([error, cleanup], 'Session binding replacement and cleanup failed');}
        } else {previous.lifetime.abort(); previous.binding?.dispose();}
    }
    private async retainHandoffFiles(store: SessionChatStore, signal: AbortSignal): Promise<void> {
        const retained = new Set<string>();
        while (true) {
            const draft = this.handoff!.view.getDraft();
            const copy = async (id: string) => {if (!retained.has(id)) {await store.assets.retainDraftFile(id, this.handoff!.read, signal); retained.add(id);}};
            for (const item of draft.attachments) {await copy(item.file.id); await store.images.retain(item.file, this.handoff!.images, copy);}
            await this.handoff!.view.flushDraft();
            if (this.handoff!.view.getDraft().attachments.every(item => retained.has(item.file.id))) return;
        }
    }
    private async resolveSubmission(): Promise<SessionSubmission | undefined> {
        const submission = await this.config.resolveSubmission?.();
        if (submission) this.submissions.set(submission.id, submission);
        return submission;
    }
    private checkAlive(): void {
        this.config.signal?.throwIfAborted();
        if (this.closed) throw Object.assign(new Error('Session editor is closed'), {code: 'VIEW_CLOSED'});
    }
    private createBinding(store: SessionChatStore, signal: AbortSignal): Binding {
        const owner = this, operations = store.ledger();
        const taskPanel = new SharedChatTaskPanel(error => this.fail(error), this.config.commandBus!, task =>
            this.config.sessionManager.getSessions().some(group => group.execution?.taskId === task.id || group.execution?.taskId === task.rootTaskId));
        const inputCommands = new SharedChatCommands({config: this.config, session: this.config.sessionManager, operations, signal,
            view: () => this.view, snapshot: () => binding.source.getSnapshot(), current: () => this.binding === binding && this.current() && this.active && !this.config.readOnly,
            taskCallbacks: taskPanel.callbacks, attach: controller => taskPanel.bind(controller), changed: () => this.observeBranch(),
            selectAgent: id => this.selectAgent(id), configure: values => this.configure(values),
            openSettings: () => {const menu = this.container.querySelector<HTMLDetailsElement>('[data-chat-settings]'); if (menu) {const parent = menu.closest<HTMLDetailsElement>('.llm-chat__input-menu'); if (parent) parent.open = true; menu.open = true;}}, report: error => this.fail(error)});
        this.inputCommands = inputCommands; this.taskPanel = taskPanel;
        const history = this.historyActions = this.createHistory(store, () => binding);
        const binding = createSessionChatBinding({session: this.config.sessionManager, commands: this.config.commandBus!, kernel: this.config.kernel,
            history: history.actions, title: this.config.title, operations, composerCommands: {subscribe: listener => inputCommands.subscribe(listener), getSnapshot: () => inputCommands.getSnapshot(), execute: (input, context) => inputCommands.execute(input, context),
                reconcile: async operationId => {const record = operations.getSnapshot().find(item => item.context.operationId === operationId); return record?.status === 'accepted' ? {status: 'accepted', operationId} : {status: 'unknown', operationId, message: t('chat.submission.unconfirmed')};}}, targetSelection: true, autoSelectFirstTarget: false, structuredInputDialog: true,
            onTargetsChanged: catalog => {if (this.binding === binding && !this.closed && this.active) refreshDraftTarget(this.view, catalog);}, independentCalls: !this.config.readOnly, instructionQueue: true, contextSelection: true,
            get readOnly() {return !!owner.config.readOnly;}, branch: () => this.config.sessionManager.getSnapshot?.().view?.manifest.currentBranch ?? store.branch,
            subscribeInput: listener => {this.inputListeners.add(listener); return () => {this.inputListeners.delete(listener);};},
            selectors: () => this.selectors(), executionOverrides: (input, draft) => this.overrides(input, draft),
            resolveSubmission: id => this.submissions.get(id),
            prepareSend: async (input, draft) => {
                if (await inputCommands.direct(input, draft)) return null;
                const submission = await this.resolveSubmission(); this.checkAlive();
                if (submission && binding.operations.getSnapshot().some(record => record.context.operationId === submission.id)) return null;
                return {operationId: submission?.id ?? randomUUID(), viewId: binding.source.getSnapshot().viewId};
            },
            prepareRequest: (request, input) => this.prepare(request, input, store, signal),
            hasCommittedSubmission: submission => this.config.commandBus!.execute(SessionCommand.HasCommittedSubmission, {sessionId: this.config.sessionId, submission}),
            openOutputs: taskId => openSessionFlowOutputs(this.config.commandBus!, this.config.sessionId, signal, taskId),
            openChild: id => this.config.hostContext?.navigate({target: 'chat', resourceId: id}),
            interactionDrafts: new InteractionDraftPersistence(this.service), onError: error => this.fail(error)});
        binding.prepareCalls(); return binding;
    }
    private createHistory(store: SessionChatStore, binding: () => Binding): SessionHistoryActions {
        return new SessionHistoryActions({commands: this.config.commandBus!, session: this.config.sessionManager,
            snapshot: () => binding().source.getSnapshot(), available: () => this.binding === binding() && this.branch === store.branch && this.current() && this.active && !this.config.readOnly,
            changed: () => this.observeBranch()});
    }
    private async initialDraft(store: SessionChatStore, binding: Binding): Promise<ComposerDraft> {
        const groups = this.config.sessionManager.getSessions(), previous = [...groups].reverse().find(group => group.target)?.target;
        const draft = store.draft, result = restoreDraftTarget(draft, binding.source.getSnapshot().callTargets,
            previous, this.config.initialInputState?.agentId ?? store.agentId ?? this.initialManifest?.createdWithAgentId
                ?? this.config.sessionManager.getSnapshot?.().view?.manifest.createdWithAgentId);
        if (result !== draft) log.info('chat.target.restore', {operationId: randomUUID(), stage: 'restore', result: 'success',
            sessionId: this.config.sessionId, code: 'DRAFT_TARGET_RESOLVED', durationMs: 0,
            previousVersion: draft.target?.version ?? previous?.version, version: result.target?.version});
        return result;
    }
    private viewOptions(store: SessionChatStore, draft: ComposerDraft): ImageChatOptions {
        const history = this.historyActions, inputCommands = this.inputCommands, taskPanel = this.taskPanel;
        const releaseUsage = this.trackUsage(this.binding!.operations);
        let inputSignature = JSON.stringify([draft.target, draft.selection]);
        const images = store.images.host(() => {
            const input = this.view?.getDraft(), settings = chatSettings(input?.selection, this.settings);
            const agent = this.config.agentService.listAgents().find(item => item.id === input?.target?.id);
            return resolveResize(settings.imageResize, agent?.config.imageProcessing?.resize);
        }, resize => {const view = this.view; if (!view) return; const current = view.getDraft();
            view.configureInput({selection: {...current.selection, imageResize: JSON.stringify(resize)}}, current.revision);});
        const ocr = this.config.ocr ? new SharedChatOcr(this.config.ocr, () => this.view,
            (ref, signal) => images.read(ref, {signal}), failure => this.fail(failure)) : undefined;
        this.ocr = ocr;
        return {images, inputPresentation: 'host', attachmentMenu: chatAttachmentMenu(true), plugins: workspaceInputPlugins(this.config.commandBus, {navigation: 'projects', sessionId: this.config.sessionId},
            () => this.view?.getDraft().target?.id ?? 'default', this.config.sessionManager.promptHistory), attachmentActions: item => ocr?.actions(item) ?? [], setActive: active => {history?.setActive(active); ocr?.setActive(active); taskPanel?.setActive(active); if (active) void inputCommands?.restore().catch(error => this.fail(error));},
            release: () => disposeEditorResources([releaseUsage, () => history?.destroy(), () => inputCommands?.destroy(), () => taskPanel?.destroy(), () => ocr?.destroy()]),messageActions: context => history?.messageActions(context) ?? [], locale: getLocale(), initialDraft: draft, markdown: messageMarkdown(this.config, id => this.messageAnchor(id)),
            assets: createAssetProvider(undefined, undefined, this.config.assets), upload: this.config.assets ? store.upload.bind(store) : undefined,
            saveDraft: value => this.save(store, value), onDraftChange: value => {this.emit('interactiveChange', undefined); const next = JSON.stringify([value.target, value.selection]);
                if (next !== inputSignature) {inputSignature = next; for (const listener of this.inputListeners) listener();}},
            onError: error => this.fail(error), onDiagnostic: event => log.info('chat.operation', {...event, sessionId: this.config.sessionId}),
            onBindingDiagnostic: event => log.info('chat.binding', {...event, sessionId: this.config.sessionId}),
            mountComposerMenu: (root, context) => {
                const before = new Set(root.childNodes), release = mountChatSettings(root, () => this.view, () => chatSettings(this.view?.getDraft().selection, this.settings), error => this.fail(error));
                inputCommands?.mountSkills(root);
                const menu = mountChatInputMenu(root, {view: context.view, settings: () => chatSettings(context.view.getDraft().selection, this.settings),
                    prompts: () => this.config.agentService.findAgent(context.view.getDraft().target?.id ?? '')?.defaultPrompts ?? [],
                    agentId: () => context.view.getDraft().target?.kind === 'agent' ? context.view.getDraft().target?.id : undefined,
                    configureAgent: this.config.hostContext?.navigate ? id => this.config.hostContext!.navigate({target: 'chat', resourceId: '@agent/' + encodeURIComponent(id)}) : undefined,
                    available: () => !this.closed && this.active && !this.config.readOnly, hasFiles: !!this.config.commandBus, report: error => this.fail(error)});
                const releaseTransfer = mountExecutionDraftAction(root, this.config, () => this.view, draft => store.files(draft.attachments.map(item => item.file), this.lifetime.signal),
                    () => this.current() && this.active && !this.config.readOnly, error => this.fail(error));
                const owned = [...root.childNodes].filter(node => !before.has(node));
                return {update: () => menu.update?.(context), destroy: () => {release(); releaseTransfer(); menu.destroy(); owned.forEach(node => node.remove());}};
            }, mountHeader: (root, context) => this.toolbar(root, taskPanel, context.headerMenu)};
    }
    private trackUsage(operations: import('@itookit/llm-ui').OperationLedger): () => void {
        const accepted = new Set(operations.getSnapshot().filter(item => item.status === 'accepted').map(item => item.context.operationId));
        return operations.subscribe(() => {
            for (const record of operations.getSnapshot()) {
                if (record.kind !== 'send' || record.status !== 'accepted' || accepted.has(record.context.operationId)) continue;
                accepted.add(record.context.operationId);
                const target = (record.input as unknown as ChatSubmission)?.target;
                if (target?.kind === 'agent') this.config.executorUsage?.record(target.id);
            }
        });
    }
    private messageAnchor(messageId: string) {
        for (const group of this.config.sessionManager.getSessions()) {
            const roundId = group.roundId ?? group.persistedNodeId;
            if (group.id === messageId) return {branch: this.branch, roundId, ...(group.role === 'user' ? {userIndex: (group.inputMessages?.length ?? 1) - 1} : {})};
            if (group.role === 'user') for (let index = 0; index < (group.inputMessages?.length ?? 0); index++)
                if (`${group.id}:input:${index}` === messageId) return {branch: this.branch, roundId, userIndex: index};
        }
    }
    private async prepare(request: SubmissionRequest, input: ChatSubmission, store: SessionChatStore, signal: AbortSignal): Promise<SubmissionRequest> {
        if (!this.current() || this.config.readOnly) throw new Error('Session input binding expired');
        const catalog = await this.config.commandBus!.execute<RootTargetCatalog>(SessionCommand.ListTargets);
        const choice = catalog.entries.find(choice => choice.target.kind === request.expectedTarget?.kind && choice.target.id === request.expectedTarget.id
            && choice.target.version === request.expectedTarget.version && choice.target.digest === request.expectedTarget.digest);
        if (!choice) throw new Error(t('callable.catalog.changed'));
        return prepareSessionChatRequest({commands: this.config.commandBus!, agents: this.config.agentService, choice, request, input,
            files: await store.files(input.attachments, signal), assets: this.config.assets, signal});
    }
    private current(): boolean {return !this.closed && this.config.sessionManager.id === this.config.sessionId
        && (this.config.sessionManager.getSnapshot?.().view?.manifest.currentBranch ?? this.branch) === this.branch;}
    private async save(store: SessionChatStore, draft: ComposerDraft): Promise<void> {
        if (this.suspended || this.config.readOnly) return;
        if (this.closed) throw new Error('Session draft binding expired');
        await store.save(draft);
        const next = chatSettings(draft.selection, this.settings);
        if (JSON.stringify(next) !== JSON.stringify(this.settings)) {await this.service.saveSessionSettings(this.config.sessionId, next); this.settings = next;}
        this.emit('saved', undefined);
    }
    private overrides(input: ChatSubmission, draft?: ComposerDraft): NonNullable<SubmissionRequest['overrides']> {
        const settings = chatSettings({...draft?.selection, ...input.selection}, this.settings);
        return {...settings, modelTier: settings.modelTier === 'auto' ? undefined : settings.modelTier,
            ...(settings.reasoningEffort === 'auto' ? {reasoningEffort: undefined} : {})};
    }
    private async refreshConfiguration(): Promise<void> {
        const generation = ++this.configurationGeneration;
        const connections = await buildConnectionOptions(this.config.agentService, this.config.configuration?.getConfigurationSnapshot());
        if (this.closed || !this.active || generation !== this.configurationGeneration) return;
        this.connections = connections; await this.binding?.refreshTargets();
    }
    private selectors() {
        const target = this.view?.getDraft().target ?? this.store?.draft.target;
        if (target?.kind === 'flow') return [];
        const agent = this.config.agentService.findAgent(target?.id ?? '');
        if (agent?.execution?.kind === 'flow') return [];
        const preferred = agent?.modelDefaults?.chat;
        const connections = preferred ? this.connections.map(item => ({...item, isDefault: item.id === preferred})) : this.connections;
        return chatSelectors(connections, chatSettings(this.view?.getDraft().selection, this.settings));
    }
    private toolbar(root: HTMLElement, taskPanel?: SharedChatTaskPanel, menuHost?: HTMLElement) {
        const releases: (() => void)[] = [], previous = new Set(root.childNodes);
        if (taskPanel) root.append(taskPanel.element);
        for (const [mount, className] of [[this.config.mountCompactNavigation, 'llm-chat__compact-navigation']] as const) {
            if (!mount) continue; const slot = document.createElement('div'); slot.className = className;
            if (className) slot.dataset.editorMobileNavigation = 'embedded'; root.append(slot); releases.push(mount(slot), () => slot.remove());
        }
        if (this.config.hostContext?.toggleSidebar) {const button = document.createElement('button'); button.type = 'button'; presentHostControl(button, t('chat.toolbar.sidebar'), ACTION_ICONS.sidebar);
            button.classList.add('llm-chat__sidebar'); button.onclick = () => this.config.hostContext!.toggleSidebar(); root.append(button);}
        const branches = document.createElement('select'); branches.className = 'llm-chat__branch'; branches.dataset.chatOverflow = ''; branches.setAttribute('aria-label', t('flow.output.branch')); root.append(branches);
        const refresh = async () => {const manifest = this.initialManifest ?? this.config.sessionManager.getSnapshot?.().view?.manifest ?? await this.service.getManifest(this.config.sessionId); if (this.closed || !branches.isConnected) return;
            branches.replaceChildren(...Object.keys(manifest.branches).map(name => {const option = document.createElement('option'); option.value = name; option.textContent = name; return option;})); branches.value = this.branch; branches.hidden = branches.options.length <= 1;};
        void refresh().catch(error => this.fail(error));
        branches.onchange = () => {void this.switchBranch(branches.value).catch(error => {branches.value = this.branch; this.fail(error);});};
        const menu = menuHost?.parentElement as HTMLDetailsElement ?? document.createElement('details'), body = menuHost ?? document.createElement('div');
        if (!menuHost) {const label = document.createElement('summary'); menu.className = CHAT_SLOT_CLASSES.menu;
            presentHostControl(label, t('chat.toolbar.more'), CHAT_ICONS.more); menu.append(label, body); root.append(menu);}
        menu.dataset.chatMenu = '';
        const runs = new SessionRunsPanel(this.config.commandBus!, this.config.sessionId, body, undefined, false);
        this.sessionRunsPanel = runs; releases.push(() => runs.destroy());
        const toggle = () => runs.setVisible(menu.open && this.active); menu.addEventListener('toggle', toggle); releases.push(() => menu.removeEventListener('toggle', toggle));
        for (const mount of [this.config.mountWindowList, this.config.mountConversationNavigation, this.config.mountMoreMenu]) {
            if (mount) releases.push(mount(body));
        }
        const owned = [...root.childNodes].filter(node => !previous.has(node));
        return {destroy: () => {try {releases.forEach(release => release());} finally {owned.forEach(node => node.remove());}}};
    }
    private async observeBranch(): Promise<void> {
        const branch = this.config.sessionManager.getSnapshot?.().view?.manifest.currentBranch;
        if (branch && branch !== this.branch) {await this.flushPendingSave(); await this.mount(branch);}
    }
    private async selectAgent(id: string): Promise<void> {
        await this.binding?.refreshTargets(); this.checkAlive();
        const target = this.binding?.source.getSnapshot().callTargets?.entries.find(item => item.target.kind === 'agent' && item.target.id === id)?.target;
        if (!target) throw new Error(t('toolbox.unavailable'));
        this.view!.configureInput({target}, this.view!.getDraft().revision); await this.view!.flushDraft();
    }
    private async configure(values: Record<string, string>): Promise<void> {
        this.checkAlive(); const view = this.view!, draft = view.getDraft();
        view.configureInput({selection: {...draft.selection, ...values}}, draft.revision); await view.flushDraft();
    }
    private async switchBranch(branch: string): Promise<void> {
        if (this.changing || this.closed || !this.active || branch === this.branch) return;
        if (this.view?.inputBusy) throw Object.assign(new Error(t('chatInput.switchUnavailable')), {code: 'VIEW_BUSY'});
        this.changing = true;
        try {await this.flushPendingSave(); this.view?.setActive(false);
            await this.config.commandBus!.execute('vcs.branch.switch', {branchName: branch});
            this.settings = await this.sessions.getSessionSettings(); await this.mount(branch);
        } finally {this.changing = false; this.view?.setActive(this.active);}
    }
    private fail(error: unknown): void {
        if (this.closed) return;
        const code = (error as {code?: string})?.code;
        log.warn('chat.editor', {sessionId: this.config.sessionId, stage: 'view', result: 'failure',
            code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SESSION_CHAT_FAILED'});
        Toast.error(escapeHTML(error instanceof Error ? error.message : String(error))); this.emit('error', error);
    }
    async collapseBlocks() {this.view?.setAllCollapsed(true); const result = this.view?.disclosureState() ?? {affectedCount: 0, allCollapsed: true}; this.emit('blocksCollapsed', result); return result;}
    async expandBlocks() {this.view?.setAllCollapsed(false); const result = this.view?.disclosureState() ?? {affectedCount: 0, allCollapsed: false}; this.emit('blocksExpanded', result); return result;}
    async toggleBlocks() {return this.view?.disclosureState().allCollapsed ? this.expandBlocks() : this.collapseBlocks();}
    async navigateTo(target: {elementId: string}) {this.view?.revealMessage(target.elementId);}
    async getSearchableText(): Promise<string> {return this.getText();}
    getText(): string {return this.config.sessionManager.getSessions().map(group => group.content ?? group.executionRoot?.data.output ?? '').join('\n\n');}
    setText(text: string): void {this.view?.setText(text);}
    focus(): void {this.view?.focus();}
    isDirty(): boolean {return !!this.view && !!this.store?.dirty(this.view.getDraft());}
    async flushPendingSave(): Promise<void> {if (!this.suspended) await this.view?.flushDraft();}
    cancelPendingRender(): void {this.active = false; this.sessionRunsPanel?.setVisible(false); this.view?.setActive(false);}
    async activate(): Promise<void> {
        if (this.closed) return;
        const snapshot = await this.config.commandBus!.execute<import('@itookit/llm-session/contracts').SessionSnapshot>(SessionCommand.Bind, {sessionId: this.config.sessionId});
        const branch = snapshot.view?.manifest.currentBranch ?? (await this.service.getManifest(this.config.sessionId)).currentBranch;
        if (branch !== this.branch) {
            await this.flushPendingSave(); this.settings = snapshot.view?.settings ?? await this.sessions.getSessionSettings(); await this.mount(branch);
        }
        this.active = true; this.sessionRunsPanel?.setVisible(!!this.container.querySelector<HTMLDetailsElement>('[data-chat-menu]')?.open); this.view?.setActive(true); await this.binding?.refreshTargets();
    }
    setReadOnly(value: boolean): void {this.config.readOnly = value; void this.binding?.refreshTargets();}
    captureRecovery(): unknown {this.ocr?.assertRecoverable(); return this.view?.captureRecovery();}
    restoreRecovery(value: unknown): void {this.view?.restoreRecovery(value as ReturnType<ChatView['captureRecovery']>);}
    suspendForRecovery(): void {this.suspended = true; this.store?.suspend(); this.cancelPendingRender();}
    destroy(): Promise<void> {
        return this.destroying ??= disposeEditorResources([() => this.flushPendingSave(),
            () => {this.closed = true; this.lifetime.abort();}, () => this.ownsView ? this.view?.destroy() : undefined,
            () => {this.offConfiguration?.(); this.binding?.dispose(); this.sessions.dispose(); this.events.clear();}]);
    }
    get commands() {return {prepareChatInput: (input: ChatSubmission, draft: ComposerDraft) => this.inputCommands?.direct(input, draft), getInputConfig: () => ({text: this.view?.getDraft().text ?? '',
        agentId: this.view?.getDraft().target?.id ?? 'default', settings: chatSettings(this.view?.getDraft().selection, this.settings)}), chatBindingIdentity: () => this.binding?.source.getSnapshot(), takeViewOwnership: () => {this.ownsView = true; this.handoff = undefined;},
        preparedSubmission: () => this.resolveSubmission(),
        sendMessage: async (input: {text: string; files?: File[]; target?: import('@itookit/llm-flow/contracts').TargetRef}) => {
        if (!this.active || this.closed || this.config.readOnly) throw new Error('Session input unavailable');
        this.view!.setText(input.text); if (input.files?.length) await this.view!.addFiles(input.files); await this.view!.submit();
    }};}
    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]): void {for (const listener of this.events.get(event) ?? []) listener(payload);}
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {const listener = (payload: unknown) => callback(payload as EditorEventMap[E]);
        const listeners = this.events.get(event) ?? new Set(); listeners.add(listener); this.events.set(event, listeners); return () => {listeners.delete(listener);};}
}
