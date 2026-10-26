import {messageMarkdown} from '../independent/message-markdown';
import {createModuleLogger, escapeHTML, getLocale, t} from '@itookit/common';
import {BaseSettingsEditor, Toast, type EditorEvent, type EditorEventMap, type EditorEventCallback} from '@itookit/ui-common';
import type {ChatSubmission, ChatView, ComposerDraft, SelectorView} from '@itookit/llm-ui';
import {SessionCommand, type RootTargetCatalog, type SubmissionRequest} from '@itookit/llm-session/contracts';
import {createAssetProvider} from '@itookit/mdx-adapter';
import {createSessionChatBinding, createSessionChatView} from '../independent/session';
import {SessionChatStore} from '../independent/session-store';
import {prepareSessionChatRequest} from '../independent/session-submission';
import {SessionService, AssetService} from '../services';
import {InteractionDraftPersistence} from '../services/InteractionDraftPersistence';
import {buildConnectionOptions} from './AgentProvider';
import {openSessionFlowOutputs} from '../flows/session-output';
import type {LLMEditorOptions} from './LLMWorkspaceEditor';

const log = createModuleLogger('session-chat-editor');
type Binding = ReturnType<typeof createSessionChatBinding>;
/** The product shell adapts host capabilities to one shared ChatView. */
export class IndependentSessionEditor extends BaseSettingsEditor<LLMEditorOptions['sessionRepository']> {
    private readonly sessions: SessionService;
    private view?: ChatView;
    private binding?: Binding;
    private store?: SessionChatStore;
    private branch = 'main';
    private active = true;
    private closed = false;
    private suspended = false;
    private changing = false;
    private lifetime = new AbortController();
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    private connections: Awaited<ReturnType<typeof buildConnectionOptions>> = [];
    private settings: import('../domain/ports/IChatInputPresenter').ChatInputSettings = {};
    constructor(container: HTMLElement, private config: LLMEditorOptions) {
        super(container, config.sessionRepository, config);
        this.sessions = new SessionService(this.service, config.commandBus!);
    }
    async init(container: HTMLElement): Promise<void> {this.container = container; await this.render();}
    async render(): Promise<void> {
        const loaded = await this.sessions.loadSession(this.config.sessionId, this.config.title ?? '', this.config.target?.kind === 'session' ? this.config.target.branch : undefined, this.config.initialData);
        this.config.initialData = undefined; this.settings = loaded.settings;
        this.connections = await buildConnectionOptions(this.config.agentService);
        await this.mount(loaded.manifest.currentBranch);
        if (this.config.initialInputState?.text) this.view!.setText(this.config.initialInputState.text);
        this.emit('ready', undefined);
    }
    private async mount(branch: string): Promise<void> {
        this.config.signal?.throwIfAborted(); this.branch = branch;
        this.store = await SessionChatStore.open(this.service, this.config.sessionId, branch, new AssetService(this.config.assets));
        const owner = this;
        this.binding = createSessionChatBinding({session: this.config.sessionManager, commands: this.config.commandBus!, kernel: this.config.kernel,
            operations: this.store.ledger(), targetSelection: true, independentCalls: !this.config.readOnly, instructionQueue: true, contextSelection: true,
            get readOnly() {return !!owner.config.readOnly;}, branch: () => this.config.sessionManager.getSnapshot?.().view?.manifest.currentBranch ?? this.branch,
            selectors: () => this.selectors(), executionOverrides: input => this.overrides(input),
            prepareRequest: (request, input) => this.prepare(request, input),
            hasCommittedSubmission: submission => this.config.commandBus!.execute(SessionCommand.HasCommittedSubmission, {sessionId: this.config.sessionId, submission}),
            openChild: id => this.config.hostContext?.navigate({target: 'chat', resourceId: id}),
            interactionDrafts: new InteractionDraftPersistence(this.service), onError: error => this.fail(error)});
        await this.binding.refreshTargets();
        let draft = this.store.draft;
        if (!draft.target) {
            const groups = this.config.sessionManager.getSessions(), previous = [...groups].reverse().find(group => group.target)?.target;
            const agentId = this.config.initialInputState?.agentId ?? (await this.service.getUIState(this.config.sessionId))?.branchDrafts?.[branch]?.inputAgentId;
            const choices = this.binding.source.getSnapshot().callTargets?.entries ?? [];
            const target = previous ?? choices.find(choice => choice.target.kind === 'agent' && choice.target.id === agentId)?.target ?? choices[0]?.target;
            draft = {...draft, ...(target ? {target} : {})};
        }
        this.view = await createSessionChatView(this.container, this.binding, {locale: getLocale(), initialDraft: draft, markdown: messageMarkdown(this.config),
            assets: createAssetProvider(undefined, undefined, this.config.assets), upload: this.config.assets ? this.store.upload.bind(this.store) : undefined,
            saveDraft: draft => this.save(draft), onDraftChange: () => this.emit('interactiveChange', undefined),
            onError: error => this.fail(error), onDiagnostic: event => log.info('chat.operation', {...event, sessionId: this.config.sessionId, branch}),
            mountToolbar: root => this.toolbar(root)});
        if (!this.active) this.view.setActive(false);
    }
    private async prepare(request: SubmissionRequest, input: ChatSubmission): Promise<SubmissionRequest> {
        if (!this.current() || this.config.readOnly) throw new Error('Session input binding expired');
        const catalog = await this.config.commandBus!.execute<RootTargetCatalog>(SessionCommand.ListTargets);
        const choice = catalog.entries.find(choice => choice.target.kind === request.expectedTarget?.kind && choice.target.id === request.expectedTarget.id
            && choice.target.version === request.expectedTarget.version && choice.target.digest === request.expectedTarget.digest);
        if (!choice) throw new Error(t('callable.catalog.changed'));
        return prepareSessionChatRequest({commands: this.config.commandBus!, agents: this.config.agentService, choice, request, input,
            files: await this.store!.files(input.attachments, this.lifetime.signal), assets: this.config.assets, signal: this.lifetime.signal});
    }
    private current(): boolean {return !this.closed && this.config.sessionManager.id === this.config.sessionId
        && (this.config.sessionManager.getSnapshot?.().view?.manifest.currentBranch ?? this.branch) === this.branch;}
    private async save(draft: ComposerDraft): Promise<void> {
        if (this.suspended) return;
        if (!this.current()) throw new Error('Session draft binding expired');
        await this.store!.save(draft); this.emit('saved', undefined);
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
            {id: 'modelTier', label: t('chatInput.model'), value: this.settings.modelTier ?? 'auto', choices: [{id: 'auto', label: auto.label},
                ...(['optimal', 'standard', 'fast'] as const).map(id => ({id, label: id}))]},
            {id: 'executionMode', label: t('chatInput.executionMode.agent'), value: this.settings.executionMode ?? 'chat', disabled: this.settings.executionModeLocked,
                choices: [{id: 'chat', label: t('chatInput.executionMode.chat')}, {id: 'agent', label: t('chatInput.executionMode.agent')}]}];
    }
    private toolbar(root: HTMLElement) {
        const releases: (() => void)[] = [];
        for (const mount of [this.config.mountCompactNavigation, this.config.mountWindowList, this.config.mountConversationNavigation]) {
            if (!mount) continue; const slot = document.createElement('div'); root.append(slot); releases.push(mount(slot), () => slot.remove());
        }
        if (this.config.hostContext?.toggleSidebar) {const button = document.createElement('button'); button.type = 'button'; button.textContent = t('chat.toolbar.sidebar');
            button.onclick = () => this.config.hostContext!.toggleSidebar(); root.append(button);}
        const branches = document.createElement('select'); branches.setAttribute('aria-label', t('flow.output.branch')); root.append(branches);
        const refresh = async () => {const manifest = await this.service.getManifest(this.config.sessionId); if (this.closed || !branches.isConnected) return;
            branches.replaceChildren(...Object.keys(manifest.branches).map(name => {const option = document.createElement('option'); option.value = name; option.textContent = name; return option;})); branches.value = this.branch;};
        void refresh().catch(error => this.fail(error));
        branches.onchange = () => {void this.switchBranch(branches.value).catch(error => {branches.value = this.branch; this.fail(error);});};
        const menu = document.createElement('details'), label = document.createElement('summary'), body = document.createElement('div');
        label.textContent = t('chat.toolbar.more'); menu.append(label, body); root.append(menu);
        if (this.config.mountMoreMenu) releases.push(this.config.mountMoreMenu(body));
        const outputs = document.createElement('button'); outputs.type = 'button'; outputs.textContent = t('flow.output.title');
        outputs.onclick = () => openSessionFlowOutputs(this.config.commandBus!, this.config.sessionId, this.lifetime.signal); body.append(outputs);
        return {destroy: () => releases.forEach(release => release())};
    }
    private async switchBranch(branch: string): Promise<void> {
        if (this.changing || this.closed || !this.active || branch === this.branch) return;
        this.changing = true;
        try {await this.flushPendingSave(); this.view?.setActive(false);
            await this.config.commandBus!.execute('vcs.branch.switch', {branchName: branch});
            this.lifetime.abort(); await this.view?.destroy(); this.binding?.dispose(); this.lifetime = new AbortController();
            this.view = undefined; this.binding = undefined; await this.mount(branch);
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
    cancelPendingRender(): void {this.active = false; this.view?.setActive(false);}
    async activate(): Promise<void> {
        if (this.closed) return;
        const snapshot = await this.config.commandBus!.execute<import('@itookit/llm-session/contracts').SessionSnapshot>(SessionCommand.Bind, {sessionId: this.config.sessionId});
        if (snapshot.view?.manifest.currentBranch && snapshot.view.manifest.currentBranch !== this.branch) {
            await this.view?.destroy(); this.binding?.dispose(); await this.mount(snapshot.view.manifest.currentBranch);
        }
        this.active = true; this.view?.setActive(true); await this.binding?.refreshTargets();
    }
    setReadOnly(value: boolean): void {this.config.readOnly = value; void this.binding?.refreshTargets();}
    captureRecovery(): unknown {return this.view?.getDraft();}
    restoreRecovery(state: unknown): void {if (JSON.stringify(state) !== JSON.stringify(this.view?.getDraft())) throw Object.assign(new Error('Chat draft requires the retained view'), {code: 'RECOVERY_BUSY'});}
    suspendForRecovery(): void {this.suspended = true; this.store?.suspend(); this.cancelPendingRender();}
    async destroy(): Promise<void> {if (this.closed) return; await this.flushPendingSave(); this.closed = true; this.lifetime.abort();
        try {await this.view?.destroy();} finally {this.binding?.dispose(); this.sessions.dispose(); this.events.clear();}}
    get commands() {return {sendMessage: async (input: {text: string; files?: File[]; target?: import('@itookit/llm-flow/contracts').TargetRef}) => {
        if (!this.active || this.closed || this.config.readOnly) throw new Error('Session input unavailable');
        this.view!.setText(input.text); if (input.files?.length) await this.view!.addFiles(input.files); await this.view!.submit();
    }};}
    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]): void {for (const listener of this.events.get(event) ?? []) listener(payload);}
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {const listener = (payload: unknown) => callback(payload as EditorEventMap[E]);
        const listeners = this.events.get(event) ?? new Set(); listeners.add(listener); this.events.set(event, listeners); return () => {listeners.delete(listener);};}
}
