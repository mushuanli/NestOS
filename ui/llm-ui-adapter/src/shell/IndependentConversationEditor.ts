import {mountNativeRecovery} from '../independent/native-recovery';
import {mountExecutionDraftAction} from './chat-execution-draft';
import {SharedChatOcr} from './SharedChatOcr';
import {resolveResize} from '@itookit/image-parser';
import {CHAT_SLOT_CLASSES} from '@itookit/llm-ui';
import {presentHostControl} from '../independent/button-presentation';
import {messageMarkdown} from '../independent/message-markdown';
import {ACTION_ICONS, CHAT_ICONS, createModuleLogger, escapeHTML, getLocale, t} from '@itookit/common';
import {BaseSettingsEditor, Toast, type ConversationControls, type EditorOptions, type EditorEvent, type EditorEventCallback, type EditorEventMap} from '@itookit/ui-common';
import type {ChatView, OperationReceipt} from '@itookit/llm-ui';
import {createNativeChatBinding, createNativeChatView} from '../independent/native';
import type {RetainedWorkspaceHandoff} from './drafts/workspace-handoff';
import {adoptNativeChatView} from '../independent/native';
import {disposeEditorResources} from './editor-disposal';
import {NativeChatStore} from '../independent/native-store';
import {mountConversationSource} from './conversation-source';
import {RemoteHistoryBranches} from './remote-history-branches';
import {ConversationInformation} from './ConversationInformation';
import {RemoteBranches} from './remote-branches';

const log = createModuleLogger('native-chat-editor');
type Binding = Awaited<ReturnType<typeof createNativeChatBinding>>;
/** Product shell owns navigation/storage; the shared ChatView owns the conversation DOM. */
export class IndependentConversationEditor extends BaseSettingsEditor<ConversationControls> {
    private view?: ChatView;
    private binding?: Binding;
    private operations;
    private active = true;
    private closed = false;
    private closing?: Promise<void>;
    private owned: boolean;
    private readonly lifetime = new AbortController();
    private offSnapshot?: () => void;
    private ocr?: SharedChatOcr;
    private announced?: string;
    private suspended = false;
    private timer?: ReturnType<typeof setTimeout>;
    private branches?: RemoteBranches;
    private historyBranches?: RemoteHistoryBranches;
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    constructor(container: HTMLElement, controls: ConversationControls, options: EditorOptions, private store: NativeChatStore, private handoff?: RetainedWorkspaceHandoff, private ocrControls?: import('@itookit/ui-common').OcrControls) {
        super(container, controls, options); this.owned = !handoff; this.operations = store.ledger();
    }
    async init(container: HTMLElement): Promise<void> {this.container = container; await this.render();}
    async render(): Promise<void> {
        const sessionId = this.store.identity(this.handoff?.conversationId ?? this.service.snapshot?.()?.sessionId ?? '');
        if (!sessionId) throw new Error('Native ChatView requires a formal conversation identity');
        this.options.signal?.throwIfAborted();
        const owner = this;
        this.historyBranches = new RemoteHistoryBranches(this.container, this.service, this.options, action => this.runBranch(action), error => this.fail(error));
        this.binding = await createNativeChatBinding({conversationId: sessionId, controls: this.service,
            get readOnly() {return !!owner.options.readOnly;}, reservedNativeCommands: ['branch', 'branches'],
            commandProviders: [{source: {id: 'nestos-branches', label: t('harness.branches')},
                commands: state => [{id: 'branch', name: 'branch', description: t('branch.create'), revision: 0, kind: 'action', disabled: !state.canFork},
                    {id: 'branches', name: 'branches', description: t('harness.branches'), revision: 0, kind: 'action'}],
                execute: async (input, context) => {
                    if (this.closed || !this.active || this.options.readOnly || !this.branches) return {status: 'rejected', operationId: context.operationId, code: 'STALE_VIEW', message: t('branch.unavailable')};
                    if (input.target.id === 'branch') await this.branches.createLatest(input.arguments);
                    else if (input.target.id === 'branches' && !input.arguments.trim()) await this.branches.open();
                    else return {status: 'rejected', operationId: context.operationId, code: 'INVALID_BRANCH_COMMAND', message: t('harness.commandUnavailable')};
                    return {status: 'accepted', operationId: context.operationId};
                }}], operations: this.operations,
            readAttachment: this.store.read.bind(this.store), reconcile: id => this.receipt(id), onError: error => this.fail(error)});
        const initial = this.service.snapshot?.(); if (initial) this.historyBranches.update(initial, false);
        const options = this.viewOptions(sessionId);
        if (this.handoff) {
            await this.retainHandoff();
            this.view = await adoptNativeChatView(this.handoff.view, this.binding, {...options, initialDraft: undefined});
        } else this.view = await createNativeChatView(this.container, this.binding, options);
        this.offSnapshot = this.binding.source.subscribe(() => this.announce()); this.announce();
        if (!this.handoff && this.options.initialInputState?.text) this.view.setText(this.options.initialInputState.text);
        this.options.signal?.throwIfAborted(); this.schedule(); this.emit('ready', undefined);
    }
    private async retainHandoff(): Promise<void> {
        const retained = new Set<string>();
        while (true) {
            const draft = this.handoff!.view.getDraft();
            await this.store.retainDraft(draft, this.handoff!.read, this.lifetime.signal, this.handoff!.images);
            draft.attachments.forEach(item => retained.add(item.file.id));
            if (this.handoff!.view.getDraft().attachments.every(item => retained.has(item.file.id))) break;
        }
    }
    private viewOptions(sessionId: string): Parameters<typeof createNativeChatView>[2] {
        const images = this.store.images.host(() => {
            const value = (this.view?.getDraft() ?? this.store.draft).selection?.imageResize;
            return resolveResize(value ? JSON.parse(value) : undefined);
        }, resize => {const view = this.view; if (!view) return; const draft = view.getDraft();
            view.configureInput({selection: {...draft.selection, imageResize: JSON.stringify(resize)}}, draft.revision);});
        const ocr = this.ocr = this.ocrControls ? new SharedChatOcr(this.ocrControls, () => this.view,
            (ref, signal) => images.read(ref, {signal}), failure => this.fail(failure)) : undefined;
        return {promptHistoryPages: 3, images, attachmentActions: item => ocr?.actions(item) ?? [],
            setActive: active => ocr?.setActive(active), release: () => ocr?.destroy(), messageActions: ({message}) => this.historyBranches?.actions(message.id) ?? [], locale: getLocale(), initialDraft: this.store.draft, markdown: messageMarkdown(this.options),
            upload: this.options.readOnly ? undefined : this.store.upload.bind(this.store),
            assets: {read: async id => (await this.store.read({id, name: id}, {signal: this.lifetime.signal})).arrayBuffer()},
            saveDraft: draft => this.suspended || this.options.readOnly ? Promise.resolve() : this.store.saveDraft(draft),
            onDraftChange: () => this.emit('interactiveChange', undefined), onError: error => this.fail(error),
            onDiagnostic: event => log.info('chat.operation', {...event, sessionId}),
            mountHeader: (root, context) => this.toolbar(root, context.headerMenu)};
    }
    private announce(): void {
        const state = this.service.snapshot?.(); if (state) this.historyBranches?.update(state, !this.active);
        const id = this.service.snapshot?.()?.sessionId;
        if (id && id !== this.announced && !this.closed) {this.announced = id; this.options.onConversationSession?.(id);}
    }
    private async runBranch(action: () => Promise<import('@itookit/ui-common').ConversationSnapshot>): Promise<void> {
        if (!this.active || this.closed || this.options.readOnly) throw new Error('Conversation view is unavailable');
        await this.flushPendingSave();
        if (!this.active || this.closed) return;
        const state = await action(); if (state.sessionId && !this.closed) this.options.onConversationSession?.(state.sessionId);
    }
    private toolbar(root: HTMLElement, menuHost?: HTMLElement) {
        const cleanups: (() => void)[] = [];
        let information: ConversationInformation | undefined;
        const recovery = mountNativeRecovery(root, this.operations, () => this.view, () => !this.closed && this.active, id => this.receipt(id), error => this.fail(error));
        cleanups.push(() => recovery.destroy());
        mountConversationSource(root, this.options.conversationSource?.kind ?? 'remote', this.options.conversationSource?.label);
        for (const [mount, className] of [[this.options.mountCompactNavigation, 'llm-chat__compact-navigation']] as const) {
            if (!mount) continue;
            const slot = document.createElement('div'); slot.className = className; if (className) slot.dataset.editorMobileNavigation = 'embedded'; root.append(slot); cleanups.push(mount(slot), () => slot.remove());
        }
        information = this.mountMenu(root, cleanups, menuHost);
        if (this.options.hostContext?.toggleSidebar) {
            const button = document.createElement('button'); button.type = 'button';
            presentHostControl(button, t('chat.toolbar.sidebar'), ACTION_ICONS.sidebar);
            button.classList.add('llm-chat__sidebar'); button.onclick = () => this.options.hostContext!.toggleSidebar();
            root.append(button); cleanups.push(() => button.remove());
        }
        this.branches = new RemoteBranches(this.service, this.options, async action => {
            if (!this.active || this.closed || this.options.readOnly) throw new Error('Conversation view is unavailable');
            await this.flushPendingSave();
            if (!this.active || this.closed) return;
            const state = await action();
            if (state.sessionId && !this.closed) this.options.onConversationSession?.(state.sessionId);
        }, error => this.fail(error));
        this.branches.element.classList.add('llm-chat__branch'); this.branches.element.dataset.chatOverflow = ''; root.append(this.branches.element);
        const update = () => {recovery.update(); const state = this.service.snapshot?.(); if (state) {this.branches?.update(state, !this.active); information?.setSnapshot(state); this.historyBranches?.update(state, !this.active);}};
        update();
        return {update, destroy: () => {this.branches?.destroy(); cleanups.forEach(cleanup => cleanup());}};
    }
    private mountMenu(root: HTMLElement, cleanups: (() => void)[], menuHost?: HTMLElement): ConversationInformation {
        const menu = menuHost?.parentElement as HTMLDetailsElement ?? document.createElement('details'), body = menuHost ?? document.createElement('div');
        const information = new ConversationInformation(body); cleanups.push(() => information?.destroy());
        if (!menuHost) {const summary = document.createElement('summary'); menu.className = CHAT_SLOT_CLASSES.menu;
            presentHostControl(summary, t('chat.toolbar.more'), CHAT_ICONS.more); menu.append(summary, body); root.append(menu);}
        cleanups.push(mountExecutionDraftAction(body, this.options, () => this.view, draft => Promise.all(draft.attachments.map(async item => {
            const blob = await this.store.read(item.file, {signal: this.lifetime.signal}); return new File([blob], item.file.name, {type: item.file.mimeType});})),
            () => !this.closed && this.active && !this.options.readOnly, error => this.fail(error)));
        for (const mount of [this.options.mountWindowList, this.options.mountConversationNavigation, this.options.mountMoreMenu]) {
            if (mount) cleanups.push(mount(body));
        }
        if (!menuHost) cleanups.push(() => menu.remove());
        return information;
    }
    private async receipt(operationId: string): Promise<OperationReceipt> {
        const state = await this.service.reconcile(operationId);
        const record = this.operations.getSnapshot().find(item => item.context.operationId === operationId);
        if (record?.status === 'accepted') return {status: 'accepted', operationId, submissionRef: record.submissionRef};
        if (state.submission?.id === operationId) {
            if (state.submission.status === 'accepted') return {status: 'accepted', operationId, submissionRef: state.submission.turnId};
            if (state.submission.status === 'rejected') return {status: 'rejected', operationId, code: state.submission.code ?? 'NATIVE_REJECTED', message: t('chat.submission.unconfirmed')};
        }
        if (state.instructionQueue?.acceptedIds.includes(operationId)) return {status: 'accepted', operationId};
        return {status: 'unknown', operationId, message: t('chat.submission.unconfirmed')};
    }
    private schedule(): void {
        clearTimeout(this.timer);
        if (this.closed || !this.active || this.service.subscribe) return;
        this.timer = setTimeout(() => {void this.binding?.source.refresh().catch(error => this.fail(error)).finally(() => this.schedule());}, 1500);
    }
    private fail(error: unknown): void {
        if (this.closed) return;
        const code = (error as {code?: string})?.code;
        log.warn('chat.editor', {stage: 'view', result: 'failure', code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CHAT_VIEW_FAILED'});
        Toast.error(escapeHTML(error instanceof Error ? error.message : String(error))); this.emit('error', error);
    }
    async collapseBlocks() {this.view?.setAllCollapsed(true); const result = this.view?.disclosureState() ?? {affectedCount: 0, allCollapsed: true}; this.emit('blocksCollapsed', result); return result;}
    async expandBlocks() {this.view?.setAllCollapsed(false); const result = this.view?.disclosureState() ?? {affectedCount: 0, allCollapsed: false}; this.emit('blocksExpanded', result); return result;}
    async toggleBlocks() {return this.view?.disclosureState().allCollapsed ? this.expandBlocks() : this.collapseBlocks();}
    async navigateTo(target: {elementId: string}) {this.view?.revealMessage(target.elementId);}
    async getSearchableText(): Promise<string> {return this.getText();}
    getText(): string {return this.service.snapshot?.()?.messages.map(message => message.text).join('\n\n') ?? '';}
    setText(text: string): void {this.view?.setText(text);}
    focus(): void {this.view?.focus();}
    isDirty(): boolean {return !!this.view && this.store.dirty(this.view.getDraft());}
    async flushPendingSave(): Promise<void> {if (!this.suspended) {await this.view?.flushDraft(); this.emit('saved', undefined);}}
    cancelPendingRender(): void {this.active = false; clearTimeout(this.timer); this.view?.setActive(false); this.historyBranches?.setActive(false);}
    async activate(): Promise<void> {if (this.closed) return; this.active = true; this.historyBranches?.setActive(true); this.view?.setActive(true); await this.binding?.source.refresh(); this.schedule();}
    setReadOnly(value: boolean): void {this.options.readOnly = value; void this.binding?.source.refresh().catch(error => this.fail(error));}
    suspendForRecovery(): void {this.suspended = true; this.store.suspend(); this.cancelPendingRender();}
    captureRecovery(): unknown {this.ocr?.assertRecoverable(); return this.view?.captureRecovery();}
    restoreRecovery(value: unknown): void {this.view?.restoreRecovery(value as ReturnType<ChatView['captureRecovery']>);}
    destroy(): Promise<void> {
        return this.closing ??= disposeEditorResources([() => this.flushPendingSave(),
            () => {this.closed = true; this.lifetime.abort(); clearTimeout(this.timer); this.offSnapshot?.();},
            () => this.owned ? this.view?.destroy() : undefined,
            () => this.historyBranches?.destroy(), () => this.binding?.dispose(), () => this.service.close(), () => this.events.clear()]);
    }
    get commands() {return {chatBindingIdentity: () => this.binding?.source.getSnapshot(),
        takeViewOwnership: () => {this.owned = true; this.handoff = undefined;}, sendMessage: async (message: {text: string; files?: File[]}) => {
        if (this.closed || !this.active || this.options.readOnly) throw new Error('Conversation input is unavailable');
        this.view!.setText(message.text); if (message.files?.length) await this.view!.addFiles(message.files); await this.view!.submit();
    }};}
    private emit<E extends EditorEvent>(event: E, payload: EditorEventMap[E]): void {for (const callback of this.events.get(event) ?? []) callback(payload);}
    on<E extends EditorEvent>(event: E, callback: EditorEventCallback<E>): () => void {
        const listener = (payload: unknown) => callback(payload as EditorEventMap[E]);
        const listeners = this.events.get(event) ?? new Set(); this.events.set(event, listeners); listeners.add(listener);
        return () => {listeners.delete(listener);};
    }
}
