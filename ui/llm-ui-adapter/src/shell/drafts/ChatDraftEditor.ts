import {workspaceInputPlugins} from '../workspace-input-plugins';
import {SharedChatOcr} from '../SharedChatOcr';
import {resolveResize} from '@itookit/image-parser';
import {prepareImageChatOptions} from '../../independent/image-chat-view';
import type {ImageEditingHost} from '../../independent/image-editing';
import {createChatView, createOperationLedger, type ChatOptions, type ChatView, type ChatSubmission, type ComposerDraft, type SelectorView, type SendPreparation} from '@itookit/llm-ui';
import {BaseSettingsEditor, Toast, type EditorOptions, type EditorFactory, type IEditor, type EditorEvent, type EditorEventMap, type EditorEventCallback} from '@itookit/ui-common';
import {createModuleLogger, getLocale, randomUUID, escapeHTML, t} from '@itookit/common';
import type {IAgentConfigService, ChatConfigurationView} from '@itookit/kernel-adapters/contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {SessionSubmission} from '@itookit/llm-flow/contracts';
import {ChatProjection} from '../../independent/projection';
import {SessionCallTargets} from '../../independent/session-targets';
import {chatSelectors, mountChatSettings} from '../chat-settings';
import {inheritDraftPreferences} from './draft-preferences';
import {ChatDraftStore} from './ChatDraftStore';
import type {RetainedWorkspaceHandoff} from './workspace-handoff';
import {mountDraftProjectScope} from './draft-project-scope';
import {buildConnectionOptions, buildExecutorOptions} from '../AgentProvider';
import {disposeEditorResources} from '../editor-disposal';
import type {SendMessageParams} from '../../commands/SendMessageCommand';

const log = createModuleLogger('chat-draft-editor');
type Options = EditorOptions<SessionSubmission>;
type Materialized = Awaited<ReturnType<NonNullable<Options['sessionDraft']>['materialize']>>;
/** The first submit transfers one ChatView to its formal controller before registering the operation. */
export class ChatDraftEditor extends BaseSettingsEditor<IAgentConfigService> {
    private view!: ChatView;
    private ocr?: SharedChatOcr;
    private imageHost?: ImageEditingHost;
    private store: ChatDraftStore;
    private source: ChatProjection;
    private readonly ledger = createOperationLedger();
    private readonly targets?: SessionCallTargets;
    private delegate?: IEditor;
    private prepared?: Promise<Materialized>;
    private resume?: (createEditor?: EditorFactory) => Promise<IEditor>;
    private closed = false;
    private active = true;
    private transferred = false;
    private rebuilding = false;
    private owned = true;
    private closing?: Promise<void>;
    private readonly beforeUnload = (event: BeforeUnloadEvent) => {
        if (this.transferred || !this.isDirty()) return;
        event.preventDefault(); event.returnValue = '';
    };
    private scope?: ReturnType<typeof mountDraftProjectScope>;
    private offConfiguration?: () => void;
    private configurationGeneration = 0;
    private readonly stops: (() => void)[] = [];
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    private connections: Awaited<ReturnType<typeof buildConnectionOptions>> = [];
    private readonly nativeModels = new Map<string, import('@itookit/ui-common').ConversationModelCatalog>();
    private executors: Awaited<ReturnType<typeof buildExecutorOptions>> = [];
    constructor(container: HTMLElement, agents: IAgentConfigService, private config: Options,
        private readonly factory: (container: HTMLElement, options: EditorOptions, handoff: RetainedWorkspaceHandoff) => Promise<IEditor>,
        private readonly controls: {commands?: ICommandBus; configuration?: ChatConfigurationView; ocr?: import('@itookit/ui-common').OcrControls}) {
        super(container, agents, config);
        if (!config.sessionDraft) throw new Error('Project draft controls are required');
        this.store = new ChatDraftStore(config.sessionDraft);
        this.source = new ChatProjection(config.sessionDraft.id ?? randomUUID(), error => this.emit('error', error));
        if (controls.commands && config.sessionDraft.executorScope !== 'remote') this.targets = new SessionCallTargets(controls.commands, () => this.publish());
    }
    async init(container: HTMLElement): Promise<void> {this.container = container; await this.render();}
    async render(): Promise<void> {
        await this.store.open(); await this.refreshConfiguration(); await this.targets?.refresh(); this.check(); this.publish();
        this.view = await createChatView(this.container, this.viewOptions());
        const changed = () => {void this.refreshConfiguration().then(() => this.publish()).catch(error => this.report(error));};
        this.offConfiguration = this.controls.configuration?.subscribe(changed) ?? this.service.onChange(changed);
        window.addEventListener('beforeunload', this.beforeUnload);
        if (this.active) this.view.focus(); else this.view.setActive(false); this.emit('ready', undefined);
    }
    private viewOptions(): ChatOptions {
        const store = this.store;
        this.imageHost = store.images.host(() => {
            const preferences = store.preferences(this.view?.getDraft() ?? store.draft);
            return resolveResize(preferences.settings.imageResize, this.executors.find(item => item.id === preferences.agentId)?.imageProcessing?.resize);
        }, resize => {const view = this.view; if (!view) return; const draft = view.getDraft();
            view.configureInput({selection: {...draft.selection, imageResize: JSON.stringify(resize)}}, draft.revision);});
        const images = this.imageHost;
        const ocr = this.controls.ocr ? new SharedChatOcr(this.controls.ocr, () => this.view,
            (ref, signal) => images.read(ref, {signal}), failure => this.report(failure)) : undefined;
        this.ocr = ocr;
        return prepareImageChatOptions({plugins: workspaceInputPlugins(this.controls.commands, {navigation: 'projects', projectId: this.config.sessionDraft?.scope?.id},
            () => this.store.preferences(this.view?.getDraft()).agentId), attachmentActions: item => ocr?.actions(item) ?? [],
            setActive: active => ocr?.setActive(active), release: () => ocr?.destroy(),source: this.source, operations: this.ledger, locale: getLocale(), initialDraft: this.store.draft,
            actions: {send: async () => {throw new Error('Draft must materialize before dispatch');}, prepareSend: (input, draft) => this.prepare(input, draft),
                reconcile: async operationId => ({status: 'unknown', operationId, message: t('chat.submission.unconfirmed')})},
            upload: this.config.sessionDraft?.attachments ? (file, options) => this.store.upload(file, options) : undefined,
            assets: {read: id => this.store.read(id)}, saveDraft: draft => this.save(draft), onDraftChange: () => this.draftChanged(),
            mountHeader: root => this.toolbar(root), onError: error => this.report(error),
            onDiagnostic: event => log.info('chat.draft.operation', event)}, this.imageHost);
    }
    private publish(): void {
        if (this.closed || this.transferred) return;
        this.source.publish({title: t('project.createSession'), messages: [], interactions: [], loading: false, execution: 'idle', connection: 'online', hasEarlier: false,
            allowed: this.config.readOnly || this.config.sessionDraft?.executorScope === 'remote' && !this.executors.length ? [] : ['send'], selectors: this.selectors(), ...(this.targets ? {callTargets: this.targets.getSnapshot()} : {})});
    }
    private selectors(): SelectorView[] {
        const preferences = this.store.preferences(this.view?.getDraft() ?? this.store.draft);
        if (this.config.sessionDraft?.executorScope === 'remote') return this.remoteSelectors(preferences.agentId);
        return [...(!this.targets ? [{id: 'executorId', label: t('chatInput.assistants'), value: preferences.agentId,
            choices: this.executors.map(item => ({id: item.id, label: item.name}))}] : []),
            ...chatSelectors(this.connections, preferences.settings)];
    }

    private remoteSelectors(agentId: string): SelectorView[] {
        const effective = this.executors.some(item => item.id === agentId) ? agentId : this.executors[0]?.id ?? '';
        const catalog = this.nativeModels.get(effective);
        const selectors: SelectorView[] = [{id: 'executorId', label: t('harness.remoteAgents'), value: effective,
            choices: this.executors.map(item => ({id: item.id, label: item.name}))}];
        if (!catalog?.models.length) return selectors;
        const current = catalog.current ?? catalog.default, models = catalog.models;
        selectors.push({id: 'modelId', label: t('chatInput.model'), value: current?.modelId ?? models[0].id,
            choices: [], variants: {selectorId: 'executorId', values: Object.fromEntries([...this.nativeModels].map(([id, value]) => [id,
                {value: value.current?.modelId ?? value.default?.modelId ?? value.models[0]?.id ?? '', choices: value.models.map(model => ({id: model.id, label: model.label}))}]))}});
        selectors.push({id: 'reasoningEffort', label: t('thinking.effort.label'), value: current?.reasoningEffort ?? '', choices: [], variants: {selectorId: 'modelId',
            values: Object.fromEntries(models.map(model => [model.id, {value: current?.modelId === model.id ? current.reasoningEffort ?? model.defaultReasoningEffort ?? '' : model.defaultReasoningEffort ?? '',
                choices: [{id: '', label: t('chatSettings.followDefault')}, ...model.reasoningEfforts]}]))}});
        return selectors;
    }
    private async refreshConfiguration(): Promise<void> {
        const generation = ++this.configurationGeneration;
        const remote = this.config.sessionDraft?.executorScope === 'remote';
        const [executors, connections] = await Promise.all([remote ? this.config.remoteAgents?.list() ?? [] : buildExecutorOptions(this.service),
            remote ? [] : buildConnectionOptions(this.service)]);
        this.check(); if (generation !== this.configurationGeneration) return; if (!this.transferred) {this.executors = executors; this.connections = connections;}
        if (remote && this.config.remoteAgents?.models) {
            const selected = this.view?.getDraft().selection?.executorId ?? this.store.preferences().agentId;
            const executor = executors.find(item => item.id === selected) ?? executors[0];
            if (executor?.supportsModels !== false && executor && !this.nativeModels.has(executor.id)) {
                const catalog = await this.config.remoteAgents.models(executor.id); this.check(); if (generation !== this.configurationGeneration) return; this.nativeModels.set(executor.id, catalog);
            }
        }
        await this.targets?.refresh();
    }
    private draftChanged(): void {
        this.emit('interactiveChange', undefined);
        if (this.config.sessionDraft?.executorScope !== 'remote' || this.transferred) return;
        const selected = this.view?.getDraft().selection?.executorId;
        if (selected && !this.nativeModels.has(selected))
            void this.refreshConfiguration().then(() => this.publish()).catch(error => this.report(error));
    }
    private async save(draft: ComposerDraft): Promise<void> {
        if (this.transferred || this.closed || this.rebuilding) return;
        await this.store.save(draft); this.emit('saved', undefined);
    }
    private async prepare(input: ChatSubmission, draft: ComposerDraft): Promise<SendPreparation | null> {
        this.check(); if (!this.active) throw new Error('Project draft is hidden');
        await this.view.flushDraft();
        const agentId = input.target?.kind === 'agent' ? input.target.id : input.selection?.executorId ?? draft.selection?.executorId ?? this.store.preferences(draft).agentId;
        if (this.config.sessionDraft?.executorScope === 'remote' && !this.executors.some(item => item.id === agentId))
            throw new Error(t('toolbox.unavailable'));
        const target = await this.materialize(agentId); this.check();
        if (target.resumeOnly || await target.editor.commands.prepareChatInput?.(input, draft)) return null;
        const prepared = await target.editor.commands.preparedSubmission?.();
        const submission = target.submission ?? prepared as SessionSubmission | undefined;
        return {operationId: submission?.id ?? randomUUID(), viewId: this.bindingViewId()};
    }
    private bindingViewId(): string {
        const binding = this.delegate?.commands.chatBindingIdentity?.() as {viewId: string} | undefined;
        if (!binding) throw Object.assign(new Error('Formal editor did not adopt the prepared ChatView'), {code: 'HANDOFF_NOT_COMMITTED'});
        return binding.viewId;
    }
    private materialize(agentId?: string): Promise<Materialized> {
        return this.prepared ??= this.bind(agentId).catch(async error => {
            this.prepared = undefined;
            if (!this.closed && !this.transferred) {try {await this.view.replaceBinding(this.viewOptions());}
                catch (cleanup) {throw new AggregateError([error, cleanup], 'Draft handoff and restoration failed');}}
            throw error;
        });
    }
    private async bind(agentId?: string): Promise<Materialized> {
        const handoff: RetainedWorkspaceHandoff = {kind: 'chat-view', view: this.view, read: this.store.read, conversationId: this.source.conversationId, images: this.imageHost};
        const createEditor: EditorFactory = (container, options) => this.factory(container, options, handoff);
        const target = this.resume ? {editor: await this.resume(createEditor), resumeOnly: false}
            : await this.config.sessionDraft!.materialize({container: this.container, agentId, createEditor});
        if (this.closed) {await target.editor.destroy(); throw new Error('Project draft closed during materialization');}
        this.delegate = target.editor; this.transferred = true;
        target.editor.commands.takeViewOwnership?.(); this.owned = false;
        this.offConfiguration?.(); this.offConfiguration = undefined; this.targets?.dispose(); this.scope?.destroy();
        for (const event of ['interactiveChange', 'saved', 'saveError', 'change', 'ready', 'error', 'blocksCollapsed', 'blocksExpanded'] as const)
            this.stops.push(target.editor.on(event, payload => this.emit(event, payload)));
        if (!this.active) target.editor.cancelPendingRender?.();
        log.info('chat.draft.handoff', {operationId: randomUUID(), stage: 'commit', result: 'success', conversationId: handoff.conversationId});
        return target;
    }
    private toolbar(root: HTMLElement) {
        const cleanups: (() => void)[] = [mountChatSettings(root, () => this.view, () => this.store.preferences(this.view?.getDraft()).settings, failure => this.report(failure))];
        if (this.config.mountCompactNavigation) cleanups.push(this.config.mountCompactNavigation(root));
        const scope = this.config.sessionDraft?.scope ? mountDraftProjectScope(root, this.config.sessionDraft.scope,
            () => this.flushPendingSave(), () => {const config = this.store.preferences(this.view?.getDraft() ?? this.store.draft); return {agentId: config.agentId, settings: config.settings};}) : undefined;
        this.scope = scope;
        const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = t('project.draftDiscard');
        if (this.config.hostContext?.navigate) {
            const flows = document.createElement('button'); flows.type = 'button'; flows.dataset.action = 'open-flows'; flows.textContent = t('chatInput.target.flow');
            flows.onclick = () => {void this.openFlows().catch(error => this.report(error));}; root.append(flows); cleanups.push(() => flows.remove());
        }
        discard.onclick = () => {void this.discard().catch(error => this.report(error));}; root.append(discard);
        return {destroy: () => {scope?.destroy(); cleanups.forEach(stop => stop()); discard.remove();}};
    }
    private async openFlows(): Promise<void> {
        if (this.closed || this.transferred || this.view.inputBusy || !this.active) return;
        await this.flushPendingSave(); this.check();
        if (this.active && !this.transferred) await this.config.hostContext?.navigate({target: 'flows'});
    }
    private async discard(): Promise<void> {
        if (this.view.inputBusy || this.transferred) return;
        await this.flushPendingSave(); this.rebuilding = true;
        try {
            await this.config.sessionDraft?.clear?.();
            this.store = new ChatDraftStore({...this.config.sessionDraft!, initialData: undefined}); await this.store.open();
            this.source = new ChatProjection(this.config.sessionDraft?.id ?? randomUUID(), error => this.report(error)); this.publish();
            await this.view.replaceBinding(this.viewOptions(), {draft: this.store.draft});
        } finally {this.rebuilding = false;}
    }
    private async selectAgent(id: string): Promise<void> {
        const revision = this.view.getDraft().revision; await this.refreshConfiguration(); this.check();
        if (this.transferred || this.view.inputBusy) throw new Error(t('chatInput.switchUnavailable'));
        if (!this.executors.some(item => item.id === id)) throw new Error(t('toolbox.unavailable'));
        const target = this.targets?.getSnapshot().entries.find(item => item.target.kind === 'agent' && item.target.id === id)?.target;
        this.view.configureInput({selection: {...this.view.getDraft().selection, executorId: id}, ...(this.targets ? {target} : {})}, revision);
        await this.view.flushDraft();
    }
    private async inherit(preferences: import('@itookit/ui-common').SessionDraftPreferences): Promise<void> {
        if (this.transferred || !this.active || this.view.inputBusy) return;
        const draft = this.view.getDraft(); await this.refreshConfiguration(); this.check();
        if (this.transferred || !this.active || this.view.getDraft().revision !== draft.revision) return;
        const config = inheritDraftPreferences(this.store.preferences(draft), preferences, this.executors, this.connections,
            this.config.sessionDraft?.executorScope === 'remote');
        const target = this.targets?.getSnapshot().entries.find(item => item.target.kind === 'agent' && item.target.id === config.agentId)?.target;
        const values = Object.fromEntries(Object.entries(config.settings).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
        this.view.configureInput({selection: {...draft.selection, ...values, executorId: config.agentId}, ...(this.targets ? {target} : {})}, draft.revision);
        await this.view.flushDraft();
    }
    private async refreshDraft(): Promise<void> {
        if (this.transferred || !this.active || this.view?.inputBusy || this.isDirty()) return;
        const current = this.config.sessionDraft, revision = this.view.getDraft().revision, next = await current?.refresh?.();
        if (!next || this.closed || !this.active || this.transferred || this.view.inputBusy || this.view.getDraft().revision !== revision) return;
        const store = new ChatDraftStore(next); await store.open(); this.check();
        if (this.transferred || this.view.inputBusy || this.view.getDraft().revision !== revision) return;
        this.rebuilding = true;
        try {
            this.config.sessionDraft = next; this.store = store;
            this.source = new ChatProjection(next.id ?? this.source.conversationId, error => this.report(error)); this.publish();
            await this.view.replaceBinding(this.viewOptions(), {draft: store.draft});
        } finally {this.rebuilding = false;}
    }
    private check(): void {this.config.signal?.throwIfAborted(); if (this.closed) throw Object.assign(new Error('Project draft is closed'), {code: 'VIEW_CLOSED'});}
    private report(error: unknown): void {
        log.warn('chat.draft', {operationId: randomUUID(), stage: 'view', result: 'failure', code: safeCode(error)});
        Toast.error(escapeHTML(error instanceof Error ? error.message : String(error))); this.emit('error', error);
    }
    getText(): string {return this.delegate?.getText() ?? this.view?.getDraft().text ?? '';}
    setText(text: string): void {this.view?.setText(text);}
    focus(): void {this.view?.focus();}
    isDirty(): boolean {return this.delegate?.isDirty() ?? (!!this.view && this.store.dirty(this.view.getDraft()));}
    async flushPendingSave(): Promise<void> {if (this.delegate) await this.delegate.flushPendingSave?.(); else await this.view?.flushDraft();}
    cancelPendingRender(): void {this.active = false; this.view?.setActive(false); this.delegate?.cancelPendingRender?.();}
    async activate(): Promise<void> {this.check(); this.active = true; if (this.delegate) await this.delegate.activate?.(); else {await this.refreshDraft(); await this.refreshConfiguration(); await this.scope?.refresh(); this.publish(); this.view?.setActive(true);}}
    captureRecovery(): unknown {this.ocr?.assertRecoverable(); return this.delegate?.captureRecovery?.() ?? this.view?.captureRecovery();}
    restoreRecovery(value: unknown): void {if (this.delegate) this.delegate.restoreRecovery?.(value); else this.view?.restoreRecovery(value as ReturnType<ChatView['captureRecovery']>);}
    suspendForRecovery(): void {if (this.delegate) this.delegate.suspendForRecovery?.(); this.rebuilding = true; this.cancelPendingRender();}
    destroy(): Promise<void> {return this.closing ??= disposeEditorResources([() => this.flushPendingSave(), () => {this.closed = true;},
        () => this.delegate?.destroy(), () => this.owned ? this.view?.destroy() : undefined,
        () => window.removeEventListener('beforeunload', this.beforeUnload),
        () => {this.offConfiguration?.(); this.targets?.dispose(); this.scope?.destroy(); this.stops.forEach(stop => stop()); this.events.clear();}]);}
    get commands() {return {...this.delegate?.commands,
        getInputConfig: () => this.delegate?.commands.getInputConfig?.() ?? this.store.preferences(this.view.getDraft()),
        configureInput: async (config: Partial<import('../../domain/ports/IChatInputPresenter').IChatInputConfig>) => {
            if (config.agentId) await this.selectAgent(config.agentId);
            const current = this.view.getDraft();
            this.view.configureInput({selection: {...current.selection, ...Object.fromEntries(Object.entries(config.settings ?? {}).map(([key, value]) => [key, String(value)]))},
                ...(config.target ? {target: config.target} : {})}, current.revision);
            if (config.text !== undefined) this.view.setText(config.text); await this.view.flushDraft();
        },
        refreshDraft: () => this.refreshDraft(), selectDraftAgent: (id: string) => this.selectAgent(id), inheritDraftPreferences: (preferences: import('@itookit/ui-common').SessionDraftPreferences) => this.inherit(preferences),
        appendDraft: async (input: {text: string; files: File[]}) => {
            this.check(); if (this.transferred || this.view.inputBusy) throw new Error(t('chatInput.switchUnavailable'));
            this.view.setText([this.view.getDraft().text, input.text].filter(Boolean).join('\n')); if (input.files.length) await this.view.addFiles(input.files); await this.view.flushDraft();
        },
        sendMessage: async (message: SendMessageParams) => {
            this.check(); if (!this.active || this.config.readOnly) throw new Error('Project draft input is unavailable');
            try {
                if (message.agentId && !this.transferred) await this.selectAgent(message.agentId);
                if (message.overrides || message.target) {
                    const draft = this.view.getDraft();
                    this.view.configureInput({selection: {...draft.selection, ...Object.fromEntries(Object.entries(message.overrides ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))},
                        ...(message.target ? {target: message.target} : {})}, draft.revision);
                }
                this.view.setText(message.text); if (message.files?.length) await this.view.addFiles(message.files); await this.view.submit();
            } catch (error) {this.report(error); return false; }
        }, confirmDraft: async (resume?: (createEditor?: EditorFactory) => Promise<IEditor>) => {
            this.resume ??= resume; if (!this.delegate) await this.materialize();
        }};}
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {
        const listener = (payload: unknown) => callback(payload as EditorEventMap[E]); const listeners = this.events.get(event) ?? new Set();
        this.events.set(event, listeners); listeners.add(listener); return () => {listeners.delete(listener);};
    }
    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]): void {for (const listener of this.events.get(event) ?? []) listener(payload);}
}

function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'DRAFT_VIEW_FAILED';
}
