import {SessionRunsPanel} from '../flows/SessionRunsPanel';
import {presentHostControl} from '../independent/button-presentation';
import {messageMarkdown} from '../independent/message-markdown';
import {ACTION_ICONS, CHAT_ICONS, createModuleLogger, escapeHTML, getLocale, randomUUID, t} from '@itookit/common';
import {BaseSettingsEditor, Toast, type EditorEvent, type EditorEventMap, type EditorEventCallback} from '@itookit/ui-common';
import type {ChatSubmission, ComposerDraft, SelectorView} from '@itookit/llm-ui';
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
import type {LLMEditorOptions} from './LLMWorkspaceEditor';
import type {RetainedWorkspaceHandoff} from './drafts/workspace-handoff';
import {adoptSessionChatView} from '../independent/session-view';
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
    private branch = 'main';
    private active = true;
    private closed = false;
    private destroying?: Promise<void>;
    private suspended = false;
    private changing = false;
    private lifetime = new AbortController();
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    private connections: Awaited<ReturnType<typeof buildConnectionOptions>> = [];
    private settings: import('../domain/ports/IChatInputPresenter').ChatInputSettings = {};
    private ownsView: boolean;
    private readonly submissions = new Map<string, SessionSubmission>();
    constructor(container: HTMLElement, private config: LLMEditorOptions, private handoff?: RetainedWorkspaceHandoff) {
        super(container, config.sessionRepository, config);
        this.ownsView = !handoff;
        this.sessions = new SessionService(this.service, config.commandBus!);
    }
    async init(container: HTMLElement): Promise<void> {this.container = container; await this.render();}
    async render(): Promise<void> {
        const loaded = await this.sessions.loadSession(this.config.sessionId, this.config.title ?? '', this.config.target?.kind === 'session' ? this.config.target.branch : undefined, this.config.initialData);
        this.config.initialData = undefined; this.settings = loaded.settings; this.config.title = loaded.title;
        this.connections = await buildConnectionOptions(this.config.agentService);
        await this.resolveSubmission();
        this.checkAlive();
        await this.mount(loaded.manifest.currentBranch);
        if (this.config.initialInputState?.text) this.view!.setText(this.config.initialInputState.text);
        this.emit('ready', undefined);
    }
    private async mount(branch: string): Promise<void> {
        this.checkAlive();
        const previous = {store: this.store, binding: this.binding, branch: this.branch, lifetime: this.lifetime};
        const store = await SessionChatStore.open(this.service, this.config.sessionId, branch, new AssetService(this.config.assets));
        this.checkAlive();
        const lifetime = new AbortController(), binding = this.createBinding(store, lifetime.signal);
        try {
            await binding.refreshTargets(); const draft = await this.initialDraft(store, binding); this.checkAlive();
            this.branch = branch; this.store = store; this.binding = binding; this.lifetime = lifetime;
            if (this.config.target?.kind === 'session') this.config.target = {...this.config.target, branch};
            const options = this.viewOptions(store, draft);
            if (this.handoff && !this.view) {
                await this.retainHandoffFiles(store, lifetime.signal);
                this.view = await adoptSessionChatView(this.handoff.view, binding, {...options, initialDraft: undefined});
                await this.view.flushDraft();
            } else if (this.view) await this.view.replaceSessionBinding(binding, options);
            else this.view = await createSessionChatView(this.container, binding, options);
            previous.lifetime.abort(); previous.binding?.dispose();
            if (!this.active) this.view.setActive(false);
        } catch (error) {
            if (!(error as {bindingCommitted?: boolean})?.bindingCommitted) {
                binding.dispose(); lifetime.abort();
                this.store = previous.store; this.binding = previous.binding; this.branch = previous.branch; this.lifetime = previous.lifetime;
                if (this.config.target?.kind === 'session') this.config.target = {...this.config.target, branch: previous.branch};
            } else {previous.lifetime.abort(); previous.binding?.dispose();}
            throw error;
        }
    }
    private async retainHandoffFiles(store: SessionChatStore, signal: AbortSignal): Promise<void> {
        const retained = new Set<string>();
        while (true) {
            const draft = this.handoff!.view.getDraft();
            for (const item of draft.attachments) if (!retained.has(item.file.id)) {
                await store.assets.retainDraftFile(item.file.id, this.handoff!.read, signal); retained.add(item.file.id);
            }
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
        const owner = this;
        const binding = createSessionChatBinding({session: this.config.sessionManager, commands: this.config.commandBus!, kernel: this.config.kernel,
            title: this.config.title, operations: store.ledger(), targetSelection: true, independentCalls: !this.config.readOnly, instructionQueue: true, contextSelection: true,
            get readOnly() {return !!owner.config.readOnly;}, branch: () => this.config.sessionManager.getSnapshot?.().view?.manifest.currentBranch ?? store.branch,
            selectors: () => this.selectors(), executionOverrides: input => this.overrides(input),
            resolveSubmission: id => this.submissions.get(id),
            prepareSend: async () => {
                const submission = await this.resolveSubmission(); this.checkAlive();
                if (submission && binding.operations.getSnapshot().some(record => record.context.operationId === submission.id)) return null;
                return {operationId: submission?.id ?? randomUUID(), viewId: binding.source.getSnapshot().viewId};
            },
            prepareRequest: (request, input) => this.prepare(request, input, store, signal),
            hasCommittedSubmission: submission => this.config.commandBus!.execute(SessionCommand.HasCommittedSubmission, {sessionId: this.config.sessionId, submission}),
            openOutputs: taskId => openSessionFlowOutputs(this.config.commandBus!, this.config.sessionId, signal, taskId),
            openChild: id => this.config.hostContext?.navigate({target: 'chat', resourceId: id}),
            interactionDrafts: new InteractionDraftPersistence(this.service), onError: error => this.fail(error)});
        return binding;
    }
    private async initialDraft(store: SessionChatStore, binding: Binding): Promise<ComposerDraft> {
        const draft = store.draft; if (draft.target) return draft;
        const groups = this.config.sessionManager.getSessions(), previous = [...groups].reverse().find(group => group.target)?.target;
        const agentId = this.config.initialInputState?.agentId ?? (await this.service.getUIState(this.config.sessionId))?.branchDrafts?.[store.branch]?.inputAgentId;
        const choices = binding.source.getSnapshot().callTargets?.entries ?? [];
        const target = previous ?? choices.find(choice => choice.target.kind === 'agent' && choice.target.id === agentId)?.target ?? choices[0]?.target;
        return {...draft, ...(target ? {target} : {})};
    }
    private viewOptions(store: SessionChatStore, draft: ComposerDraft): ImageChatOptions {
        return {locale: getLocale(), initialDraft: draft, markdown: messageMarkdown(this.config, id => this.messageAnchor(id)),
            assets: createAssetProvider(undefined, undefined, this.config.assets), upload: this.config.assets ? store.upload.bind(store) : undefined,
            saveDraft: value => this.save(store, value), onDraftChange: () => this.emit('interactiveChange', undefined),
            onError: error => this.fail(error), onDiagnostic: event => log.info('chat.operation', {...event, sessionId: this.config.sessionId}),
            onBindingDiagnostic: event => log.info('chat.binding', {...event, sessionId: this.config.sessionId}),
            mountHeader: root => this.toolbar(root)};
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
        if (this.suspended) return;
        if (this.closed) throw new Error('Session draft binding expired');
        await store.save(draft); this.emit('saved', undefined);
    }
    private overrides(input: ChatSubmission): NonNullable<SubmissionRequest['overrides']> {
        const selection = input.selection;
        const modelTier = selection?.modelTier ?? this.settings.modelTier;
        return {executionMode: selection?.executionMode === 'agent' ? 'agent' : selection?.executionMode === 'chat' ? 'chat' : this.settings.executionMode,
            connectionId: selection && 'connectionId' in selection ? selection.connectionId || undefined : this.settings.connectionId,
            ...(modelTier && modelTier !== 'auto' ? {modelTier: modelTier as 'optimal' | 'standard' | 'fast'} : {}),
            ...(this.settings.reasoningEffort && this.settings.reasoningEffort !== 'auto' ? {reasoningEffort: this.settings.reasoningEffort} : {})};
    }
    private selectors(): SelectorView[] {
        const auto = {id: '', label: t('chatSettings.followDefault')};
        return [{id: 'connectionId', label: t('chatInput.model'), value: this.settings.connectionId ?? '', choices: [auto,
            ...this.connections.filter(connection => connection.enabled && connection.credentialsReady !== false && connection.hasTiers).map(connection => ({id: connection.id, label: connection.name}))]},
            {id: 'modelTier', label: t('chatSettings.tier'), value: this.settings.modelTier ?? 'auto', choices: [{id: 'auto', label: auto.label},
                ...(['optimal', 'standard', 'fast'] as const).map(id => ({id, label: id}))]},
            {id: 'executionMode', label: t('chatInput.executionMode.agent'), value: this.settings.executionMode ?? 'chat', disabled: this.settings.executionModeLocked,
                choices: [{id: 'chat', label: t('chatInput.executionMode.chat')}, {id: 'agent', label: t('chatInput.executionMode.agent')}]}];
    }
    private toolbar(root: HTMLElement) {
        const releases: (() => void)[] = [], previous = new Set(root.childNodes);
        const runs = new SessionRunsPanel(this.config.commandBus!, this.config.sessionId, root);
        this.sessionRunsPanel = runs; if (!this.active) runs.setVisible(false); releases.push(() => runs.destroy());
        for (const [mount, className] of [[this.config.mountCompactNavigation, 'llm-chat__compact-navigation']] as const) {
            if (!mount) continue; const slot = document.createElement('div'); slot.className = className;
            if (className) slot.dataset.editorMobileNavigation = 'embedded'; root.append(slot); releases.push(mount(slot), () => slot.remove());
        }
        if (this.config.hostContext?.toggleSidebar) {const button = document.createElement('button'); button.type = 'button'; presentHostControl(button, t('chat.toolbar.sidebar'), ACTION_ICONS.sidebar);
            button.classList.add('llm-chat__sidebar'); button.onclick = () => this.config.hostContext!.toggleSidebar(); root.append(button);}
        const branches = document.createElement('select'); branches.className = 'llm-chat__branch'; branches.setAttribute('aria-label', t('flow.output.branch')); root.append(branches);
        const refresh = async () => {const manifest = await this.service.getManifest(this.config.sessionId); if (this.closed || !branches.isConnected) return;
            branches.replaceChildren(...Object.keys(manifest.branches).map(name => {const option = document.createElement('option'); option.value = name; option.textContent = name; return option;})); branches.value = this.branch;};
        void refresh().catch(error => this.fail(error));
        branches.onchange = () => {void this.switchBranch(branches.value).catch(error => {branches.value = this.branch; this.fail(error);});};
        const menu = document.createElement('details'), label = document.createElement('summary'), body = document.createElement('div');
        menu.className = 'llm-chat__host-menu'; presentHostControl(label, t('chat.toolbar.more'), CHAT_ICONS.more); menu.append(label, body); root.append(menu);
        for (const mount of [this.config.mountWindowList, this.config.mountConversationNavigation, this.config.mountMoreMenu]) {
            if (mount) releases.push(mount(body));
        }
        const owned = [...root.childNodes].filter(node => !previous.has(node));
        return {destroy: () => {try {releases.forEach(release => release());} finally {owned.forEach(node => node.remove());}}};
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
        this.active = true; this.sessionRunsPanel?.setVisible(true); this.view?.setActive(true); await this.binding?.refreshTargets();
    }
    setReadOnly(value: boolean): void {this.config.readOnly = value; void this.binding?.refreshTargets();}
    captureRecovery(): unknown {return this.view?.getDraft();}
    restoreRecovery(state: unknown): void {if (JSON.stringify(state) !== JSON.stringify(this.view?.getDraft())) throw Object.assign(new Error('Chat draft requires the retained view'), {code: 'RECOVERY_BUSY'});}
    suspendForRecovery(): void {this.suspended = true; this.store?.suspend(); this.cancelPendingRender();}
    destroy(): Promise<void> {
        return this.destroying ??= disposeEditorResources([() => this.flushPendingSave(),
            () => {this.closed = true; this.lifetime.abort();}, () => this.ownsView ? this.view?.destroy() : undefined,
            () => {this.binding?.dispose(); this.sessions.dispose(); this.events.clear();}]);
    }
    get commands() {return {takeViewOwnership: () => {this.ownsView = true; this.handoff = undefined;},
        preparedSubmission: () => this.resolveSubmission(),
        sendMessage: async (input: {text: string; files?: File[]; target?: import('@itookit/llm-flow/contracts').TargetRef}) => {
        if (!this.active || this.closed || this.config.readOnly) throw new Error('Session input unavailable');
        this.view!.setText(input.text); if (input.files?.length) await this.view!.addFiles(input.files); await this.view!.submit();
    }};}
    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]): void {for (const listener of this.events.get(event) ?? []) listener(payload);}
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {const listener = (payload: unknown) => callback(payload as EditorEventMap[E]);
        const listeners = this.events.get(event) ?? new Set(); listeners.add(listener); this.events.set(event, listeners); return () => {listeners.delete(listener);};}
}
