import {createModuleLogger, escapeHTML, getLocale, t} from '@itookit/common';
import {BaseSettingsEditor, Toast, type ConversationControls, type EditorOptions, type EditorEvent, type EditorEventCallback, type EditorEventMap} from '@itookit/ui-common';
import type {ChatView, OperationReceipt} from '@itookit/llm-ui';
import {createNativeChatBinding, createNativeChatView} from '../independent/native';
import {NativeChatStore} from '../independent/native-store';
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
    private suspended = false;
    private timer?: ReturnType<typeof setTimeout>;
    private branches?: RemoteBranches;
    private readonly events = new Map<EditorEvent, Set<(payload: unknown) => void>>();
    constructor(container: HTMLElement, controls: ConversationControls, options: EditorOptions, private store: NativeChatStore) {
        super(container, controls, options); this.operations = store.ledger();
    }
    async init(container: HTMLElement): Promise<void> {this.container = container; await this.render();}
    async render(): Promise<void> {
        const sessionId = this.service.snapshot?.()?.sessionId;
        if (!sessionId) throw new Error('Native ChatView requires a formal conversation identity');
        this.options.signal?.throwIfAborted();
        const owner = this;
        this.binding = await createNativeChatBinding({conversationId: sessionId, controls: this.service,
            get readOnly() {return !!owner.options.readOnly;}, operations: this.operations,
            readAttachment: this.store.read.bind(this.store), reconcile: id => this.receipt(id), onError: error => this.fail(error)});
        this.view = await createNativeChatView(this.container, this.binding, {locale: getLocale(), initialDraft: this.store.draft,
            upload: this.options.readOnly ? undefined : this.store.upload.bind(this.store),
            assets: {read: async id => (await this.store.read({id, name: id}, {signal: new AbortController().signal})).arrayBuffer()},
            saveDraft: draft => this.suspended ? Promise.resolve() : this.store.saveDraft(draft),
            onDraftChange: () => this.emit('interactiveChange', undefined), onError: error => this.fail(error),
            onDiagnostic: event => log.info('chat.operation', {...event, sessionId}),
            mountToolbar: root => this.toolbar(root)});
        if (this.options.initialInputState?.text) this.view.setText(this.options.initialInputState.text);
        this.options.signal?.throwIfAborted(); this.schedule(); this.emit('ready', undefined);
    }
    private toolbar(root: HTMLElement) {
        const cleanups: (() => void)[] = [];
        for (const mount of [this.options.mountCompactNavigation, this.options.mountWindowList, this.options.mountConversationNavigation]) {
            if (!mount) continue;
            const slot = document.createElement('div'); root.append(slot); cleanups.push(mount(slot), () => slot.remove());
        }
        if (this.options.mountMoreMenu) {
            const menu = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('div');
            summary.textContent = t('chat.toolbar.more'); menu.append(summary, body); root.append(menu);
            cleanups.push(this.options.mountMoreMenu(body), () => menu.remove());
        }
        this.branches = new RemoteBranches(this.service, this.options, async action => {
            if (!this.active || this.closed || this.options.readOnly) throw new Error('Conversation view is unavailable');
            await this.flushPendingSave();
            if (!this.active || this.closed) return;
            const state = await action();
            if (state.sessionId && !this.closed) this.options.onConversationSession?.(state.sessionId);
        }, error => this.fail(error));
        root.append(this.branches.element);
        const update = () => {const state = this.service.snapshot?.(); if (state) this.branches?.update(state, !this.active);};
        update();
        return {update, destroy: () => {this.branches?.destroy(); cleanups.forEach(cleanup => cleanup());}};
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
    getText(): string {return this.service.snapshot?.()?.messages.map(message => message.text).join('\n\n') ?? '';}
    setText(text: string): void {this.view?.setText(text);}
    focus(): void {this.view?.focus();}
    isDirty(): boolean {return !!this.view && this.store.dirty(this.view.getDraft());}
    async flushPendingSave(): Promise<void> {if (!this.suspended) {await this.view?.flushDraft(); this.emit('saved', undefined);}}
    cancelPendingRender(): void {this.active = false; clearTimeout(this.timer); this.view?.setActive(false);}
    async activate(): Promise<void> {if (this.closed) return; this.active = true; this.view?.setActive(true); await this.binding?.source.refresh(); this.schedule();}
    setReadOnly(value: boolean): void {this.options.readOnly = value; void this.binding?.source.refresh().catch(error => this.fail(error));}
    suspendForRecovery(): void {this.suspended = true; this.store.suspend(); this.cancelPendingRender();}
    captureRecovery(): unknown {return this.view?.getDraft();}
    restoreRecovery(state: unknown): void {
        // Attachment identities already live in the host store; do not silently drop unsaved values.
        if (JSON.stringify(state) !== JSON.stringify(this.view?.getDraft()))
            throw Object.assign(new Error('Unsaved chat draft requires the original view to recover'), {code: 'RECOVERY_BUSY'});
    }
    async destroy(): Promise<void> {
        if (this.closed) return;
        await this.flushPendingSave(); this.closed = true; clearTimeout(this.timer);
        try {await this.view?.destroy();} finally {this.binding?.dispose(); await this.service.close();}
        this.events.clear();
    }
    get commands() {return {sendMessage: async (message: {text: string; files?: File[]}) => {
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
