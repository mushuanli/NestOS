import {prepareRemoteAttachments} from '../remote-attachments';
import { DraftSaveQueue } from './draft-save-queue';
import { LayoutTemplates } from '../../components/templates/LayoutTemplates';
import { DraftDataCodec } from './session-draft-data';
import type { IChatInputConfig } from '../../domain/ports/IChatInputPresenter';
import { IEditor, Toast, type EditorOptions, type OcrControls } from '@itookit/ui-common';
import { randomUUID, t } from '@itookit/common';
import { ChatInput } from '../../components/input/ChatInputView';
import { EventBinder } from '../EventBinder';
import { buildExecutorOptions, buildConnectionOptions } from '../AgentProvider';
import {prepareAgentFlow, prepareCallTarget} from '../../flows/agent-flow';
import {SessionCommand} from '@itookit/llm-session/contracts';
import type { SendMessageParams } from '../../commands/SendMessageCommand';
import {SubmissionFeedback} from '../../components/history/SubmissionFeedback';
import { mountDraftProjectScope } from './draft-project-scope';
import type {WorkspaceHandoff} from './workspace-handoff';
import type {ChatInputOptions} from '../../components/input/ChatInputView';
import {EventBus} from '@itookit/vfs-core';
import {disposeEditorResources} from '../editor-disposal';
import {inheritDraftPreferences} from './draft-preferences';
import type {SessionDraftPreferences, EditorFactory} from '@itookit/ui-common';
import type {EditorEvent, EditorEventMap, EditorEventCallback} from '@itookit/ui-common';

/** Reuse the chat composer while persisting project drafts independently from Session history. */
export class SessionDraftEditor extends IEditor {
    private delegate?: IEditor;
    private resume?: (createEditor?: EditorFactory) => Promise<IEditor>;
    private confirmed = false;
    private binding?: Promise<Awaited<ReturnType<NonNullable<EditorOptions['sessionDraft']>['materialize']>>>;
    private menuNodes: Node[] = [];
    private draftMenuNodes: Node[] = [];
    private toolbarDefaults: Array<[HTMLElement, boolean]> = [];
    private readonly editorEvents = new EventBus<EditorEventMap>();
    private delegateStops: Array<() => void> = [];
    private codec: DraftDataCodec;
    private input?: ChatInput;
    private closed = false;
    private destroying?: Promise<void>;
    private active = true;
    private sending = false;
    private restoring = true;
    private readonly saves = new DraftSaveQueue(data => this.options.sessionDraft?.save?.(data) ?? Promise.resolve(), error => {
        if (this.closed || this.confirmed || !this.status) return;
        this.status.hidden = !error;
        if (error) this.status.textContent = t('project.draftSaveFailed');
    });
    private config?: IChatInputConfig;
    private initialData?: string;
    private unsubscribeConnections?: () => void;
    private configurationRevision = 0;
    private status?: HTMLElement;
    private submission?: SubmissionFeedback;
    private editRevision = 0;
    private refreshing?: Promise<void>;
    private events?: EventBinder;
    private projectScope?: ReturnType<typeof mountDraftProjectScope>;
    private readonly beforeUnload = (event: BeforeUnloadEvent) => {
        if (this.confirmed || !this.saves.dirty) return;
        event.preventDefault(); event.returnValue = '';
    };
    constructor(private container: HTMLElement, private service: Parameters<typeof buildExecutorOptions>[0], private options: EditorOptions<import('@itookit/llm-flow/contracts').SessionSubmission>,
        private readonly ocr?: OcrControls,
        private readonly createConversation?: (container: HTMLElement, options: EditorOptions, workspace: WorkspaceHandoff) => Promise<IEditor>,
        private readonly flowControls?: { commands?: import('@itookit/llm-session/contracts').ICommandBus; configuration?: import('@itookit/kernel-adapters/contracts').ChatConfigurationView }) {
        super(); this.initialData = options.sessionDraft?.initialData; this.codec = new DraftDataCodec(options.sessionDraft?.attachments);
    }
    async init(container: HTMLElement): Promise<void> { this.container = container; await this.render(); }
    async render(): Promise<void> {
        if (this.delegate) return;
        const saved = await this.codec.decode(this.initialData);
        this.config = saved.config;
        const agents = await this.executors();
        const changedAgent = !!this.options.sessionDraft?.executorScope && !!saved.config && !saved.config.target && !agents.some(agent => agent.id === saved.config!.agentId);
        if (changedAgent) saved.config!.agentId = agents[0]?.id ?? 'remote:unavailable';
        this.options.signal?.throwIfAborted(); if (this.closed) return;
        this.initLayout();
        const input = this.container.querySelectorAll<HTMLElement>('#llm-ui-input')[0]!;
        this.input = this.createInput(input, agents, saved.config);
        if (this.options.sessionDraft?.executorScope === 'remote' && !agents.length) {
            this.input.setAvailability({canSend: false, canInterrupt: false});
            this.status!.hidden = false; this.status!.textContent = t('agentWorkspace.noRemoteExecutor');
        }
        if (this.options.sessionDraft?.scope) this.projectScope = mountDraftProjectScope(input, this.options.sessionDraft.scope,
            () => this.saves.flush(), () => {
                const config = this.input?.getConfig();
                return config ? {agentId: config.agentId, settings: {...config.settings}} : undefined;
            });
        this.unsubscribeConnections?.();
        this.bindConfiguration();
        if (saved.config) this.input.restoreDraft(saved.config.text, saved.files, saved.config.agentId, saved.config.draftToken);
        this.restoring = false;
        if ((saved.migrated || changedAgent) && saved.config) { this.persist(saved.config, saved.files); await this.saves.flush(); }
        window.addEventListener('beforeunload', this.beforeUnload);
        if (this.active) this.input.focus();
    }
    private createInput(input: HTMLElement, agents: Awaited<ReturnType<typeof buildExecutorOptions>>, config?: IChatInputConfig): ChatInput {
        return new ChatInput(input, {flushDraft: () => this.saves.flush(),
            persistImageFiles: async (files, resize) => {
                if (!this.input) return;
                const config = this.input.getConfig();
                this.persist({...config, settings: {...config.settings, imageResize: resize}}, files);
                await this.saves.flush();
            },
            nativeModels: this.options.remoteAgents?.models, initialAgents: agents, ocr: this.ocr,
            initialConfig: config ?? (this.options.sessionDraft?.executorScope === 'remote' ? {agentId: agents[0]?.id ?? 'remote:unavailable'} : undefined), executorUsage: this.options.executorUsage,
            onConfigureExecutor: this.options.hostContext?.navigate ? () => {
                const config = this.input!.getConfig();
                void this.options.hostContext!.navigate(config.target?.kind === 'flow' ? {target: 'flows', resourceId: config.target.id}
                    : {target: 'agents', resourceId: this.service.getAgentResourceId?.(config.agentId)});
            } : undefined,
            onDraftChange: (config, files) => { if (!this.restoring && !this.sending) this.persist(config, files); },
            onRequestConnections: () => buildConnectionOptions(this.service), onStop: () => {},
            prepareAgentFlow: this.flowControls?.commands ? (agent, signal, draft) => prepareAgentFlow(this.flowControls!.commands!, agent, signal, draft) : undefined,
            ...(this.flowControls?.commands && this.options.sessionDraft?.executorScope !== 'remote' ? {
                requestCallTargets: () => this.flowControls!.commands!.execute<import('@itookit/llm-session/contracts').RootTargetCatalog>(SessionCommand.ListTargets),
                prepareCallTarget: (target: import('@itookit/llm-session/contracts').RootCallTarget, signal: AbortSignal,
                    draft: import('../../flows/agent-flow').AgentFlowDraftInput) => prepareCallTarget(this.flowControls!.commands!, target, signal, draft),
            } : {}),
            onSend: (text, files, agentId, overrides, target) => this.send({text, files, agentId, overrides, ...(target ? {target} : {})}),
            onNavigateSettings: ({resourceId, anchor}) => { void this.options.hostContext?.navigate?.({ target: 'settings', resourceId, ...(anchor ? {state: {anchor}} : {}) }); },
        });
    }
    private initLayout(): void {
        this.projectScope?.destroy(); this.projectScope = undefined;
        this.events?.cleanup();
        this.container.classList.add('llm-ui-workspace');
        this.container.innerHTML = LayoutTemplates.renderWorkspace(t('project.createSession'));
        const title = this.container.querySelectorAll<HTMLInputElement>('#llm-title-input')[0]!;
        title.readOnly = true;
        this.status = this.container.querySelectorAll<HTMLElement>('#llm-status-indicator')[0]!;
        this.status.setAttribute('role', 'status'); this.status.hidden = true;
        this.container.querySelectorAll<HTMLElement>('#llm-ui-history')[0]!.innerHTML = LayoutTemplates.renderWelcome();
        this.submission = new SubmissionFeedback(this.container.querySelectorAll<HTMLElement>('#llm-ui-history')[0]!, {htmlPolicy: 'literal'});
        this.container.querySelectorAll<HTMLButtonElement>('#llm-btn-sidebar')[0]!.hidden = !this.options.hostContext?.toggleSidebar;
        this.toolbarDefaults = [...this.container.querySelectorAll<HTMLElement>('.llm-workspace-titlebar button')].map(node => [node, node.hidden]);
        for (const id of ['llm-btn-prompt-nav', 'llm-btn-collapse']) this.container.querySelectorAll<HTMLElement>('#' + id)[0]!.hidden = true;
        for (const prompt of this.container.querySelectorAll<HTMLButtonElement>('.llm-ui-welcome__prompt')) {
            prompt.onclick = () => {
                if (!this.input) return;
                const text = [this.input.getConfig().text, prompt.dataset.prompt].filter(Boolean).join('\n');
                this.input.restoreInput(text);
                const textarea = this.container.querySelector<HTMLTextAreaElement>('.llm-input__textarea');
                textarea?.dispatchEvent(new Event('input', { bubbles: true }));
            };
        }
        const actions = this.container.querySelector<HTMLElement>('.llm-workspace-titlebar__menu-actions')!;
        const discard = document.createElement('button'); discard.type = 'button';
        discard.className = 'llm-workspace-titlebar__btn llm-workspace-titlebar__btn--text';
        discard.textContent = t('project.draftDiscard');
        discard.onclick = () => { void this.discard().catch(error => Toast.error(String(error))); };
        this.menuNodes = [...actions.childNodes]; actions.replaceChildren(discard);
        if (this.options.hostContext?.navigate) {
            const flows = document.createElement('button'); flows.type = 'button'; flows.dataset.action = 'open-flows';
            flows.className = 'llm-workspace-titlebar__btn llm-workspace-titlebar__btn--text';
            flows.textContent = t('chatInput.target.flow'); flows.onclick = () => { void this.openFlows().catch(error => Toast.error(String(error))); };
            actions.prepend(flows);
        }
        this.draftMenuNodes = [...actions.childNodes];
        this.bindDraftEvents();
    }
    private bindDraftEvents(): void {
        this.events = new EventBinder(this.container, {mountCompactNavigation: this.options.mountCompactNavigation,
            onToggleSidebar: () => this.options.hostContext?.toggleSidebar()});
        this.events.bindTitleBarEvents();
    }
    private persist(config: IChatInputConfig, files: File[]): void {
        ++this.editRevision;
        this.config = structuredClone(config);
        if (!this.options.sessionDraft?.save) return;
        this.status!.hidden = true;
        this.saves.save(this.codec.encode(config, files));
    }
    private async openFlows(): Promise<void> {
        if (this.closed || this.sending) return;
        await this.saves.flush();
        if (!this.closed) await this.options.hostContext?.navigate({target: 'flows'});
    }
    private async send(message: SendMessageParams): Promise<void | false> {
        if (this.closed || this.sending || (!message.text.trim() && !message.files.length
            && message.target?.kind !== 'flow' && !message.overrides?.flowExpectedSignature && !message.overrides?.flowId)) return;
        const captured = this.input?.getConfig();
        if (!message.draftConfig && captured?.draftToken && captured.text.trim() === message.text.trim())
            message = {...message, draftConfig: structuredClone(captured)};
        const nativeSelection = this.input?.getNativeModelSelection?.();
        if (this.confirmed) {
            this.sending = true;
            try {
                const target = await this.bindConversation(message.agentId); return await target.editor.commands.sendMessage!({...message, ...(nativeSelection ? {nativeSelection} : {})});
            }
            catch (error) {Toast.error(error instanceof Error ? error.message : String(error)); return false;}
            finally {this.sending = false;}
        }
        const config = this.input?.getConfig();
        if (config) this.persist({...config, text: message.text, agentId: message.agentId ?? 'default', target: message.target}, message.files);
        this.sending = true; this.input!.setLoading(true); this.projectScope?.setDisabled(true);
        const feedback = {id: randomUUID(), text: message.text || t(message.target?.kind === 'flow' ? 'callable.target.flow' : 'harness.attachmentPrompt'), timestamp: Date.now(), state: 'submitting' as const};
        this.container.querySelector('.llm-ui-welcome')?.remove(); this.submission?.show(feedback);
        try {
            if (this.options.sessionDraft?.executorScope && (message.agentId?.startsWith('remote:') ?? false) !== (this.options.sessionDraft.executorScope === 'remote'))
                throw new Error(t('agentWorkspace.executorScopeMismatch'));
            if (message.agentId?.startsWith('remote:') && message.files.length) {
                const executor = (await this.executors()).find(item => item.id === message.agentId);
                await prepareRemoteAttachments(message.files, executor?.attachmentKinds ?? []);
            }
            await this.saves.flush();
            if (this.options.sessionDraft?.inPlace) {
                const target = await this.bindConversation(message.agentId);
                if (target.resumeOnly) {Toast.info(t('project.draftResume')); return false;}
                return await target.editor.commands.sendMessage!({...message, ...(nativeSelection ? {nativeSelection} : {}), ...(target.submission ? {submission: target.submission} : {})});
            }
            if (message.agentId?.startsWith('remote:')) {
                if (!this.options.remoteAgents) throw new Error(t('toolbox.unavailable'));
                const selected = nativeSelection;
                if (message.files.length) await this.options.remoteAgents.send(message.agentId, message.text, selected, message.files);
                else if (selected) await this.options.remoteAgents.send(message.agentId, message.text, selected);
                else await this.options.remoteAgents.send(message.agentId, message.text);
                await this.options.sessionDraft?.clear?.();
                this.initialData = '';
                if (!this.closed && this.input) {
                    const latest = this.input.getConfig();
                    if (latest.text === message.text) this.input.setConfig({text: ''});
                    else {this.persist(latest, []); await this.saves.flush();}
                }
                return;
            }
            const target = await this.options.sessionDraft!.materialize();
            const editor = target.editor;
            if (!editor.commands.sendMessage) throw new Error('Chat editor cannot send messages');
            if (target.resumeOnly) {
                Toast.info(t('project.draftResume')); return;
            }
            const submission = target.submission;
            if (await editor.commands.sendMessage(submission ? { ...message, submission } : message) === false) return false;
        } catch (error) {
            if (!this.closed) this.submission?.show({...feedback, state: 'failed', error: error instanceof Error ? error.message : String(error)});
            if (!this.closed && (!this.options.sessionDraft?.inPlace || this.input?.getConfig().text === message.text))
                this.input?.restoreDraft(message.text, message.files, message.agentId ?? 'default');
            Toast.error(error instanceof Error ? error.message : String(error));
            if (message.agentId?.startsWith('remote:')) throw error;
            return false;
        } finally { this.sending = false; if (!this.closed) { if (!this.delegate) this.input?.setLoading(false); this.projectScope?.setDisabled(false); } }
    }
    private bindConversation(agentId?: string): NonNullable<SessionDraftEditor['binding']> {
        return this.binding ??= (async () => {
            const rollback = this.input!.checkpoint();
            const workspace: WorkspaceHandoff = {input: this.input!, prepare: () => this.prepareDraftView(),
                release: () => this.releaseDraftView(), configure: options => this.conversationInput(options)};
            const createEditor: EditorFactory | undefined = this.createConversation
                ? (container, options) => this.createConversation!(container, options, workspace) : undefined;
            try {
                const target = this.resume ? {editor: await this.resume(createEditor), resumeOnly: false}
                    : await this.options.sessionDraft!.materialize({container: this.container, agentId, createEditor});
                if (this.closed) {await target.editor.destroy(); throw new Error('Draft closed');}
                this.delegate = target.editor;
                if (!this.active) target.editor.cancelPendingRender?.();
                for (const event of ['interactiveChange', 'saved', 'saveError', 'change', 'contentLoaded', 'ready', 'modeChanged',
                    'blur', 'focus', 'optimisticUpdate', 'error', 'blocksCollapsed', 'blocksExpanded'] as const)
                    this.delegateStops.push(target.editor.on(event, payload => this.editorEvents.emit(event, payload)));
                return target;
            } catch (error) {
                this.binding = undefined; if (!this.closed) {rollback(); this.restoreDraftView();}
                throw error;
            }
        })();
    }
    private releaseDraftView(): void {
        this.unsubscribeConnections?.(); this.unsubscribeConnections = undefined;
        this.events?.cleanup(); this.events = undefined;
        this.prepareDraftView();
        void this.submission?.destroy(); this.submission = undefined;
    }
    private prepareDraftView(): void {
        this.container.querySelector('.llm-workspace-titlebar__menu-actions')!.replaceChildren(...this.menuNodes);
        for (const [node, hidden] of this.toolbarDefaults) node.hidden = hidden;
        for (const prompt of this.container.querySelectorAll<HTMLElement>('.llm-ui-welcome__prompt')) prompt.onclick = null;
    }
    private restoreDraftView(): void {
        this.container.classList.add('llm-ui-workspace');
        this.events?.cleanup();
        this.container.querySelector('.llm-workspace-titlebar__menu-actions')!.replaceChildren(...this.draftMenuNodes);
        const title = this.container.querySelector<HTMLInputElement>('#llm-title-input')!;
        title.value = t('project.createSession'); title.readOnly = true;
        for (const id of ['llm-btn-prompt-nav', 'llm-btn-collapse']) {
            const button = this.container.querySelector<HTMLElement>('#' + id); if (button) button.hidden = true;
        }
        const history = this.container.querySelector<HTMLElement>('#llm-ui-history')!;
        history.innerHTML = LayoutTemplates.renderWelcome(); this.submission = new SubmissionFeedback(history, {htmlPolicy: 'literal'});
        this.bindDraftEvents();
        if (!this.unsubscribeConnections) this.bindConfiguration();
    }
    private conversationInput(options: ChatInputOptions): ChatInputOptions {
        return {...options, onDraftChange: (config, files) => {
            if (!this.confirmed) this.persist(config, files);
            options.onDraftChange?.(config, files);
        }, onSend: async (...args) => {if (!this.confirmed) await this.saves.flush(); return options.onSend(...args);}};
    }
    private confirmDraft(): void {
        if (this.closed || this.confirmed) return;
        this.confirmed = true; this.projectScope?.destroy(); this.projectScope = undefined;
        window.removeEventListener('beforeunload', this.beforeUnload);
    }
    private async discard(): Promise<void> {
        if (this.sending) return;
        await this.saves.flush();
        await this.options.sessionDraft?.clear?.();
        await this.submission?.destroy();
        this.input?.destroy();
        this.initialData = '';
        this.codec = new DraftDataCodec(this.options.sessionDraft?.attachments);
        this.restoring = true;
        await this.render();
    }
    get commands() {return {...this.delegate?.commands,
        sendMessage: (message: SendMessageParams) => this.confirmed && this.delegate ? this.delegate.commands.sendMessage?.(message)
            : this.send(this.currentMessage(message)),
        confirmDraft: async (resume?: (createEditor?: EditorFactory) => Promise<IEditor>) => {
            this.resume ??= resume; this.confirmDraft();
            if (!this.delegate) await this.bindConversation();
        }, inheritDraftPreferences: (preferences: SessionDraftPreferences) => this.inheritPreferences(preferences),
        refreshDraft: () => this.refreshDraft(), selectDraftAgent: async (id: string) => {
        if (this.closed || this.sending) throw new Error(t('chatInput.switchUnavailable'));
        const agents = await this.executors();
        if (this.closed || this.sending) throw new Error(t('chatInput.switchUnavailable'));
        if (!agents.some(agent => agent.id === id)) throw new Error(t('toolbox.unavailable'));
        this.input?.setExecutorChoices(agents, id); await this.saves.flush();
    }, appendDraft: async (input: {text: string; files: File[]}) => {
        if (this.closed || this.sending) throw new Error(t('chatInput.switchUnavailable'));
        this.input?.appendDraft(input); await this.saves.flush();
    }}};
    private currentMessage(message: SendMessageParams): SendMessageParams {
        const config = this.input?.getConfig();
        const target = message.target ?? (message.agentId === undefined || message.agentId === '' ? config?.target : undefined);
        return {...message, ...(target ? {target} : {}), agentId: target?.kind === 'flow' ? '' : message.agentId ?? config?.agentId, files: message.files ?? []};
    }
    getText(): string { return this.delegate?.getText() ?? this.input?.getConfig().text ?? this.config?.text ?? ''; }
    private async inheritPreferences(preferences: SessionDraftPreferences): Promise<void> {
        if (this.closed || this.confirmed || this.delegate || this.sending || !this.input) return;
        const revision = this.editRevision;
        const remote = this.options.sessionDraft?.executorScope === 'remote';
        const [agents, connections] = await Promise.all([this.executors(), remote ? [] : buildConnectionOptions(this.service)]);
        if (this.closed || !this.active || this.confirmed || this.delegate || this.sending || revision !== this.editRevision) return;
        const current = this.input.getConfig();
        const config = inheritDraftPreferences(current, preferences, agents, connections, remote);
        this.input.setExecutorChoices(agents, config.agentId);
        this.input.setConfig(config);
        this.container.querySelector('.llm-input__textarea')?.dispatchEvent(new Event('input', {bubbles: true}));
        await this.saves.flush();
    }
    private bindConfiguration(): void {
        const changed = () => { void this.refreshInputConfiguration().catch(error => console.error('[SessionDraft] Agent availability refresh failed', error)); };
        this.unsubscribeConnections = this.flowControls?.configuration?.subscribe(changed) ?? this.service.onChange(changed);
    }
    private async refreshInputConfiguration(): Promise<void> {
        const input = this.input;
        const revision = ++this.configurationRevision;
        if (!input || this.closed || this.confirmed || !this.active) return;
        const agents = await this.executors();
        if (this.closed || this.confirmed || !this.active || input !== this.input || revision !== this.configurationRevision) return;
        input.refreshAgents(agents, id => agents.some(agent => agent.id === id) ? id : 'default');
        await input.refreshConnections();
        await input.refreshCallTargets?.();
    }
    private executors(): Promise<Awaited<ReturnType<typeof buildExecutorOptions>>> {
        const scope = this.options.sessionDraft?.executorScope;
        return scope === 'remote' ? this.options.remoteAgents?.list() ?? Promise.resolve([])
            : buildExecutorOptions(this.service, scope === 'local' ? undefined : this.options.remoteAgents, this.flowControls?.configuration?.getConfigurationSnapshot());
    }
    setText(text: string): void {
        if (this.confirmed) {this.delegate?.setText(text); return;}
        this.input?.setConfig({ text });
        this.container.querySelector('.llm-input__textarea')?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    getMode(): 'edit' | 'render' { return this.delegate?.getMode() ?? 'edit'; }
    async switchToMode(mode: 'edit' | 'render'): Promise<void> {await this.delegate?.switchToMode(mode);}
    setTitle(title: string): void {
        if (this.delegate) this.delegate.setTitle(title);
        else {const input = this.container.querySelector<HTMLInputElement>('#llm-title-input'); if (input) input.value = title;}
    }
    setReadOnly(readOnly: boolean): void {if (this.delegate) this.delegate.setReadOnly(readOnly); else this.input?.setLoading(readOnly);}
    isDirty(): boolean { return !this.confirmed && this.saves.dirty || !!this.delegate?.isDirty(); }
    captureRecovery(): unknown {
        if (this.delegate) return this.delegate.captureRecovery?.();
        if (this.sending || this.binding || !this.input) throw Object.assign(new Error(t('httpApp.recoveryBusy')), {code: 'RECOVERY_BUSY'});
        return {draftId: this.options.sessionDraft?.id, input: this.input.captureRecovery()};
    }
    restoreRecovery(state: unknown): void {
        if (this.delegate) {this.delegate.restoreRecovery?.(state); return;}
        const snapshot = state as {draftId?: string; input: unknown};
        if (snapshot.draftId !== this.options.sessionDraft?.id) throw Object.assign(new Error(t('httpApp.recoveryDraftChanged')), {code: 'RECOVERY_DRAFT_CHANGED'});
        this.input?.restoreRecovery(snapshot.input);
        this.config = this.input?.getConfig();
    }
    suspendForRecovery(): void {
        this.cancelPendingRender(); this.confirmed = true;
        this.delegate?.suspendForRecovery?.(); this.flushPendingSave = async () => {};
    }
    setDirty(dirty: boolean): void {this.delegate?.setDirty(dirty);}
    async navigateTo(...args: Parameters<IEditor['navigateTo']>): Promise<void> {await this.delegate?.navigateTo(...args);}
    async search(query: string): ReturnType<IEditor['search']> {return this.delegate?.search(query) ?? [];}
    gotoMatch(...args: Parameters<IEditor['gotoMatch']>): void {this.delegate?.gotoMatch(...args);}
    clearSearch(): void {this.delegate?.clearSearch();}
    async getHeadings(): ReturnType<IEditor['getHeadings']> {return this.delegate?.getHeadings() ?? [];}
    async getSearchableText(): Promise<string> {return this.delegate?.getSearchableText() ?? super.getSearchableText();}
    async getSummary(): Promise<string | null> {return this.delegate?.getSummary() ?? null;}
    async pruneAssets(): Promise<number | null> {return this.delegate?.pruneAssets() ?? null;}
    async collapseBlocks(): ReturnType<IEditor['collapseBlocks']> {return this.delegate?.collapseBlocks() ?? super.collapseBlocks();}
    async expandBlocks(): ReturnType<IEditor['expandBlocks']> {return this.delegate?.expandBlocks() ?? super.expandBlocks();}
    async toggleBlocks(): ReturnType<IEditor['toggleBlocks']> {return this.delegate?.toggleBlocks() ?? super.toggleBlocks();}
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {return this.editorEvents.on(event, payload => callback(payload));}
    focus(): void { this.input?.focus(); }
    async flushPendingSave(): Promise<void> { if (!this.confirmed) await this.saves.flush(); await this.delegate?.flushPendingSave?.(); }
    private refreshDraft(): Promise<void> {
        return this.refreshing ??= Promise.resolve().then(() => this.refreshDraftNow())
            .finally(() => {this.refreshing = undefined;});
    }
    private async refreshDraftNow(): Promise<void> {
        if (this.confirmed || this.delegate || this.closed || !this.active || this.sending || this.saves.dirty) return;
        const revision = this.editRevision, controls = this.options.sessionDraft;
        const next = await controls?.refresh?.();
        if (!next || this.closed || !this.active || this.sending || this.saves.dirty || revision !== this.editRevision || controls !== this.options.sessionDraft) return;
        this.input?.destroy(); await this.submission?.destroy();
        this.options.sessionDraft = next; this.initialData = next.initialData;
        this.codec = new DraftDataCodec(next.attachments); this.restoring = true;
        await this.render();
    }
    cancelPendingRender(): void {this.input?.cancelPendingSend(); this.input?.hideNativeModelPicker?.(); this.active = false; this.delegate?.cancelPendingRender?.();}
    async activate(): Promise<void> {
        this.active = true; await this.delegate?.activate?.(); await this.refreshDraft();
        await Promise.all([this.projectScope?.refresh(), this.refreshInputConfiguration()]);
    }
    destroy(): Promise<void> {
        this.closed = true;
        return this.destroying ??= disposeEditorResources([
            async () => {if (!this.confirmed) await this.saves.flush();},
            () => {this.projectScope?.destroy(); this.projectScope = undefined;},
            () => this.submission?.destroy(), () => this.unsubscribeConnections?.(),
            () => window.removeEventListener('beforeunload', this.beforeUnload), () => this.events?.cleanup(),
            () => this.delegate ? this.delegate.destroy() : this.input?.destroy(),
            ...this.delegateStops.splice(0), () => this.editorEvents.clear(), () => this.container.replaceChildren(),
        ]);
    }
}
